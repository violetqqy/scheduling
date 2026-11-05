import type { Database, Debt, Version } from './types'
import { activeVersion, getRawCell, orderedEmployees, priorPhoton, workSegments } from './model'
import { addMonths } from './dates'
import { vacationDebts, isVacationDebt } from './vacation-deferrals'
import { earlyLateDebts, isEarlyLateDebt } from './early-late-deferrals'
import { debtFulfillment } from './statistics'

export function prepareMonth(db:Database,template:Version) {
  const month=template.month,previous=activeVersion(db,addMonths(month,-1))
  const photonTasks:Debt[]=[],bans=new Set<string>()
  const carrySegments=orderedEmployees(db).filter(e=>template.employeeIds.includes(e.id)).flatMap(e=>workSegments(db,template,e).filter(s=>s.start<`${month}-01`).map(s=>{
    const shiftIds=[...new Set(s.dates.filter(d=>d<`${month}-01`).map(d=>getRawCell(db,template,e.id,d)).filter(c=>c?.kind==='shift').map(c=>c!.shiftId!))]
    return {employeeId:e.id,start:s.start,end:s.end,shiftIds}
  }))
  for(const employee of orderedEmployees(db).filter(e=>template.employeeIds.includes(e.id))){
    const photonSegments=[...priorPhoton(db,month,employee).map(s=>({id:s.id,start:s.start,end:s.end})),...carrySegments.filter(s=>s.employeeId===employee.id && s.shiftIds.includes('photon')).map(s=>({id:`${employee.id}:${s.start}`,start:s.start,end:s.end}))]
    if(photonSegments.length)bans.add(employee.id)
    for(const s of photonSegments)photonTasks.push({id:`photon-white:${s.id}`,employeeId:employee.id,category:'白',origin:s.start.slice(0,7),due:month,note:`上月光子段 ${s.start}—${s.end} 转白班；先续完原跨月段，本月不新开光子段`})
  }
  // Target drafts must not fulfill their own prerequisite tasks while being replaced.
  const reference={...db,activeVersions:{...db.activeVersions}}
  delete reference.activeVersions[month]
  const tasks=[...db.debts.filter(d=>!isVacationDebt(d) && !isEarlyLateDebt(d) && !(d.id.startsWith('photon-white:') && d.due===month)),...vacationDebts(db),...earlyLateDebts(db),...photonTasks]
  const debts=[...new Map(tasks.map(d=>[d.id,d])).values()]
  const pending=debts.filter(d=>d.due<=month && !debtFulfillment(reference,d))
  return {previous,carrySegments,bans,debts,pending}
}
