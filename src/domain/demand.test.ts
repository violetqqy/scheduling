import { describe, expect, it } from 'vitest'
import { applyDemandChanges, planDemandChanges } from './demand'
import type { DemandAction } from './demand'
import { emptyDatabase, inputHash, newVersion, required } from './model'

describe('月度日历需求设置',()=>{
  it('单日关闭一个班次，只改变指定需求且仍固定以2人为单位',()=>{
    const db=emptyDatabase(),before=structuredClone(db)
    const result=applyDemandChanges(db,'2026-11',['2026-11-02'],{'red-early':'disable'})
    expect(result.changes).toEqual([{key:'2026-11-02|red-early',enabled:false}])
    expect(required(db,'2026-11-02','red-early')).toBe(0)
    expect(required(db,'2026-11-02','orange-early')).toBe(2)
    expect(required(db,'2026-11-03','red-early')).toBe(2)
    expect({...db,demand:{}}).toEqual(before)
  })

  it('批量去重并跳过休息日，保留未指定班次及其他日期的个别配置',()=>{
    const db=emptyDatabase();db.calendar['2026-11-07']=true;db.calendar['2026-11-04']=false
    db.demand['2026-11-02|red-early']=false
    db.demand['2026-11-03|orange-late']=false
    const dates=['2026-11-02','2026-11-02','2026-11-04','2026-11-07','2026-11-08']
    const actions={'red-early':'keep','orange-middle':'disable'} as const
    const before=structuredClone(db),plan=planDemandChanges(db,'2026-11',dates,actions)
    expect(db).toEqual(before)
    expect(plan.eligible).toEqual(['2026-11-02','2026-11-07'])
    expect(plan.skipped).toEqual(['2026-11-04','2026-11-08'])
    expect(applyDemandChanges(db,'2026-11',dates,actions)).toEqual(plan)
    expect(db.demand).toEqual({...before.demand,'2026-11-02|orange-middle':false,'2026-11-07|orange-middle':false})
  })

  it('混合状态可统一启用，恢复默认会移除覆盖并遵循全局开关',()=>{
    const db=emptyDatabase();db.demand['2026-11-02|red-early']=false
    applyDemandChanges(db,'2026-11',['2026-11-02','2026-11-03'],{'red-early':'enable'})
    for(const date of ['2026-11-02','2026-11-03'])expect(required(db,date,'red-early')).toBe(2)
    db.shifts.find(s=>s.id==='photon')!.enabled=false;db.demand['2026-11-02|photon']=true
    applyDemandChanges(db,'2026-11',['2026-11-02','2026-11-03'],{'red-early':'default','photon':'default'})
    expect(db.demand).toEqual({})
    expect(required(db,'2026-11-02','red-early')).toBe(2)
    expect(required(db,'2026-11-02','photon')).toBe(0)
  })

  it('非法日期、跨月、无效班次或动作整批拒绝，不产生部分修改',()=>{
    const db=emptyDatabase(),before=structuredClone(db)
    for(const date of ['2026-11-31','2026-12-01','invalid'])expect(()=>applyDemandChanges(db,'2026-11',['2026-11-02',date],{'red-early':'disable'})).toThrow('有效日期')
    for(const actions of [{'red-early':'disable',missing:'disable'},{'red-early':'disable',photon:'unknown'}])expect(()=>applyDemandChanges(db,'2026-11',['2026-11-02'],actions as unknown as Record<string,DemandAction>)).toThrow('设置无效')
    expect(()=>applyDemandChanges(db,'2026-13',['2026-11-02'],{'red-early':'disable'})).toThrow('有效月份')
    expect(db).toEqual(before)
  })

  it('全局停用班次不可按日启闭，校验失败时其他班次也不写入',()=>{
    const db=emptyDatabase();db.shifts.find(s=>s.id==='photon')!.enabled=false
    const before=structuredClone(db)
    for(const action of ['enable','disable'] as const)expect(()=>applyDemandChanges(db,'2026-11',['2026-11-02'],{'red-early':'disable',photon:action})).toThrow('全局停用')
    expect(db).toEqual(before)
  })

  it('空选择、全部休息、未设置动作或无差异均不保存',()=>{
    const db=emptyDatabase(),before=structuredClone(db)
    expect(()=>applyDemandChanges(db,'2026-11',[],{'red-early':'disable'})).toThrow('请先选择')
    expect(()=>applyDemandChanges(db,'2026-11',['2026-11-01'],{'red-early':'disable'})).toThrow('都是休息日')
    for(const actions of [{'red-early':'keep'},{'red-early':'default'}] as const)expect(()=>applyDemandChanges(db,'2026-11',['2026-11-02'],actions)).toThrow('当前需求已与设置一致')
    expect(db).toEqual(before)
    applyDemandChanges(db,'2026-11',['2026-11-02'],{'red-early':'disable'})
    expect(()=>applyDemandChanges(db,'2026-11',['2026-11-02'],{'red-early':'disable'})).toThrow('当前需求已与设置一致')
  })

  it('已有班表和需求快照不变，后续新版本采用更新需求并提示输入变化',()=>{
    const db=emptyDatabase(),version=newVersion(db,'2026-11');version.status='confirmed'
    db.versions.push(version);db.activeVersions[version.month]=version.id
    const before=structuredClone(version),hash=inputHash(db,'2026-11')
    applyDemandChanges(db,'2026-11',['2026-11-02','2026-11-03'],{'red-early':'disable'})
    expect(version).toEqual(before)
    expect(inputHash(db,'2026-11')).not.toBe(hash)
    expect(required(db,'2026-11-02','red-early',version)).toBe(2)
    const next=newVersion(db,'2026-11')
    expect(next.requirements['2026-11-02|red-early']).toBe(0)
    expect(next.requirements['2026-11-03|red-early']).toBe(0)
    expect(next.requirements['2026-11-04|red-early']).toBe(2)
  })
})
