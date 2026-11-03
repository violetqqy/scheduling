import type { Cell, Database, VacationPlan } from './types'
import { uid, validDate } from './dates'
import { activeOn, editableVersion, key, openOn } from './model'

export const vacationOn = (db: Database, employeeId: string, date: string) => db.vacationPlans.find(p => p.employeeId === employeeId && p.month === date.slice(0,7) && p.dates.includes(date))
export function availableCell(db: Database, employeeId: string, date: string): Cell {
  const plan = vacationOn(db,employeeId,date)
  if (plan) return {kind:'vacation',locked:true,source:'plan',planId:plan.id,note:plan.reason}
  return openOn(db,date) ? {kind:'unassigned',locked:false,source:'manual'} : {kind:'rest',locked:true,source:'calendar'}
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
  }
  for (const date of dates) if (v.cells[key(plan.employeeId,date)]?.kind !== 'leave') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
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
  for (const date of plan.dates) if (v.cells[key(plan.employeeId,date)]?.kind === 'vacation') v.cells[key(plan.employeeId,date)] = availableCell(db,plan.employeeId,date)
}
export function adjustCell(db: Database, employeeId: string, date: string, cell: Cell) {
  const employee = db.employees.find(e => e.id === employeeId)
  if (!employee || !activeOn(employee,date)) throw new Error(`${date}不在员工任职有效期内，请调整范围`)
  const v = editableVersion(db,date.slice(0,7)), existing = v.cells[key(employeeId,date)]
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
