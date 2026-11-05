import type { Database, Segment, Version } from './types'
import { activeVersion, getRawCell, workSegments } from './model'
import { addMonths } from './dates'

export function manualMixedSegment(db:Database,version:Version,segment:Segment):boolean {
  const next=activeVersion(db,addMonths(version.month,1))
  const owners=[version,...db.versions.filter(v=>v.id===version.sourceVersionId),...(next?.sourceVersionId===version.id?[next]:[])]
  if(!owners.some(v=>v.manualMixedSegments?.includes(segment.id)))return false
  const cells=segment.dates.map(d=>getRawCell(db,version,segment.employeeId,d)).filter(c=>c?.kind==='shift')
  return cells.some(c=>c!.source==='manual') && new Set(cells.map(c=>c!.shiftId)).size>1
}

// Only an explicit manual edit can authorize a mixed segment. Auto output has no exemption.
export function recordManualSegment(db:Database,version:Version,employeeId:string,date:string) {
  const employee=db.employees.find(e=>e.id===employeeId)
  const segment=employee && workSegments(db,version,employee).find(s=>s.dates.includes(date))
  if(!segment)return
  const ids=new Set(segment.dates.map(d=>getRawCell(db,version,employeeId,d)).filter(c=>c?.kind==='shift').map(c=>c!.shiftId))
  version.manualMixedSegments=(version.manualMixedSegments || []).filter(id=>id!==segment.id)
  if(ids.size>1)version.manualMixedSegments.push(segment.id)
}
