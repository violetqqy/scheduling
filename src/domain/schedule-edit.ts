import type { Cell, Database, Version } from './types'
import { daysInMonth, uid, validDate } from './dates'
import { activeOn, activeVersion, effectiveCell, key } from './model'
import { adjustCell, overtimeRestoreCell, vacationOn } from './absences'

export interface CellTarget { employeeId: string; date: string }
export type SelectionAction = { type: 'adjust'; cell: Cell } | { type: 'lock'; locked: boolean }

export function protectedScheduleCell(db: Database, target: CellTarget, cell?: Cell) {
  return cell?.kind === 'rest' || cell?.kind === 'vacation' || cell?.kind === 'leave' || cell?.kind==='overtime' || !!vacationOn(db,target.employeeId,target.date)
}
function checkedVersion(db: Database, month: string, expectedId: string) {
  const version = activeVersion(db,month)
  if (!version || version.id !== expectedId) throw new Error('当前月份或排班版本已变化，请重新选择后操作')
  return version
}
export function selectionCells(db: Database, version: Version, targets: CellTarget[]) {
  const unique = [...new Map(targets.map(t => [key(t.employeeId,t.date),t])).values()]
  if (!unique.length) throw new Error('请先选择排班单元格')
  return unique.map(target => {
    const employee = db.employees.find(e => e.id === target.employeeId)
    if (!validDate(target.date) || target.date.slice(0,7) !== version.month || !employee || !version.employeeIds.includes(employee.id) || !activeOn(employee,target.date)) throw new Error('选择范围包含非当月或不在任职期内的单元格，请重新选择')
    const cell = effectiveCell(db,version,employee,target.date)
    return {target,cell,protected:protectedScheduleCell(db,target,cell)}
  })
}
export function selectableScheduleTargets(db: Database, version: Version, targets: CellTarget[]) {
  if (!targets.length) return []
  return selectionCells(db,version,targets).filter(row=>!row.protected).map(row=>row.target)
}

export function applyScheduleSelection(db: Database, month: string, expectedId: string, targets: CellTarget[], action: SelectionAction) {
  const version = checkedVersion(db,month,expectedId), selected = selectionCells(db,version,targets)
  if (action.type === 'adjust') {
    const cell = action.cell
    if (!['shift','overtime','unassigned','rest','leave'].includes(cell.kind) || cell.kind === 'shift' && !db.shifts.some(s => s.id === cell.shiftId && s.enabled)) throw new Error('请选择有效的班次或状态；预定休假需在工作日历中调整')
  }
  const eligible = selected.filter(r => !r.protected && (action.type === 'adjust' || r.cell?.kind === 'shift' && r.cell.locked !== action.locked))
  if (!eligible.length) throw new Error(action.type === 'lock' ? '没有需要更改锁定状态的班次；休息、休假和请假始终受保护' : '所选单元格均受保护，请在工作日历或单格编辑中调整')
  for (const {target,cell} of eligible) {
    const next: Cell = action.type === 'lock'
      ? {...cell!,locked:action.locked,source:'manual'}
      : {...action.cell,source:'manual',shiftId:action.cell.kind === 'shift' ? action.cell.shiftId : undefined,locked:action.cell.kind === 'shift' ? action.cell.locked : action.cell.kind !== 'unassigned'}
    adjustCell(db,target.employeeId,target.date,next)
  }
  return {changed:eligible.length,protected:selected.filter(r=>r.protected).length,skipped:selected.length-eligible.length}
}

// Clearing always creates a child draft, including when the original was a draft.
export function clearMonthSchedule(db: Database, month: string, expectedId: string) {
  const source = checkedVersion(db,month,expectedId)
  const dates = new Set(daysInMonth(month))
  const assignments = Object.entries(source.cells).filter(([k,c]) => (c.kind === 'shift' || c.kind==='overtime') && dates.has(k.split('|')[1]!))
  if (!assignments.length) throw new Error('本月没有可清空的班次')
  const now = new Date().toISOString()
  const version: Version = {...structuredClone(source),id:uid(),parentId:source.id,name:'清空排班',status:'draft',created:now,updated:now}
  delete version.run
  for (const [k,cell] of assignments) {
    if (cell.kind==='overtime') {const [id,date]=k.split('|') as [string,string];version.cells[k]=overtimeRestoreCell(db,id,date,cell)}
    else delete version.cells[k]
  }
  db.versions.push(version); db.activeVersions[month] = version.id
  return {version,cleared:assignments.length}
}
