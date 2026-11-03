import type { Database } from './types'
import { daysInMonth, validDate } from './dates'
import { openOn } from './model'

export type DemandAction = 'keep' | 'enable' | 'disable' | 'default'
export interface DemandChange { key:string; enabled:boolean | undefined }
export function planDemandChanges(db:Database, month:string, dates:string[], actions:Record<string,DemandAction>) {
  if (!daysInMonth(month).length) throw new Error('请选择有效月份')
  const selected=[...new Set(dates)].sort()
  if (selected.some(date=>!validDate(date) || date.slice(0,7)!==month)) throw new Error('所选日期必须是当前月份的有效日期')
  const configured=Object.entries(actions).filter(([,action])=>action!=='keep')
  for (const [shiftId,action] of Object.entries(actions)) {
    const shift=db.shifts.find(s=>s.id===shiftId)
    if (!shift || !['keep','enable','disable','default'].includes(action)) throw new Error('班次或需求设置无效')
    if (!shift.enabled && ['enable','disable'].includes(action)) throw new Error('全局停用的班次不可设置每日开关，请先启用班次')
  }
  const eligible=selected.filter(date=>openOn(db,date)), skipped=selected.filter(date=>!openOn(db,date))
  const changes:DemandChange[]=[]
  for (const date of eligible) for (const [shiftId,action] of configured) {
    const key=`${date}|${shiftId}`, enabled=action==='default'?undefined:action==='enable'
    if (enabled===undefined ? Object.hasOwn(db.demand,key) : db.demand[key]!==enabled) changes.push({key,enabled})
  }
  return {selected,eligible,skipped,changes,shiftCount:configured.length}
}
export function applyDemandChanges(db:Database, month:string, dates:string[], actions:Record<string,DemandAction>) {
  const plan=planDemandChanges(db,month,dates,actions)
  if (!plan.selected.length) throw new Error('请先选择要调整的日期')
  if (!plan.eligible.length) throw new Error('所选日期都是休息日，请先在工作日历中设为开班')
  if (!plan.changes.length) throw new Error('请选择要修改的班次，或当前需求已与设置一致')
  for (const change of plan.changes) {
    if (change.enabled===undefined) delete db.demand[change.key]
    else db.demand[change.key]=change.enabled
  }
  return plan
}
