import { describe, expect, it } from 'vitest'
import type { Version } from './types'
import { emptyDatabase, key, newVersion, completedSegments } from './model'
import { adjustCell, saveVacationPlan, removeVacationPlan } from './absences'
import { syncVacationDebts, vacationDebts } from './vacation-deferrals'
import { generate } from './scheduler'
import { debtFulfillment } from './statistics'
import { parseDatabase } from '../services/storage'

const dates=['05','06','07','08','09'].map(d=>`2026-10-${d}`)
function fixture(shiftId='photon'){
  const db=emptyDatabase();db.employees=Array.from({length:18},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}))
  const version=newVersion(db,'2026-10');db.versions.push(version);db.activeVersions[version.month]=version.id
  for(const date of dates)version.cells[key('e0',date)]={kind:'shift',shiftId,source:'auto',locked:false}
  return {db,version}
}
function mount(db:ReturnType<typeof fixture>['db'],v:Version){db.versions.push(v);db.activeVersions[v.month]=v.id}

describe('有原班段依据的休假递延',()=>{
  it.each(['red-middle','photon','blue-day'])('%s整段请假自动登记一次下月任务，保留来源并参与补排',shiftId=>{
    const {db,version}=fixture(shiftId)
    for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    syncVacationDebts(db)
    expect(db.debts).toHaveLength(1)
    expect(db.debts[0]).toMatchObject({employeeId:'e0',origin:'2026-10',due:'2026-11'})
    expect(db.debts[0]!.note).toContain('2026-10-05—2026-10-09')
    expect(version.vacationImpacts).toHaveLength(5)
    const result=generate(db,'2026-11')
    const category=db.shifts.find(s=>s.id===shiftId)!.category
    const done=completedSegments(db,result.version,db.employees[0]!).map(s=>s.category)
    expect(done).toEqual(expect.arrayContaining(['早','晚',category]))
    expect(result.debts.filter(d=>d.id.startsWith('vacation-shift:'))).toHaveLength(1)
    result.version.status='confirmed';mount(db,result.version)
    expect(debtFulfillment(db,db.debts[0]!)?.version.id).toBe(result.version.id)
  })

  it('预定休假覆盖已有普通班时也记录来源，重排不丢来源',()=>{
    const {db}=fixture('blue-day')
    saveVacationPlan(db,{employeeId:'e0',month:'2026-10',dates,reason:''})
    expect(vacationDebts(db)).toHaveLength(1)
    const v=generate(db,'2026-10','rebuild',1).version
    expect(v.vacationImpacts).toHaveLength(5)
    expect(dates.every(date=>v.cells[key('e0',date)]?.kind==='vacation')).toBe(true)
  })

  it('没有原班段的预定休假不凭空产生中光子白欠班',()=>{
    const {db,version}=fixture();version.cells={}
    saveVacationPlan(db,{employeeId:'e0',month:'2026-10',dates,reason:''})
    expect(vacationDebts(db)).toEqual([])
  })

  it('部分请假不切段，可用日期仍完成原类别时不产生递延',()=>{
    const {db}=fixture('red-middle')
    adjustCell(db,'e0',dates[2]!,{kind:'leave',source:'manual',locked:true})
    expect(vacationDebts(db)).toEqual([])
  })

  it('同月已在其他段完成同类别时不重复欠班',()=>{
    const {db,version}=fixture('blue-day')
    for(const date of ['12','13','14','15','16'].map(d=>`2026-10-${d}`))version.cells[key('e0',date)]={kind:'shift',shiftId:'blue-day',source:'auto',locked:false}
    for(const date of dates)adjustCell(db,'e0',date,{kind:'vacation',source:'manual',locked:true})
    expect(vacationDebts(db)).toEqual([])
  })

  it('同员工同来源月同类别只记一项，人工任务不被同步删除',()=>{
    const {db}=fixture();for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    db.debts.push({id:'manual',employeeId:'e1',category:'中',origin:'2026-10',due:'2026-11',note:'人工来源'})
    syncVacationDebts(db);syncVacationDebts(db)
    expect(db.debts).toHaveLength(2);expect(db.debts.some(d=>d.id==='manual')).toBe(true)
  })

  it('恢复原类别的完整段后自动撤销对应休假递延',()=>{
    const {db}=fixture('blue-day');for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    syncVacationDebts(db);expect(db.debts).toHaveLength(1)
    for(const date of dates)adjustCell(db,'e0',date,{kind:'shift',shiftId:'blue-day',source:'manual',locked:true})
    syncVacationDebts(db);expect(db.debts.filter(d=>d.id.startsWith('vacation-shift:'))).toEqual([])
    expect(db.debts.filter(d=>d.id.startsWith('early-late:'))).toHaveLength(2)
  })

  it('取消预定休假后不再保留原休假任务',()=>{
    const {db}=fixture();const plan=saveVacationPlan(db,{employeeId:'e0',month:'2026-10',dates,reason:''})
    syncVacationDebts(db);expect(db.debts.filter(d=>d.id.startsWith('vacation-shift:'))).toHaveLength(1)
    expect(db.debts.filter(d=>d.id.startsWith('early-late:'))).toHaveLength(2)
    removeVacationPlan(db,plan.id);syncVacationDebts(db)
    expect(db.debts).toEqual([])
  })

  it.each(['red-early','orange-late'])('%s不自动变成可递延的低优先目标',shiftId=>{
    const {db}=fixture(shiftId);for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    expect(vacationDebts(db)).toEqual([])
  })

  it('JSON往返保留递延来源并拒绝无效来源',()=>{
    const {db,version}=fixture();for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    syncVacationDebts(db)
    expect(parseDatabase(JSON.parse(JSON.stringify(db))).versions[0]!.vacationImpacts).toEqual(version.vacationImpacts)
    const invalid=structuredClone(db);invalid.versions[0]!.vacationImpacts![0]!.segmentDates=['invalid']
    expect(()=>parseDatabase(invalid)).toThrow('原班段来源无效')
  })

  it('已确认目标月重新生成时仍重新保障待排任务，不误用旧版达成状态',()=>{
    const {db}=fixture();for(const date of dates)adjustCell(db,'e0',date,{kind:'leave',source:'manual',locked:true})
    syncVacationDebts(db)
    const first=generate(db,'2026-11').version;first.status='confirmed';mount(db,first)
    const revised=generate(db,'2026-11').version
    expect(completedSegments(db,revised,db.employees[0]!).some(s=>s.category==='光子')).toBe(true)
  })
})
