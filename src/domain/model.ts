import type { Cell, Database, Employee, Segment, Version } from './types'
import { addDays, addMonths, daysInMonth, isWeekend, uid } from './dates'

export const isAbsence = (cell?: Cell) => cell?.kind === 'vacation' || cell?.kind === 'leave'
export const isOvertimeVacation = (cell?: Cell) => cell?.kind === 'overtime' && cell.overtimeBase?.kind === 'vacation'
export const key = (employeeId: string, date: string) => `${employeeId}|${date}`
export const activeOn = (employee: Employee, date: string) => (!employee.from || employee.from <= date) && (!employee.to || date < employee.to)
export const orderedEmployees = (db: Database) => [...db.employees].sort((a, b) => a.order - b.order || a.code.localeCompare(b.code))
export const activeVersion = (db: Database, month: string) => db.versions.find(v => v.id === db.activeVersions[month])
export const sourceVersion = (db: Database, version: Version) => version.historyMode === 'initial' ? undefined : db.versions.find(v => v.id === version.sourceVersionId) || activeVersion(db,addMonths(version.month,-1))
export const openOn = (db: Database, date: string, version?: Version) => version?.calendar[date] ?? db.calendar[date] ?? !isWeekend(date)
export const required = (db: Database, date: string, shiftId: string, version?: Version) => version?.requirements[`${date}|${shiftId}`] ?? (openOn(db, date, version) && db.shifts.find(s => s.id === shiftId)?.enabled && db.demand[`${date}|${shiftId}`] !== false ? 2 : 0)
export function effectiveCell(db: Database, version: Version, employee: Employee, date: string): Cell | undefined {
  const cell=version.cells[key(employee.id,date)]
  if (cell) return cell
  if (!activeOn(employee, date)) return undefined
  const plan=version.vacationPlans.find(p=>p.employeeId===employee.id && p.dates.includes(date))
  if(plan)return {kind:'vacation',locked:true,source:'plan',planId:plan.id,note:plan.reason}
  return (!openOn(db, date, version) ? { kind: 'rest', locked: true, source: 'calendar' } : undefined)
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
// Work boundaries belong to the calendar, never to editable actual cells.
function rests(db: Database, version: Version, employee: Employee, date: string) {
  return !activeOn(employee,date) || !openOn(db,date,versionOnDate(db,version,date))
}
export const fixedRules = () => ({photonCarry:'continue' as const,leaveSplits:false,redYellowOrder:true,monthlyRoomDiversity:true,earlyLatePriority:true,earlyLateCarry:true,singleDayCredit:true})
export function oppositeRoom(db:Database, previous:Version | undefined, employeeId:string, category:string) {
  if (!previous || !['早','中','晚'].includes(category)) return undefined
  const records=Object.entries(previous.cells).flatMap(([k,c])=>{
    const [id,date]=k.split('|'),shift=db.shifts.find(s=>s.id===c.shiftId)
    return id===employeeId && date?.startsWith(previous.month) && c.kind==='shift' && shift?.category===category && ['red','orange'].includes(shift.roomId) ? [{date,room:shift.roomId}] : []
  }).sort((a,b)=>a.date.localeCompare(b.date))
  if(!records.length)return undefined
  const red=records.filter(r=>r.room==='red').length,orange=records.length-red
  const previousRoom=red===orange?records.at(-1)!.room:red>orange?'red':'orange'
  return previousRoom==='red'?'orange':'red'
}
export function workSegments(db: Database, version: Version, employee: Employee): Segment[] {
  const monthDays = daysInMonth(version.month); if (!monthDays.length) return []
  let from = monthDays[0]!, to = monthDays.at(-1)!, bounded = true
  let n = 0
  while (sourceVersion(db,version) && !rests(db, version, employee, addDays(from, -1)) && n++ < 62) from = addDays(from, -1)
  if (n > 62) bounded = false
  n = 0
  while (!rests(db, version, employee, addDays(to, 1)) && n++ < 62) to = addDays(to, 1)
  if (n > 62) bounded = false
  const segments: Segment[] = []; let dates: string[] = []
  const flush = () => {
    if (dates.some(d => d.startsWith(version.month))) segments.push({ id: `${employee.id}:${dates[0]}`, employeeId: employee.id, start: dates[0]!, end: dates.at(-1)!, dates, bounded })
    dates = []
  }
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (rests(db, version, employee, d)) flush()
    else dates.push(d)
  }
  flush(); return segments
}
export function completedSegments(db: Database, version: Version, employee: Employee) {
  return workSegments(db, version, employee).flatMap(segment => {
    if (!segment.bounded) return []
    const workable = segment.dates.filter(date => {const c=getRawCell(db,version,employee.id,date);return !isAbsence(c) && !isOvertimeVacation(c)})
    const cells = workable.map(date => getRawCell(db, version, employee.id, date))
    const first = cells[0]
    const uniform=workable.length>0 && first?.kind==='shift' && cells.every(c=>c?.kind==='shift' && c.shiftId===first.shiftId)
    const next=activeVersion(db,addMonths(version.month,1)),prior=sourceVersion(db,version)
    const owners=[version,...(prior?[prior]:[]),...(next?.sourceVersionId===version.id?[next]:[])]
    const baseline=owners.flatMap(v=>v.segmentBaselines || []).find(b=>b.employeeId===employee.id && b.start===segment.start && b.dates.join('|')===segment.dates.join('|'))
    // Credit the recorded original only when exactly one current day differs manually.
    // Requiring every other date to be a shift prevents blank/cleared days from earning credit.
    const differences=baseline ? segment.dates.filter(d=>{const c=getRawCell(db,version,employee.id,d);return baseline.excludedDates?.includes(d)?!isAbsence(c) && !isOvertimeVacation(c):c?.kind!=='shift' || c.shiftId!==baseline.shiftId}) : []
    const adjustedDate=differences.length===1?differences[0]:undefined
    const credited=!!baseline && !!adjustedDate && getRawCell(db,version,employee.id,adjustedDate)?.source==='manual'
    const shiftId=credited?baseline!.shiftId:uniform?first!.shiftId:undefined
    const shift=db.shifts.find(s=>s.id===shiftId)
    return shift ? [{ ...segment, shiftId: shift.id, category: shift.category, roomId: shift.roomId, days: workable.length, credited, adjustedDate:credited?adjustedDate:undefined }] : []
  })
}
export function recordSegmentBaseline(db:Database,version:Version,employeeId:string,date:string) {
  const employee=db.employees.find(e=>e.id===employeeId),segment=employee && workSegments(db,version,employee).find(s=>s.dates.includes(date))
  if(!segment?.bounded || segment.dates.length>62)return
  if(completedSegments(db,version,employee!).some(s=>s.id===segment.id && s.credited))return
  const existing=version.segmentBaselines?.find(b=>b.employeeId===employeeId && b.start===segment.start)
  const allCells=segment.dates.map(d=>getRawCell(db,version,employeeId,d)),allFirst=allCells[0]
  const uniformFull=allFirst?.kind==='shift' && allCells.every(c=>c?.kind==='shift' && c.shiftId===allFirst.shiftId)
  // Sequential edits must keep the original basis; otherwise five manual leave edits
  // could repeatedly rebase the segment until the last day falsely counts as completion.
  if(existing && !uniformFull && segment.dates.some(d=>{
    const c=getRawCell(db,version,employeeId,d)
    return c?.source==='manual' && (existing.excludedDates?.includes(d)?!isAbsence(c) && !isOvertimeVacation(c):c.kind!=='shift' || c.shiftId!==existing.shiftId)
  }))return
  const excludedDates=segment.dates.filter(d=>{const c=getRawCell(db,version,employeeId,d);return isAbsence(c) || isOvertimeVacation(c)})
  const cells=segment.dates.filter(d=>!excludedDates.includes(d)).map(d=>getRawCell(db,version,employeeId,d)),first=cells[0]
  if(first?.kind!=='shift' || !cells.every(c=>c?.kind==='shift' && c.shiftId===first.shiftId))return
  version.segmentBaselines=(version.segmentBaselines || []).filter(b=>b.employeeId!==employeeId || b.start!==segment.start)
  version.segmentBaselines.push({employeeId,start:segment.start,dates:[...segment.dates],shiftId:first.shiftId!,excludedDates})
}
export function wholeVacationSegments(db:Database,version:Version,employee:Employee) {
  return workSegments(db,version,employee).filter(s=>s.bounded && s.start.startsWith(version.month) && s.dates.every(date=>{
    const owner=versionOnDate(db,version,date)
    return !!owner && (owner.vacationPlans.some(p=>p.employeeId===employee.id && p.dates.includes(date)) || getRawCell(db,version,employee.id,date)?.kind==='vacation')
  }))
}
export function priorPhoton(db: Database, month: string, employee: Employee, version?: Version) {
  const previous = version ? sourceVersion(db,version) : activeVersion(db, addMonths(month, -1))
  return previous ? completedSegments(db, previous, employee).filter(s => s.start.startsWith(previous.month) && s.category === '光子') : []
}
export function inputHash(db: Database, month: string) {
  const previous = activeVersion(db, addMonths(month, -1))
  const text = JSON.stringify([db.employees, db.shifts, db.calendar, db.demand, db.vacationPlans.filter(p => p.month === month), db.rules, fixedRules(), db.debts.filter(d => d.due <= month), previous?.id, previous?.updated])
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16)
}
export function newVersion(db: Database, month: string): Version {
  const now = new Date().toISOString()
  const v: Version = { id: uid(), month, name: '月度草稿', status: 'draft', created: now, updated: now, vacationPlans: structuredClone(db.vacationPlans.filter(p => p.month === month)), cells: {}, calendar: {}, requirements: {}, employeeIds: orderedEmployees(db).filter(e => daysInMonth(month).some(d => activeOn(e, d))).map(e => e.id), ruleSettings: fixedRules(), inputHash: inputHash(db, month), historyMode: activeVersion(db,addMonths(month,-1)) ? 'reference' : 'initial', sourceVersionId:activeVersion(db,addMonths(month,-1))?.id }
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
    rules: fixedRules(),
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
