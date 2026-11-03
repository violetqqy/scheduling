import { describe, expect, it } from 'vitest'
import { daysInMonth } from './dates'
import { activeVersion, completedSegments, emptyDatabase, getRawCell, key, newVersion, workSegments } from './model'
import { generate } from './scheduler'
import { coverage, validate } from './validation'
import { employeeStatistics, summary } from './statistics'

function fixture(count = 18, month = '2026-06') {
  const db = emptyDatabase()
  db.employees = Array.from({ length: count }, (_, i) => ({ id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:`${month}-01`,to:'',note:'' }))
  return db
}
function mount(db: ReturnType<typeof fixture>, version: ReturnType<typeof newVersion>) { db.versions.push(version); db.activeVersions[version.month] = version.id; return version }

describe('约束排班', () => {
  it('标准月完整覆盖八班，每班恰好两人且同日不重复', () => {
    const db = fixture(16), result = generate(db,'2026-06','rebuild',3)
    expect(coverage(db,result.version).filter(r => r.expected).every(r => r.actual === 2)).toBe(true)
    expect(validate(db,result.version).filter(i => i.level === 'error')).toEqual([])
    for (const date of daysInMonth('2026-06')) {
      const ids = Object.entries(result.version.cells).filter(([k,c]) => k.endsWith(date) && c.kind === 'shift').map(([k]) => k.split('|')[0])
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
  it('重新生成保留请假、个人休息和手工锁定', () => {
    const db = fixture(), base = mount(db,newVersion(db,'2026-06'))
    base.cells[key('e0','2026-06-02')] = { kind:'leave',locked:true,source:'manual' }
    base.cells[key('e1','2026-06-03')] = { kind:'rest',locked:true,source:'manual' }
    base.cells[key('e2','2026-06-01')] = { kind:'shift',shiftId:'orange-early',locked:true,source:'manual' }
    const result = generate(db,'2026-06','rebuild',2)
    for (const [k,c] of Object.entries(base.cells).filter(([,c]) => c.source === 'manual')) expect(result.version.cells[k]).toEqual(c)
    expect(result.version.id).not.toBe(base.id)
  })
  it('补空位保留已有未锁定班次', () => {
    const db = fixture(), base = mount(db,newVersion(db,'2026-06'))
    base.cells[key('e0','2026-06-01')] = { kind:'shift',shiftId:'red-late',locked:false,source:'auto' }
    expect(generate(db,'2026-06','fill',1).version.cells[key('e0','2026-06-01')]?.shiftId).toBe('red-late')
  })
  it('15人不能伪装成16人覆盖，单人班会产生硬冲突', () => {
    const db = fixture(15), result = generate(db,'2026-06','rebuild',1)
    expect(summary(db,result.version).gap).toBeGreaterThan(0)
    expect(validate(db,result.version).some(i => i.rule === 'H02' && i.level === 'error')).toBe(true)
  })
  it('18人不会多排第三人或自动把余人变成休假', () => {
    const db = fixture(18), result = generate(db,'2026-06','rebuild',2), cov = coverage(db,result.version)
    expect(cov.every(r => r.actual <= r.expected)).toBe(true)
    const date = '2026-06-01', cells = db.employees.map(e => result.version.cells[key(e.id,date)])
    expect(cells.filter(c => c?.kind === 'shift')).toHaveLength(16)
    expect(cells.filter(c => c?.kind === 'rest' || c?.kind === 'leave')).toHaveLength(0)
  })
  it('相同输入的候选结果可复现', () => {
    const db = fixture(), a = generate(db,'2026-06','rebuild',2), b = generate(db,'2026-06','rebuild',2)
    expect(a.version.cells).toEqual(b.version.cells)
  })
  it('已锁定超员不会自动删掉锁定项', () => {
    const db = fixture(), base = mount(db,newVersion(db,'2026-06'))
    for (const id of ['e0','e1','e2']) base.cells[key(id,'2026-06-01')] = { kind:'shift',shiftId:'red-early',locked:true,source:'manual' }
    const result = generate(db,'2026-06','rebuild',1)
    expect(coverage(db,result.version).find(r => r.date === '2026-06-01' && r.shiftId === 'red-early')?.actual).toBe(3)
    expect(result.issues.some(i => i.rule === 'H02' && i.date === '2026-06-01')).toBe(true)
  })
  it('停用日期起不生成新班次', () => {
    const db = fixture(); db.employees[0]!.to = '2026-06-10'
    const v = generate(db,'2026-06','rebuild',1).version
    expect(Object.entries(v.cells).filter(([k,c]) => k.startsWith('e0|') && k.split('|')[1]! >= '2026-06-10' && c.kind === 'shift')).toEqual([])
  })
})

describe('工作段、跨月、光子轮换', () => {
  it('连续周末不产生零天段，个人休息可产生4/6天段', () => {
    const db = fixture(), v = newVersion(db,'2026-06'), e = db.employees[0]!
    v.cells[key(e.id,'2026-06-05')] = { kind:'rest',source:'manual',locked:true }
    v.cells[key(e.id,'2026-06-13')] = { kind:'unassigned',source:'manual',locked:false }
    const lengths = workSegments(db,v,e).map(s => s.dates.length)
    expect(lengths).toContain(4); expect(lengths).toContain(6); expect(lengths.every(n => n > 0)).toBe(true)
  })
  it('请假默认不切段，选定规则后可切段', () => {
    const db = fixture(), v = newVersion(db,'2026-06'), e = db.employees[0]!
    v.cells[key(e.id,'2026-06-03')] = { kind:'leave',source:'manual',locked:true }
    expect(workSegments(db,v,e).find(s => s.start === '2026-06-01')?.end).toBe('2026-06-05')
    v.ruleSettings.leaveSplits = true
    expect(workSegments(db,v,e).find(s => s.start === '2026-06-01')?.end).toBe('2026-06-02')
  })
  it('跨月沿用原班，缺失历史不编造续段', () => {
    const db = fixture(18), previous = mount(db,newVersion(db,'2026-06'))
    for (const id of ['e0','e1']) for (const d of ['2026-06-29','2026-06-30']) previous.cells[key(id,d)] = { kind:'shift',shiftId:'red-early',locked:false,source:'auto' }
    const next = generate(db,'2026-07','rebuild',1).version
    for (const d of ['2026-07-01','2026-07-02','2026-07-03']) expect(next.cells[key('e0',d)]?.shiftId).toBe('red-early')
    expect(validate(db,next).some(i => i.rule === 'H04' && i.employeeId === 'e2')).toBe(true)
  })
  it('完整跨月段只归开始月份，天数按月份拆分', () => {
    const db = fixture(), june = mount(db,newVersion(db,'2026-06')), july = mount(db,newVersion(db,'2026-07')), e = db.employees[0]!
    for (const d of ['2026-06-29','2026-06-30']) june.cells[key(e.id,d)] = { kind:'shift',shiftId:'red-early',source:'auto',locked:false }
    for (const d of ['2026-07-01','2026-07-02','2026-07-03']) july.cells[key(e.id,d)] = { kind:'shift',shiftId:'red-early',source:'auto',locked:false }
    expect(completedSegments(db,june,e).filter(s => s.start === '2026-06-29')).toHaveLength(1)
    expect(completedSegments(db,july,e).filter(s => s.start.startsWith('2026-07'))).toHaveLength(0)
    expect(employeeStatistics(db,june)[0]!.work).toBe(2); expect(employeeStatistics(db,july)[0]!.work).toBe(3)
  })
  it('上月完整光子段禁止下月新光子，并创建唯一白班任务', () => {
    const db = fixture(), prev = mount(db,newVersion(db,'2026-06'))
    for (const d of ['2026-06-01','2026-06-02','2026-06-03','2026-06-04','2026-06-05']) prev.cells[key('e0',d)] = { kind:'shift',shiftId:'photon',source:'auto',locked:false }
    const result = generate(db,'2026-07','rebuild',1)
    expect(Object.entries(result.version.cells).some(([k,c]) => k.startsWith('e0|') && c.kind === 'shift' && c.shiftId === 'photon')).toBe(false)
    expect(result.debts.filter(d => d.employeeId === 'e0' && d.category === '白')).toHaveLength(1)
    db.debts.push(...result.debts)
    expect(generate(db,'2026-07','rebuild',1).debts.filter(d => d.employeeId === 'e0')).toHaveLength(0)
  })
  it('光子跨月默认暴露待决定冲突，明确续排后仅允许原段', () => {
    const db = fixture(), prev = mount(db,newVersion(db,'2026-06'))
    for (const d of ['2026-06-29','2026-06-30']) prev.cells[key('e0',d)] = { kind:'shift',shiftId:'photon',source:'auto',locked:false }
    let next = generate(db,'2026-07','rebuild',1).version
    expect(validate(db,next).some(i => i.rule === 'D01' && i.employeeId === 'e0')).toBe(true)
    db.rules.photonCarry = 'continue'; next = generate(db,'2026-07','rebuild',1).version
    expect(validate(db,next).some(i => i.rule === 'D01')).toBe(false)
    expect(next.cells[key('e0','2026-07-01')]?.shiftId).toBe('photon')
  })
  it('历史版本需求快照不随全局开关变化', () => {
    const db = fixture(), v = newVersion(db,'2026-06'); db.shifts[0]!.enabled = false
    expect(coverage(db,v).find(r => r.date === '2026-06-01' && r.shiftId === 'red-early')?.expected).toBe(2)
    expect(activeVersion(db,'2026-06')).toBeUndefined()
  })
  it('目标月固定引用当时的上月版本，切换查看不改变其续段来源', () => {
    const db = fixture(), old = mount(db,newVersion(db,'2026-06'))
    old.cells[key('e0','2026-06-30')] = {kind:'shift',shiftId:'red-early',source:'auto',locked:false}
    const july = newVersion(db,'2026-07'), revised = newVersion(db,'2026-06')
    revised.cells[key('e0','2026-06-30')] = {kind:'shift',shiftId:'orange-late',source:'auto',locked:false}; mount(db,revised)
    expect(getRawCell(db,july,'e0','2026-06-30')?.shiftId).toBe('red-early')
  })
  it('不把来自另一个上月版本的下月段混算成完整段', () => {
    const db = fixture(), june = mount(db,newVersion(db,'2026-06')), july = mount(db,newVersion(db,'2026-07'))
    for (const d of ['2026-06-29','2026-06-30']) june.cells[key('e0',d)] = {kind:'shift',shiftId:'red-early',source:'auto',locked:false}
    for (const d of ['2026-07-01','2026-07-02','2026-07-03']) july.cells[key('e0',d)] = {kind:'shift',shiftId:'red-early',source:'auto',locked:false}
    expect(completedSegments(db,june,db.employees[0]!).some(s => s.start === '2026-06-29')).toBe(true)
    july.sourceVersionId = 'different-june-version'
    expect(completedSegments(db,june,db.employees[0]!).some(s => s.start === '2026-06-29')).toBe(false)
  })
})

describe('统计口径', () => {
  it('15/16人数覆盖与7/8成组达标分开核算', () => {
    const db = fixture(16), v = newVersion(db,'2026-06')
    for (const d of daysInMonth(v.month)) for (const s of db.shifts) v.requirements[`${d}|${s.id}`] = d === '2026-06-01' ? 2 : 0
    for (let i=0;i<15;i++) v.cells[key(`e${i}`,'2026-06-01')] = { kind:'shift',shiftId:db.shifts[Math.floor(i/2)]!.id,source:'auto',locked:false }
    const stats = summary(db,v)
    expect(stats.coverage).toBe(15/16); expect(stats.paired).toBe(7/8); expect(stats.gap).toBe(1)
  })
  it('超额不抵消别的班次缺口，零需求显示空比率', () => {
    const db = fixture(), v = newVersion(db,'2026-06')
    for (const k of Object.keys(v.requirements)) v.requirements[k] = 0
    expect(summary(db,v).coverage).toBeNull(); expect(summary(db,v).paired).toBeNull()
    v.requirements['2026-06-01|red-early'] = 2; v.requirements['2026-06-01|red-late'] = 2
    for (const id of ['e0','e1','e2']) v.cells[key(id,'2026-06-01')] = { kind:'shift',shiftId:'red-early',source:'auto',locked:false }
    v.cells[key('e3','2026-06-01')] = { kind:'shift',shiftId:'red-late',source:'auto',locked:false }
    expect(summary(db,v).gap).toBe(1); expect(summary(db,v).excess).toBe(1); expect(summary(db,v).coverage).toBe(.75)
  })
})
