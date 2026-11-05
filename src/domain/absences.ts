import type { Cell, Database, OvertimeBase, VacationPlan, Version } from './types'
import { uid, validDate } from './dates'
import { activeOn, activeVersion, editableVersion, key, openOn, recordSegmentBaseline } from './model'
import { recordVacationImpact } from './vacation-deferrals'
import { recordManualSegment } from './manual-segments'

export const vacationOn = (db: Database, employeeId: string, date: string) => db.vacationPlans.find(p => p.employeeId === employeeId && p.month === date.slice(0,7) && p.dates.includes(date))
export function availableCell(db: Database, employeeId: string, date: string): Cell {
  const plan = vacationOn(db,employeeId,date)
  if (plan) return {kind:'vacation',locked:true,source:'plan',planId:plan.id,note:plan.reason}
  return openOn(db,date) ? {kind:'unassigned',locked:false,source:'manual'} : {kind:'rest',locked:true,source:'calendar'}
}
export function validOvertimeBase(value: unknown): value is OvertimeBase {
  if (!value || typeof value !== 'object') return false
  const c=value as OvertimeBase
  return ['rest','vacation','unassigned','leave','shift','custom'].includes(c.kind) && (c.kind!=='shift' || typeof c.shiftId==='string') && (c.kind!=='custom' || typeof c.customName==='string' && !!c.customName.trim() && c.customName.trim().length<=30) && typeof c.locked==='boolean' && ['auto','manual','import','calendar','plan'].includes(c.source) && (c.note===undefined || typeof c.note==='string') && (c.planId===undefined || typeof c.planId==='string')
}
export function makeOvertimeCell(db: Database, employeeId: string, date: string, input: Cell, version?: Version): Cell {
  const existing=version?.cells[key(employeeId,date)], plan=vacationOn(db,employeeId,date)
  const base=plan ? availableCell(db,employeeId,date) : input.overtimeBase || (existing?.kind==='overtime' ? existing.overtimeBase : existing || availableCell(db,employeeId,date))
  if (!validOvertimeBase(base)) throw new Error('加班原状态无效，请重新选择')
  checkCell(db,base)
  return {kind:'overtime',locked:true,source:input.source,note:input.note,overtimeBase:structuredClone(base)}
}
export function overtimeRestoreCell(db: Database, employeeId: string, date: string, cell: Cell): Cell {
  const base=cell.overtimeBase
  if (vacationOn(db,employeeId,date) || !base || base.kind==='vacation' || base.source==='calendar' || base.kind==='unassigned') return availableCell(db,employeeId,date)
  return structuredClone(base)
}
export function cancelOvertime(db: Database, employeeId: string, date: string) {
  const source=activeVersion(db,date.slice(0,7)), cell=source?.cells[key(employeeId,date)]
  if (cell?.kind!=='overtime') throw new Error('该日期没有加班安排')
  const v=editableVersion(db,date.slice(0,7));v.cells[key(employeeId,date)]=overtimeRestoreCell(db,employeeId,date,cell)
}
// Plans are separate records; active versions receive snapshots. Historical versions stay intact.
export function saveVacationPlan(db: Database, input: Pick<VacationPlan,'employeeId'|'month'|'dates'|'reason'> & {id?: string; source?: 'manual'|'import'}) {
  const employee = db.employees.find(e => e.id === input.employeeId)
  const dates = [...new Set(input.dates)].sort()
  if (!employee || !dates.length || dates.some(d => !validDate(d) || d.slice(0,7) !== input.month || !activeOn(employee,d))) throw new Error('请选择当月任职有效期内的休假日期，至少一天')
  if (db.vacationPlans.some(p => p.id !== input.id && p.employeeId === input.employeeId && p.dates.some(d => dates.includes(d)))) throw new Error('所选日期已有预定休假，请编辑已有计划')
  const old = input.id ? db.vacationPlans.find(p => p.id === input.id) : undefined
  if (input.id && !old) throw new Error('休假计划已不存在，请刷新列表')
  if (old && (old.employeeId !== input.employeeId || old.month !== input.month)) throw new Error('编辑计划时不能改变员工和月份')
  const now = new Date().toISOString()
  const plan: VacationPlan = {id:old?.id || uid(),employeeId:input.employeeId,month:input.month,dates,reason:input.reason,source:input.source || old?.source || 'manual',created:old?.created || now,updated:now}
  const v = editableVersion(db,input.month)
  v.ruleSettings.earlyLateCarry=true;v.ruleSettings.singleDayCredit=true
  db.vacationPlans = db.vacationPlans.filter(p => p.id !== plan.id); db.vacationPlans.push(plan)
  for (const date of old?.dates || []) if (!dates.includes(date)) {
    const cell = v.cells[key(plan.employeeId,date)]
    if (cell?.kind === 'vacation' && cell.source==='plan') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
    else if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
  }
  for (const date of dates) {
    const cell=v.cells[key(plan.employeeId,date)]
    if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
    else if (!cell || cell.source!=='manual' && cell.kind!=='custom' && cell.kind!=='leave' && !(cell.kind==='shift' && cell.locked)) {
      const next=availableCell(db,plan.employeeId,date)
      recordVacationImpact(db,v,plan.employeeId,date,next)
      v.cells[key(plan.employeeId,date)] = next
    }
  }
  v.vacationPlans = structuredClone(db.vacationPlans.filter(p => p.month === plan.month))
  return plan
}
export function removeVacationPlan(db: Database, id: string, onlyDate?: string) {
  const plan = db.vacationPlans.find(p => p.id === id)
  if (!plan) throw new Error('休假计划已不存在')
  if (onlyDate && plan.dates.length > 1) return saveVacationPlan(db,{...plan,dates:plan.dates.filter(d => d !== onlyDate)})
  const v = editableVersion(db,plan.month)
  db.vacationPlans = db.vacationPlans.filter(p => p.id !== id)
  v.vacationPlans = structuredClone(db.vacationPlans.filter(p => p.month === plan.month))
  for (const date of plan.dates) {
    const cell=v.cells[key(plan.employeeId,date)]
    if (cell?.kind==='vacation' && cell.source==='plan') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
    else if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
  }
}
export function checkCell(db:Database, cell:Cell) {
  if (!['shift','custom','overtime','rest','vacation','leave','unassigned'].includes(cell.kind) || cell.kind==='shift' && !db.shifts.some(s=>s.id===cell.shiftId)) throw new Error('请选择有效的班次或状态')
  if(cell.kind==='custom' && (typeof cell.customName!=='string' || !cell.customName.trim() || cell.customName.trim().length>30))throw new Error('请填写1至30字的自定义班次名称')
}
export function adjustCell(db: Database, employeeId: string, date: string, cell: Cell, _context: 'schedule'|'calendar' = 'schedule') {
  const employee = db.employees.find(e => e.id === employeeId)
  if (!employee || !validDate(date)) throw new Error('请选择有效员工和日期')
  checkCell(db,cell)
  const source=activeVersion(db,date.slice(0,7))
  const next=cell.kind==='overtime'?makeOvertimeCell(db,employeeId,date,cell,source):structuredClone(cell)
  if(next.kind==='custom'){next.customName=next.customName!.trim();next.locked=true}
  if(next.kind!=='shift')delete next.shiftId
  if(next.kind!=='custom')delete next.customName
  const v = editableVersion(db,date.slice(0,7))
  if(!v.employeeIds.includes(employeeId))v.employeeIds.push(employeeId)
  if(next.source==='manual'){
    v.ruleSettings.earlyLateCarry=true;v.ruleSettings.singleDayCredit=true
    recordSegmentBaseline(db,v,employeeId,date)
  }
  recordVacationImpact(db,v,employeeId,date,next)
  v.cells[key(employeeId,date)]=next
  if(next.source==='manual')recordManualSegment(db,v,employeeId,date)
}
export function cancelLeave(db: Database, employeeId: string, date: string) {
  const v = editableVersion(db,date.slice(0,7))
  if (v.cells[key(employeeId,date)]?.kind !== 'leave') throw new Error('该日期已无事后请假')
  v.cells[key(employeeId,date)] = availableCell(db,employeeId,date)
}
