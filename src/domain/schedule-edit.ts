import type { Cell, Database, Version } from './types'
import { daysInMonth, uid, validDate } from './dates'
import { activeVersion, effectiveCell, key } from './model'
import { adjustCell, checkCell, overtimeRestoreCell } from './absences'

export interface CellTarget { employeeId: string; date: string }
export type SelectionAction = { type: 'adjust'; cell: Cell } | { type: 'lock'; locked: boolean }

export function protectedScheduleCell(_db:Database,_target:CellTarget,_cell?:Cell) {return false}
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
    if (!validDate(target.date) || target.date.slice(0,7) !== version.month || !employee) throw new Error('选择范围包含非当月日期或未知员工，请重新选择')
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
  if (action.type === 'adjust') checkCell(db,action.cell)
  const eligible = selected.filter(r => !r.protected && (action.type === 'adjust' || r.cell?.kind === 'shift' && r.cell.locked !== action.locked))
  if (!eligible.length) throw new Error(action.type === 'lock' ? '没有需要更改锁定状态的普通班次' : '没有可调整的单元格')
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
  const assignments = Object.entries(source.cells).filter(([k,c]) => (c.kind === 'shift' || c.kind==='overtime' || c.kind==='custom') && dates.has(k.split('|')[1]!))
  if (!assignments.length) throw new Error('本月没有可清空的班次')
  const now = new Date().toISOString()
  const version: Version = {...structuredClone(source),id:uid(),parentId:source.id,name:'清空排班',status:'draft',created:now,updated:now}
  delete version.run
  delete version.vacationImpacts
  delete version.manualMixedSegments
  delete version.segmentBaselines
  for (const [k,cell] of assignments) {
    if (cell.kind==='overtime') {const [id,date]=k.split('|') as [string,string],base=overtimeRestoreCell(db,id,date,cell);if(base.kind==='shift' || base.kind==='custom')delete version.cells[k];else version.cells[k]=base}
    else delete version.cells[k]
  }
  db.versions.push(version); db.activeVersions[month] = version.id
  return {version,cleared:assignments.length}
}
