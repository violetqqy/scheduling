import type { Database, Debt, Version } from './types'
import { activeVersion } from './model'
import { addMonths } from './dates'
import { earlyLateStatus } from './monthly-goals'

const prefix='early-late:'
export const isEarlyLateDebt=(debt:Debt)=>debt.id.startsWith(prefix)

// Rebuild from active source versions so restoring a goal also cancels its derived debt.
export function earlyLateDebts(db:Database,override?:Version):Debt[] {
  const view=override?{...db,versions:[...db.versions.filter(v=>v.id!==override.id),override],activeVersions:{...db.activeVersions,[override.month]:override.id}}:db
  return Object.keys(view.activeVersions).flatMap(month=>{
    const version=activeVersion(view,month)
    if(!version)return []
    return view.employees.filter(e=>version.employeeIds.includes(e.id)).flatMap(employee=>{
      const status=earlyLateStatus(view,version,employee)
      return status.deferred.map(category=>({id:`${prefix}${employee.id}:${month}:${category}`,employeeId:employee.id,category,origin:month,due:addMonths(month,1),note:`自动早晚顺延：${status.reasons.join('；')}；${category}段未达成，下月优先补达。依据版本：${version.name}`}))
    })
  })
}
