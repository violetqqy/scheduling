import { describe, expect, it } from 'vitest'
import type { Database, Version } from './types'
import { activeVersion, completedSegments, emptyDatabase, key, newVersion, workSegments } from './model'
import { adjustCell, saveVacationPlan, removeVacationPlan } from './absences'
import { earlyLateStatus, goalLabel } from './monthly-goals'
import { earlyLateDebts } from './early-late-deferrals'
import { syncVacationDebts } from './vacation-deferrals'
import { prepareMonth } from './prepare-month'
import { generate } from './scheduler'
import { employeeStatistics, debtFulfillment } from './statistics'
import { coverage, validate } from './validation'
import { clearMonthSchedule } from './schedule-edit'
import { parseDatabase } from '../services/storage'
import { exportWorkbook } from '../services/excel'

function mount(db:Database,v:Version){db.versions.push(v);db.activeVersions[v.month]=v.id;return v}
function fixture(count=1,month='2026-11'){
 const db=emptyDatabase();db.employees=Array.from({length:count},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}))
 const v=mount(db,newVersion(db,month)),e=db.employees[0]!
 return {db,v,e,segments:workSegments(db,v,e)}
}
function fill(db:Database,v:Version,employeeId:string,start:string,shiftId:string){
 const segment=workSegments(db,v,db.employees.find(e=>e.id===employeeId)!).find(s=>s.start===start)!
 for(const date of segment.dates.filter(d=>d.startsWith(v.month)))v.cells[key(employeeId,date)]={kind:'shift',shiftId,source:'auto',locked:false}
}
const manual=(shiftId:string)=>({kind:'shift' as const,shiftId,source:'manual' as const,locked:true})

describe('早晚允许顺延与原段达成',()=>{
 it.each(['blue-day','photon'])('完整%s允许未达成早晚顺延，显示和人天独立',shiftId=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02',shiftId)
  const status=earlyLateStatus(db,v,e)
  expect(status.deferred).toEqual(['早','晚']);expect(goalLabel(status,'早')).toBe('允许顺延')
  expect(validate(db,v).filter(i=>i.employeeId===e.id && i.rule==='P01')).toEqual([])
  expect(validate(db,v).some(i=>i.employeeId===e.id && i.rule==='P06')).toBe(true)
  const row=employeeStatistics(db,v)[0]!
  expect(row.early).toBe(false);expect(row.work).toBe(5);expect(row.earlyLabel).toBe('允许顺延')
  expect(exportWorkbook(db,v).getWorksheet('员工统计')!.getRow(2).getCell(15).value).toBe('允许顺延')
  expect(earlyLateDebts(db).map(d=>[d.category,d.origin,d.due])).toEqual([['早','2026-11','2026-12'],['晚','2026-11','2026-12']])
 })
 it('整段预定休假无需虚构原班次即可递延早晚，部分预定休假不豁免',()=>{
  const {db,v,e,segments}=fixture();const dates=segments[0]!.dates
  const plan=saveVacationPlan(db,{employeeId:e.id,month:v.month,dates,reason:''})
  expect(earlyLateStatus(db,v,e).canDefer).toBe(true)
  saveVacationPlan(db,{...plan,dates:dates.slice(1)})
  expect(earlyLateStatus(db,v,e).canDefer).toBe(false)
  expect(earlyLateDebts(db)).toEqual([])
 })
 it('整段事后请假、零散白班和缺失日期均不凭空豁免早晚',()=>{
  const {db,v,e,segments}=fixture()
  for(const d of segments[0]!.dates)adjustCell(db,e.id,d,{kind:'leave',source:'manual',locked:true})
  v.cells[key(e.id,'2026-11-09')]={kind:'shift',shiftId:'blue-day',source:'import',locked:false}
  expect(earlyLateStatus(db,v,e).canDefer).toBe(false);expect(earlyLateDebts(db)).toEqual([])
 })
 it('已达成早晚时即使有白班也不创建欠班；恢复目标或撤销依据会撤销自动任务',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','blue-day')
  syncVacationDebts(db);syncVacationDebts(db);expect(db.debts).toHaveLength(2)
  fill(db,v,e.id,'2026-11-09','red-early');fill(db,v,e.id,'2026-11-16','red-late')
  syncVacationDebts(db);expect(db.debts).toEqual([])
  const other=fixture(),plan=saveVacationPlan(other.db,{employeeId:other.e.id,month:other.v.month,dates:other.segments[0]!.dates,reason:''})
  syncVacationDebts(other.db);expect(other.db.debts).toHaveLength(2)
  removeVacationPlan(other.db,plan.id);syncVacationDebts(other.db);expect(other.db.debts).toEqual([])
 })
 it.each([['red-early','red-middle','早'],['red-middle','red-early','中'],['orange-late','red-early','晚'],['blue-day','red-middle','白'],['photon','red-middle','光子']])('原%s单日改%s仍只达成原%s段',(original,changed,category)=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02',original!)
  adjustCell(db,e.id,'2026-11-02',manual(changed!))
  expect(completedSegments(db,v,e).filter(s=>s.start==='2026-11-02')).toMatchObject([{category,shiftId:original,credited:true,adjustedDate:'2026-11-02'}])
  expect(employeeStatistics(db,v)[0]!.categories[db.shifts.find(s=>s.id===changed)!.category]).toBe(1)
 })
 it('两天短段改一天也按原段，不按多数推断；改两天混班不额外记完整段',()=>{
  const {db,v,e}=fixture();db.calendar['2026-11-04']=false;v.calendar['2026-11-04']=false
  fill(db,v,e.id,'2026-11-02','red-early');adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  expect(completedSegments(db,v,e).find(s=>s.start==='2026-11-02')).toMatchObject({category:'早',credited:true})
  const other=fixture();fill(other.db,other.v,other.e.id,'2026-11-02','red-early')
  for(const d of ['2026-11-02','2026-11-03'])adjustCell(other.db,other.e.id,d,manual('red-middle'))
  expect(completedSegments(other.db,other.v,other.e).find(s=>s.start==='2026-11-02')).toBeUndefined()
 })
 it('无原班段依据的人工混班和自动混班不获得单日达成',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','red-early')
  v.cells[key(e.id,'2026-11-02')]={kind:'shift',shiftId:'red-middle',source:'auto',locked:false}
  expect(completedSegments(db,v,e)).toEqual([])
  expect(validate(db,v).some(i=>i.rule==='H04')).toBe(true)
  adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  expect(completedSegments(db,v,e)).toEqual([])
 })
 it('原段含预定休假时，可用日的单日改班仍保留原段；多改一天不重复套用例外',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','red-early')
  saveVacationPlan(db,{employeeId:e.id,month:v.month,dates:['2026-11-03'],reason:''})
  adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  expect(completedSegments(db,v,e)[0]).toMatchObject({category:'早',credited:true,days:4})
  expect(v.segmentBaselines?.[0]?.excludedDates).toEqual(['2026-11-03'])
  adjustCell(db,e.id,'2026-11-04',manual('red-middle'))
  expect(completedSegments(db,v,e)).toEqual([])
 })
 it('一次改班为请假后再改另一天，不通过重置原段依据假装只有一次调整',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','red-early')
  adjustCell(db,e.id,'2026-11-02',{kind:'leave',source:'manual',locked:true})
  adjustCell(db,e.id,'2026-11-03',manual('red-middle'))
  expect(completedSegments(db,v,e)).toEqual([])
 })
 it('原班段记录JSON往返，非法来源拒绝，清空副本不沿用达成依据',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','red-early');adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  const restored=parseDatabase(JSON.parse(JSON.stringify(db)))
  expect(completedSegments(restored,activeVersion(restored,v.month)!,e)[0]?.category).toBe('早')
  restored.versions[0]!.segmentBaselines![0]!.shiftId='unknown'
  expect(()=>parseDatabase(restored)).toThrow('原班段达成依据无效')
  const {version:cleared}=clearMonthSchedule(db,v.month,v.id)
  expect(cleared.segmentBaselines).toBeUndefined();expect(completedSegments(db,cleared,e)).toEqual([])
  expect(v.segmentBaselines).toHaveLength(1)
 })
})

describe('先分析历史规则再生成目标月',()=>{
 it('上月未预先同步债务，生成前仍自动发现早晚任务，且不改变源数据',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','blue-day')
  const snapshot=JSON.stringify(db),prepared=prepareMonth(db,newVersion(db,'2026-12'))
  expect(prepared.pending.map(d=>d.category)).toEqual(['早','晚']);expect(JSON.stringify(db)).toBe(snapshot)
 })
 it('上月规则快照未记录新字段时，生成前仍按当前固定规则推导顺延',()=>{
  const {db,v,e}=fixture();delete v.ruleSettings.earlyLateCarry;fill(db,v,e.id,'2026-11-02','blue-day')
  expect(prepareMonth(db,newVersion(db,'2026-12')).pending.map(d=>d.category)).toEqual(['早','晚'])
 })
 it('上月光子来源已撤销时，不再向目标月沿用旧光子转白任务',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','photon')
  const template=newVersion(db,'2026-12'),first=prepareMonth(db,template)
  db.debts.push(...first.debts)
  fill(db,v,e.id,'2026-11-02','red-early')
  const next=prepareMonth(db,template)
  expect(next.debts.some(d=>d.id.startsWith('photon-white:'))).toBe(false)
  expect(next.bans.has(e.id)).toBe(false)
 })
 it('导出保留原段达成依据和本次排班前任务清单，实际矩阵不改回原班',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','red-early');adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  const task={id:'manual-task',employeeId:e.id,category:'晚' as const,origin:'2026-10',due:'2026-11',note:'有来源任务'}
  v.run={attempts:1,duration:0,note:'测试',preparation:{carrySegments:0,pendingDebts:[task]}}
  const wb=exportWorkbook(db,v)
  expect(wb.getWorksheet('月度排班')!.getRow(2).getCell(4).value).toBe('中')
  expect(wb.getWorksheet('工作段达成')!.getRow(2).getCell(6).value).toBe('早')
  expect(wb.getWorksheet('工作段达成')!.getRow(2).getCell(8).value).toBe('单日调整，按原段达成')
  expect(wb.getWorksheet('排班前任务')!.getRow(2).getCell(6).value).toBe(task.id)
 })
 it('原跨月光子段先续完，同时生成光子转白任务并禁开新光子段',()=>{
  const {db,v,e}=fixture(18,'2026-06');fill(db,v,e.id,'2026-06-29','photon')
  const result=generate(db,'2026-07','rebuild',2)
  expect(result.version.cells[key(e.id,'2026-07-01')]?.shiftId).toBe('photon')
  expect(result.version.cells[key(e.id,'2026-07-06')]?.shiftId).not.toBe('photon')
  expect(result.version.run?.preparation?.pendingDebts.some(d=>d.id.startsWith('photon-white:') && d.employeeId===e.id)).toBe(true)
  expect(result.debts.filter(d=>d.id===`photon-white:${e.id}:2026-06-29`)).toHaveLength(1)
 })
 it('历史晚段欠班优先补达，保持早中晚顺序和每日2人；确认后才核销，重排不误用旧版完成状态',()=>{
  const {db,v,e}=fixture(18,'2026-10');fill(db,v,e.id,'2026-10-05','red-early');fill(db,v,e.id,'2026-10-12','red-middle');fill(db,v,e.id,'2026-10-19','blue-day')
  expect(db.debts).toEqual([])
  const result=generate(db,'2026-11','rebuild',4),next=result.version
  const task=result.debts.find(d=>d.employeeId===e.id && d.category==='晚' && d.origin==='2026-10')!
  expect(task).toBeDefined();expect(next.run?.preparation?.pendingDebts.some(d=>d.id===task.id)).toBe(true)
  const done=completedSegments(db,next,e).filter(s=>s.start.startsWith(next.month))
  expect(done.some(s=>s.category==='晚')).toBe(true)
  expect(done.find(s=>['早','中','晚'].includes(s.category))?.category).toBe('晚')
  expect(coverage(db,next).every(r=>r.actual===r.expected)).toBe(true)
  expect(validate(db,next).filter(i=>i.level==='error')).toEqual([])
  mount(db,next);expect(debtFulfillment(db,task)).toBeUndefined()
  next.status='confirmed';expect(debtFulfillment(db,task)?.version.id).toBe(next.id)
  db.debts.push(...result.debts)
  const again=generate(db,next.month,'rebuild',2)
  expect(again.version.run?.preparation?.pendingDebts.some(d=>d.id===task.id)).toBe(true)
  expect(new Set(again.debts.map(d=>d.id)).size).toBe(again.debts.length)
 })
 it('只有更早已确认月份完成的任务才从排班前待补清单去除',()=>{
  const {db,v,e}=fixture();fill(db,v,e.id,'2026-11-02','blue-day');syncVacationDebts(db)
  const dec=mount(db,newVersion(db,'2026-12'));fill(db,dec,e.id,'2026-12-07','red-early');fill(db,dec,e.id,'2026-12-14','red-late')
  expect(prepareMonth(db,newVersion(db,'2027-01')).pending.filter(d=>d.origin==='2026-11')).toHaveLength(2)
  dec.status='confirmed'
  expect(prepareMonth(db,newVersion(db,'2027-01')).pending.filter(d=>d.origin==='2026-11')).toEqual([])
 })
 it('重排保留人工单日原段依据，仍不自动新增混班',()=>{
  const {db,v,e}=fixture(18);fill(db,v,e.id,'2026-11-02','red-early')
  for(const date of ['02','03','04','05','06'].map(d=>`2026-11-${d}`))adjustCell(db,e.id,date,manual('red-early'))
  adjustCell(db,e.id,'2026-11-02',manual('red-middle'))
  const next=generate(db,v.month,'rebuild',1).version
  expect(completedSegments(db,next,e).find(s=>s.start==='2026-11-02')).toMatchObject({category:'早',credited:true})
 })
})
