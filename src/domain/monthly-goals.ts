import type { RotationCategory } from './rotation'
import type { Database, Employee, Version } from './types'
import { completedSegments, required, wholeVacationSegments, workSegments } from './model'
import { daysInMonth } from './dates'

// An upper bound for full early/late slots. This only steers the priority cohort;
// all other employees remain eligible to fill every remaining shift.
export function earlyLateCapacity(db:Database,version:Version,employee:Employee):number {
  const calendarEmployee={...employee,from:'',to:''}
  const segments=workSegments(db,version,calendarEmployee).filter(s=>s.start.startsWith(version.month) && s.end<=daysInMonth(version.month).at(-1)!)
  return Math.min(...['早','晚'].map(category=>segments.reduce((n,segment)=>n+db.shifts.filter(s=>s.category===category).reduce((slots,shift)=>slots+Math.min(...segment.dates.map(date=>required(db,date,shift.id,version))),0),0)))
}

// Count ordinary work segments needed, starting with the proposed category.
// Middle is a necessary step between early and late, rather than a competing goal.
export function stepsToEarlyLate(category: RotationCategory, done: ReadonlySet<string>): number {
  return stepsToCategories(category,new Set(['早','晚'].filter(c=>!done.has(c))))
}
export function stepsToCategories(category:RotationCategory, targets:ReadonlySet<string>):number {
  const missing = new Set(targets)
  if (!missing.size) return 0
  const next: Record<RotationCategory, RotationCategory> = {早:'中',中:'晚',晚:'早'}
  for (let steps=1;steps<=3;steps++,category=next[category]) {
    missing.delete(category)
    if (!missing.size) return steps
  }
  return 3
}

export function earlyLateStatus(db:Database,version:Version,employee:Employee) {
  const complete=completedSegments(db,version,employee).filter(s=>s.start.startsWith(version.month))
  const reasons=[...complete.filter(s=>s.category==='白' || s.category==='光子').map(s=>`${s.category}班完整段 ${s.start}—${s.end}`),...wholeVacationSegments(db,version,employee).map(s=>`整段预定休假 ${s.start}—${s.end}`)]
  const missing=(['早','晚'] as const).filter(c=>!complete.some(s=>s.category===c))
  const canDefer=reasons.length>0
  return {complete,reasons,missing,canDefer,early:!missing.includes('早'),late:!missing.includes('晚'),deferred:canDefer?missing:[]}
}
export function goalLabel(status:ReturnType<typeof earlyLateStatus>,category:'早'|'晚'):string {
  return !status.missing.includes(category)?'已达成':status.canDefer?'允许顺延':'未达成'
}
