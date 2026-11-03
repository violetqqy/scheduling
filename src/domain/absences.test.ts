import { describe, expect, it } from 'vitest'
import { adjustCell, cancelLeave, removeVacationPlan, saveVacationPlan } from './absences'
import { activeVersion, completedSegments, emptyDatabase, inputHash, key, newVersion, workSegments } from './model'
import { generate } from './scheduler'
import { employeeStatistics } from './statistics'
import { parseDatabase } from '../services/storage'
function fixture() {
  const db = emptyDatabase()
  db.employees = Array.from({length:18},(_,i) => ({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-06-01',to:'',note:''}))
  return db
}
const input = (dates = ['2026-06-02','2026-06-03']) => ({employeeId:'e0',month:'2026-06',dates,reason:'预定年假'})
describe('预定休假与事后请假',() => {
  it('排班前创建独立月度计划与黄色不可用格，修改输入签名',() => {
    const db = fixture(), before = inputHash(db,'2026-06'), plan = saveVacationPlan(db,input())
    expect(db.vacationPlans).toHaveLength(1)
    expect(activeVersion(db,'2026-06')?.cells[key('e0','2026-06-02')]).toMatchObject({kind:'vacation',locked:true,planId:plan.id})
    expect(inputHash(db,'2026-06')).not.toBe(before)
    expect(newVersion(db,'2026-06').vacationPlans).toEqual([plan])
  })
  it.each(['fill','rebuild'] as const)('%s模式保留两类假期，即使人工错误取消了锁定',mode => {
    const db = fixture(); saveVacationPlan(db,input()); adjustCell(db,'e1','2026-06-02',{kind:'leave',locked:false,source:'manual'})
    const v = generate(db,'2026-06',mode,1).version
    expect(v.cells[key('e0','2026-06-02')]?.kind).toBe('vacation')
    expect(v.cells[key('e1','2026-06-02')]?.kind).toBe('leave')
  })
  it('请假覆盖休假显示，修改与取消休假仍保留事后请假',() => {
    const db = fixture(), p = saveVacationPlan(db,input()); adjustCell(db,'e0','2026-06-02',{kind:'leave',source:'manual',locked:true,note:'突发请假'})
    saveVacationPlan(db,{...input(['2026-06-02','2026-06-04']),id:p.id})
    const v = activeVersion(db,'2026-06')!
    expect(v.cells[key('e0','2026-06-02')]?.kind).toBe('leave')
    expect(v.cells[key('e0','2026-06-03')]?.kind).toBe('unassigned')
    removeVacationPlan(db,p.id)
    expect(v.cells[key('e0','2026-06-02')]?.kind).toBe('leave')
    expect(v.cells[key('e0','2026-06-04')]?.kind).toBe('unassigned')
  })
  it('撤销请假恢复原预定休假；没有计划则按开班日恢复可用',() => {
    const db = fixture(); saveVacationPlan(db,input())
    for (const date of ['2026-06-02','2026-06-05','2026-06-06']) {adjustCell(db,'e0',date,{kind:'leave',locked:true,source:'manual'}); cancelLeave(db,'e0',date)}
    const v = activeVersion(db,'2026-06')!
    expect(v.cells[key('e0','2026-06-02')]?.kind).toBe('vacation')
    expect(v.cells[key('e0','2026-06-05')]?.kind).toBe('unassigned')
    expect(v.cells[key('e0','2026-06-06')]?.kind).toBe('rest')
  })
  it('确认后的修改生成修订草稿，不改变原版本计划和单元格',() => {
    const db = fixture(), p = saveVacationPlan(db,input()), original = activeVersion(db,'2026-06')!
    original.status = 'confirmed'
    saveVacationPlan(db,{...input(['2026-06-04']),id:p.id})
    const revised = activeVersion(db,'2026-06')!
    expect(revised.id).not.toBe(original.id); expect(revised.parentId).toBe(original.id)
    expect(original.vacationPlans![0]!.dates).toEqual(['2026-06-02','2026-06-03'])
    expect(original.cells[key('e0','2026-06-02')]?.kind).toBe('vacation')
    expect(revised.cells[key('e0','2026-06-02')]?.kind).toBe('unassigned')
  })
  it('逐日取消与非连续休假不会扩展日期，取消不会在下一次生成复活',() => {
    const db = fixture(), p = saveVacationPlan(db,input(['2026-06-02','2026-06-04']))
    removeVacationPlan(db,p.id,'2026-06-02')
    expect(db.vacationPlans[0]!.dates).toEqual(['2026-06-04'])
    const v = generate(db,'2026-06','rebuild',1).version
    expect(v.cells[key('e0','2026-06-02')]?.kind).not.toBe('vacation')
    expect(v.cells[key('e0','2026-06-04')]?.kind).toBe('vacation')
  })
  it('重复日期、跨月、离职后和空日期在保存前被拒绝',() => {
    const db = fixture(); saveVacationPlan(db,input())
    expect(() => saveVacationPlan(db,input(['2026-06-02']))).toThrow('已有预定休假')
    expect(() => saveVacationPlan(db,input(['2026-07-01']))).toThrow('当月')
    expect(() => saveVacationPlan(db,input([]))).toThrow('至少一天')
    db.employees[0]!.to = '2026-06-20'
    expect(() => saveVacationPlan(db,input(['2026-06-20']))).toThrow('当月')
    expect(() => adjustCell(db,'e0','2026-06-02',{kind:'shift',shiftId:'red-early',locked:true,source:'manual'})).toThrow('调整休假计划')
  })
  it('休假与请假人天互斥统计，不计出勤也不计未分配',() => {
    const db = fixture(); saveVacationPlan(db,input()); adjustCell(db,'e0','2026-06-02',{kind:'leave',locked:true,source:'manual'})
    const row = employeeStatistics(db,activeVersion(db,'2026-06')!)[0]!
    expect(row.vacation).toBe(1); expect(row.leave).toBe(1); expect(row.work).toBe(0)
    expect(row.empty + row.rest + row.vacation + row.leave + row.work).toBe(30)
    expect(db.vacationPlans[0]!.dates).toHaveLength(2)
  })
  it('休假默认不切段且扣除可工作日，开启切段规则后可切段',() => {
    const db = fixture(); saveVacationPlan(db,input(['2026-06-03','2026-06-06','2026-06-07'])); const v = activeVersion(db,'2026-06')!, e = db.employees[0]!
    for (const date of ['2026-06-01','2026-06-02','2026-06-04','2026-06-05']) v.cells[key('e0',date)] = {kind:'shift',shiftId:'red-early',locked:false,source:'auto'}
    expect(workSegments(db,v,e).find(s => s.start === '2026-06-01')?.end).toBe('2026-06-05')
    expect(completedSegments(db,v,e).find(s => s.start === '2026-06-01')?.days).toBe(4)
    v.ruleSettings.leaveSplits = true
    expect(workSegments(db,v,e).find(s => s.start === '2026-06-01')?.end).toBe('2026-06-02')
  })
  it('新版备份可往返读取，旧版格式直接拒绝',() => {
    const db = fixture(); saveVacationPlan(db,input())
    expect(parseDatabase(JSON.parse(JSON.stringify(db)))).toEqual(db)
    expect(() => parseDatabase({...db,schema:1})).toThrow('不支持的备份格式')
    const bad = structuredClone(db); bad.versions[0]!.vacationPlans[0]!.dates = ['2026-07-01']
    expect(() => parseDatabase(bad)).toThrow('休假计划')
  })
})
