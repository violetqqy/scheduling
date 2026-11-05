import type { Cell, Database, Debt, Version } from './types'
import { addMonths } from './dates'
import { activeVersion, completedSegments, getRawCell, isAbsence, key, workSegments } from './model'
import { earlyLateDebts, isEarlyLateDebt } from './early-late-deferrals'

const prefix='vacation-shift:'
export const isVacationDebt=(debt:Debt)=>debt.id.startsWith(prefix)

// Capture the actual shift that an absence replaces. No historical guesswork.
export function recordVacationImpact(db:Database,version:Version,employeeId:string,date:string,next:Cell) {
  const old=version.cells[key(employeeId,date)]
  if(!isAbsence(next)){
    if(version.vacationImpacts)version.vacationImpacts=version.vacationImpacts.filter(r=>r.employeeId!==employeeId || r.date!==date)
    return
  }
  if(old?.kind!=='shift')return
  const employee=db.employees.find(e=>e.id===employeeId),shift=db.shifts.find(s=>s.id===old.shiftId)
  const segment=employee && workSegments(db,version,employee).find(s=>s.dates.includes(date))
  if(!segment || !segment.bounded || segment.dates.length>62 || !shift || !['中','光子','白'].includes(shift.category))return
  const shifts=new Set(segment.dates.map(d=>getRawCell(db,version,employeeId,d)).filter(c=>c?.kind==='shift').map(c=>c!.shiftId))
  if(shifts.size!==1)return
  version.vacationImpacts=(version.vacationImpacts || []).filter(r=>r.employeeId!==employeeId || r.date!==date)
  version.vacationImpacts.push({employeeId,date,shiftId:shift.id,segmentDates:[...segment.dates]})
}

// Derive one outstanding category target per employee/origin month, with traceable segments.
// Partial absences do not create debt when the remaining available days complete that category.
export function vacationDebts(db:Database,override?:Version):Debt[] {
  const view=override?{...db,versions:[...db.versions.filter(v=>v.id!==override.id),override],activeVersions:{...db.activeVersions,[override.month]:override.id}}:db
  const records=Object.entries(view.activeVersions).flatMap(([month])=>activeVersion(view,month)?.vacationImpacts || [])
  const debts=new Map<string,Debt>()
  for(const record of records){
    const origin=record.segmentDates[0]?.slice(0,7),owner=origin && activeVersion(view,origin)
    const shift=view.shifts.find(s=>s.id===record.shiftId),employee=view.employees.find(e=>e.id===record.employeeId)
    if(!owner || !employee || !shift || !['中','光子','白'].includes(shift.category))continue
    if(!isAbsence(getRawCell(view,owner,record.employeeId,record.date)))continue
    // A later month is only usable when it belongs to this original version's continuation.
    if(record.segmentDates.some(date=>date.slice(0,7)>owner.month && !getRawCell(view,owner,record.employeeId,date)))continue
    if(!record.segmentDates.some(date=>isAbsence(getRawCell(view,owner,record.employeeId,date))))continue
    if(completedSegments(view,owner,employee).some(s=>s.start.startsWith(origin!) && s.category===shift.category))continue
    const id=`${prefix}${employee.id}:${origin}:${shift.category}`,range=`${record.segmentDates[0]}—${record.segmentDates.at(-1)}`
    const existing=debts.get(id)
    if(existing){if(!existing.note.includes(range))existing.note+=`；${range}`}
    else debts.set(id,{id,employeeId:employee.id,category:shift.category,origin:origin!,due:addMonths(origin!,1),note:`自动休假递延：原${shift.category}班段 ${range} 因预定休假/请假未完成；先满足完整早晚段后补排`})
  }
  return [...debts.values()]
}

export function syncVacationDebts(db:Database) {
  db.debts=[...db.debts.filter(d=>!isVacationDebt(d) && !isEarlyLateDebt(d)),...vacationDebts(db),...earlyLateDebts(db)]
}
