import type { Cell, Database, OvertimeBase, VacationPlan, Version } from './types'
import { uid, validDate } from './dates'
import { activeOn, activeVersion, editableVersion, effectiveCell, key, openOn } from './model'

export const vacationOn = (db: Database, employeeId: string, date: string) => db.vacationPlans.find(p => p.employeeId === employeeId && p.month === date.slice(0,7) && p.dates.includes(date))
export function availableCell(db: Database, employeeId: string, date: string): Cell {
  const plan = vacationOn(db,employeeId,date)
  if (plan) return {kind:'vacation',locked:true,source:'plan',planId:plan.id,note:plan.reason}
  return openOn(db,date) ? {kind:'unassigned',locked:false,source:'manual'} : {kind:'rest',locked:true,source:'calendar'}
}
export function validOvertimeBase(value: unknown): value is OvertimeBase {
  if (!value || typeof value !== 'object') return false
  const c=value as OvertimeBase
  return ['rest','vacation','unassigned'].includes(c.kind) && typeof c.locked==='boolean' && ['auto','manual','import','calendar','plan'].includes(c.source) && (c.note===undefined || typeof c.note==='string') && (c.planId===undefined || typeof c.planId==='string')
}
export function makeOvertimeCell(db: Database, employeeId: string, date: string, input: Cell, version?: Version): Cell {
  const existing=version?.cells[key(employeeId,date)], plan=vacationOn(db,employeeId,date)
  if (existing?.kind==='leave') throw new Error(`${date}已有事后请假，请先在工作日历中撤销请假`)
  const base=plan ? availableCell(db,employeeId,date) : input.overtimeBase || (existing?.kind==='overtime' ? existing.overtimeBase : existing?.kind==='rest' || existing?.kind==='vacation' ? existing : availableCell(db,employeeId,date))
  if (!validOvertimeBase(base)) throw new Error('加班原状态无效，请重新选择')
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
  db.vacationPlans = db.vacationPlans.filter(p => p.id !== plan.id); db.vacationPlans.push(plan)
  for (const date of old?.dates || []) if (!dates.includes(date)) {
    const cell = v.cells[key(plan.employeeId,date)]
    if (cell?.kind === 'vacation') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
    else if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
  }
  for (const date of dates) {
    const cell=v.cells[key(plan.employeeId,date)]
    if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
    else if (cell?.kind !== 'leave') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
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
    if (cell?.kind==='vacation') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
    else if (cell?.kind==='overtime') cell.overtimeBase=availableCell(db,plan.employeeId,date) as OvertimeBase
  }
}
export function adjustCell(db: Database, employeeId: string, date: string, cell: Cell, context: 'schedule'|'calendar' = 'schedule') {
  const employee = db.employees.find(e => e.id === employeeId)
  if (!employee || !activeOn(employee,date)) throw new Error(`${date}不在员工任职有效期内，请调整范围`)
  const source=activeVersion(db,date.slice(0,7)), existing=source ? effectiveCell(db,source,employee,date) : availableCell(db,employeeId,date)
  if (cell.kind==='overtime') {const overtime=makeOvertimeCell(db,employeeId,date,cell,source);const v=editableVersion(db,date.slice(0,7));v.cells[key(employeeId,date)]=overtime;return}
  if (context==='schedule' && (cell.kind==='shift' || cell.kind==='unassigned') && (existing?.kind==='rest' || existing?.kind==='vacation' || existing?.kind==='overtime' && ['rest','vacation'].includes(existing.overtimeBase?.kind || '') || !!vacationOn(db,employeeId,date)) && !(existing?.kind==='leave' && cell.kind==='unassigned')) throw new Error(`${date}为休息或预定休假，不能直接排班或恢复可用；请先在工作日历中调整休假计划或休息安排，也可登记加班`)
  const v = editableVersion(db,date.slice(0,7))
  if (vacationOn(db,employeeId,date) && cell.kind !== 'leave') {
    if (existing?.kind === 'leave' && cell.kind === 'unassigned') { v.cells[key(employeeId,date)] = availableCell(db,employeeId,date); return }
    throw new Error(`${date}已有预定休假，请先在工作日历中调整休假计划`)
  }
  v.cells[key(employeeId,date)] = structuredClone(cell)
}
export function cancelLeave(db: Database, employeeId: string, date: string) {
  const v = editableVersion(db,date.slice(0,7))
  if (v.cells[key(employeeId,date)]?.kind !== 'leave') throw new Error('该日期已无事后请假')
  v.cells[key(employeeId,date)] = availableCell(db,employeeId,date)
}
