import type { Cell, Database, Version } from './types'
import { activeOn, openOn, sourceVersion } from './model'

export type RotationCategory = '早' | '中' | '晚'
const next: Record<RotationCategory, RotationCategory> = {早:'中',中:'晚',晚:'早'}

export function rotationCategory(db:Database, cell?:Cell):RotationCategory | undefined {
  if(cell?.kind!=='shift')return undefined
  const shift=db.shifts.find(s=>s.id===cell.shiftId)
  return shift && ['red','orange'].includes(shift.roomId) && ['早','中','晚'].includes(shift.category) ? shift.category as RotationCategory : undefined
}

// A work segment consumes one rotation step, regardless of its length or room.
// Only look before its start, so a cross-month continuation never consumes two steps.
export function nextRotationCategory(db:Database, version:Version, employeeId:string, segmentStart:string):RotationCategory | undefined {
  const employee=db.employees.find(e=>e.id===employeeId)
  if(!employee)return undefined
  const visited=new Set<string>()
  let owner:Version | undefined=version
  while(owner && !visited.has(owner.id)){
    visited.add(owner.id)
    let lastDate='', last:RotationCategory | undefined
    for(const [k,cell] of Object.entries(owner.cells)){
      const [id,date]=k.split('|'),category=rotationCategory(db,cell)
      if(id===employeeId && date && date.startsWith(owner.month) && date<segmentStart && date>lastDate && category && activeOn(employee,date) && openOn(db,date,owner)){lastDate=date;last=category}
    }
    if(last)return next[last]
    const prior=sourceVersion(db,owner)
    owner=prior && prior.month<owner.month?prior:undefined
  }
  return undefined
}
