import type { Cell, Database, Employee, RuleSettings, Segment, Version } from './types'
import { addDays, addMonths, daysInMonth, isWeekend, uid } from './dates'

export const isAbsence = (cell?: Cell) => cell?.kind === 'vacation' || cell?.kind === 'leave'
export const key = (employeeId: string, date: string) => `${employeeId}|${date}`
export const activeOn = (employee: Employee, date: string) => (!employee.from || employee.from <= date) && (!employee.to || date < employee.to)
export const orderedEmployees = (db: Database) => [...db.employees].sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
export const activeVersion = (db: Database, month: string) => db.versions.find(v => v.id === db.activeVersions[month])
export const sourceVersion = (db: Database, version: Version) => version.historyMode === 'initial' ? undefined : db.versions.find(v => v.id === version.sourceVersionId) || activeVersion(db,addMonths(version.month,-1))
export const openOn = (db: Database, date: string, version?: Version) => version?.calendar[date] ?? db.calendar[date] ?? !isWeekend(date)
export const required = (db: Database, date: string, shiftId: string, version?: Version) => version?.requirements[`${date}|${shiftId}`] ?? (openOn(db, date, version) && db.shifts.find(s => s.id === shiftId)?.enabled && db.demand[`${date}|${shiftId}`] !== false ? 2 : 0)
export function effectiveCell(db: Database, version: Version, employee: Employee, date: string): Cell | undefined {
  if (!activeOn(employee, date)) return undefined
  return version.cells[key(employee.id, date)] || (!openOn(db, date, version) ? { kind: 'rest', locked: true, source: 'calendar' } : undefined)
}
function versionOnDate(db: Database, version: Version, date: string): Version | undefined {
  if (date.startsWith(version.month)) return version
  if (date.slice(0,7) === addMonths(version.month,-1)) return sourceVersion(db,version)
  const owner = activeVersion(db,date.slice(0,7))
  if (date.slice(0,7) === addMonths(version.month,1) && owner?.sourceVersionId && owner.sourceVersionId !== version.id) return undefined
  return owner
}
export function getRawCell(db: Database, version: Version, employeeId: string, date: string) {
  return versionOnDate(db,version,date)?.cells[key(employeeId, date)]
}
function rests(db: Database, version: Version, employee: Employee, date: string, rules: RuleSettings) {
  if (!activeOn(employee, date)) return true
  const cell = getRawCell(db, version, employee.id, date), owner = versionOnDate(db,version,date)
  if (isAbsence(cell)) return rules.leaveSplits || !openOn(db,date,owner)
  if (cell) return cell.kind === 'rest'
  return !openOn(db, date, owner)
}
export function workSegments(db: Database, version: Version, employee: Employee): Segment[] {
  const monthDays = daysInMonth(version.month); if (!monthDays.length) return []
  let from = monthDays[0]!, to = monthDays.at(-1)!, bounded = true
  let n = 0
  while (sourceVersion(db,version) && !rests(db, version, employee, addDays(from, -1), version.ruleSettings) && n++ < 62) from = addDays(from, -1)
  if (n > 62) bounded = false
  n = 0
  while (!rests(db, version, employee, addDays(to, 1), version.ruleSettings) && n++ < 62) to = addDays(to, 1)
  if (n > 62) bounded = false
  const segments: Segment[] = []; let dates: string[] = []
  const flush = () => {
    if (dates.some(d => d.startsWith(version.month))) segments.push({ id: `${employee.id}:${dates[0]}`, employeeId: employee.id, start: dates[0]!, end: dates.at(-1)!, dates, bounded })
    dates = []
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (rests(db, version, employee, d, version.ruleSettings)) flush()
    else dates.push(d)
  }
  flush(); return segments
}
export function completedSegments(db: Database, version: Version, employee: Employee) {
  return workSegments(db, version, employee).flatMap(segment => {
    if (!segment.bounded) return []
    const workable = segment.dates.filter(date => !isAbsence(getRawCell(db, version, employee.id, date)))
    const cells = workable.map(date => getRawCell(db, version, employee.id, date))
    const first = cells[0]
    if (!workable.length || !first || first.kind !== 'shift' || !cells.every(c => c?.kind === 'shift' && c.shiftId === first.shiftId)) return []
    const shift = db.shifts.find(s => s.id === first.shiftId)
    return shift ? [{ ...segment, shiftId: shift.id, category: shift.category, roomId: shift.roomId, days: workable.length }] : []
  })
}
export function priorPhoton(db: Database, month: string, employee: Employee, version?: Version) {
  const previous = version ? sourceVersion(db,version) : activeVersion(db, addMonths(month, -1))
  return previous ? completedSegments(db, previous, employee).filter(s => s.start.startsWith(previous.month) && s.category === '光子') : []
}
export function inputHash(db: Database, month: string) {
  const previous = activeVersion(db, addMonths(month, -1))
  const text = JSON.stringify([db.employees, db.shifts, db.calendar, db.demand, db.vacationPlans.filter(p => p.month === month), db.rules, db.debts.filter(d => d.due <= month), previous?.id, previous?.updated])
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}
export function newVersion(db: Database, month: string): Version {
  const now = new Date().toISOString()
  const v: Version = { id: uid(), month, name: '月度草稿', status: 'draft', created: now, updated: now, vacationPlans: structuredClone(db.vacationPlans.filter(p => p.month === month)), cells: {}, calendar: {}, requirements: {}, employeeIds: orderedEmployees(db).filter(e => daysInMonth(month).some(d => activeOn(e, d))).map(e => e.id), ruleSettings: { ...db.rules }, inputHash: inputHash(db, month), historyMode: activeVersion(db,addMonths(month,-1)) ? 'reference' : 'initial', sourceVersionId:activeVersion(db,addMonths(month,-1))?.id }
  for (const date of daysInMonth(month)) {
    v.calendar[date] = openOn(db, date)
    for (const shift of db.shifts) v.requirements[`${date}|${shift.id}`] = required(db, date, shift.id)
    for (const e of db.employees) if (activeOn(e, date) && !v.calendar[date]) v.cells[key(e.id, date)] = { kind: 'rest', locked: true, source: 'calendar' }
  }
  for (const plan of db.vacationPlans.filter(p => p.month === month)) for (const date of plan.dates) v.cells[key(plan.employeeId,date)] = { kind:'vacation', locked:true, source:'plan', planId:plan.id, note:plan.reason }
  return v
}
export function editableVersion(draft: Database, targetMonth: string): Version {
  let v = activeVersion(draft,targetMonth)
  if (!v) { v = newVersion(draft,targetMonth); draft.versions.push(v); draft.activeVersions[targetMonth] = v.id }
  else if (v.status !== 'draft') {
    v = { ...structuredClone(v), id:uid(), parentId:v.id, status:'draft', name:`${v.name} · 修订`, created:new Date().toISOString() }
    draft.versions.push(v); draft.activeVersions[targetMonth] = v.id
  }
  v.updated = new Date().toISOString()
  for (const e of draft.employees) if (daysInMonth(targetMonth).some(d => activeOn(e,d)) && !v.employeeIds.includes(e.id)) v.employeeIds.push(e.id)
  return v
}
export function emptyDatabase(): Database {
  return {
    schema: 2, vacationPlans: [], demo: false, employees: [], calendar: {}, demand: {}, versions: [], activeVersions: {}, debts: [], logs: [],
    rules: { photonCarry: 'conflict', leaveSplits: false },
    rooms: [
      { id: 'red', name: '红房间', color: '#FFE5EB', ink: '#AD3554' },
      { id: 'orange', name: '橙房间', color: '#FFF0DD', ink: '#A26020' },
      { id: 'blue', name: '白班房间', color: '#E2F1FF', ink: '#2B6DA0' },
      { id: 'photon', name: '光子房间', color: '#FFFFFF', ink: '#596776' },
    ],
    shifts: [
      { id: 'red-early', roomId: 'red', category: '早', enabled: true }, { id: 'red-middle', roomId: 'red', category: '中', enabled: true }, { id: 'red-late', roomId: 'red', category: '晚', enabled: true },
      { id: 'orange-early', roomId: 'orange', category: '早', enabled: true }, { id: 'orange-middle', roomId: 'orange', category: '中', enabled: true }, { id: 'orange-late', roomId: 'orange', category: '晚', enabled: true },
      { id: 'blue-day', roomId: 'blue', category: '白', enabled: true }, { id: 'photon', roomId: 'photon', category: '光子', enabled: true },
    ],
  }
}
