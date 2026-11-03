import { describe, expect, it } from 'vitest'
import { emptyDatabase, activeVersion, inputHash, key, newVersion, sourceVersion, workSegments } from './model'
import { generate } from './scheduler'
import { validate, coverage } from './validation'
import { adjustCell, saveVacationPlan } from './absences'
import { daysInMonth } from './dates'
function fixture(count=18) {
  const db = emptyDatabase()
  db.employees = Array.from({length:count},(_,i) => ({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'',to:'',note:''}))
  return db
}
const mount = (db:ReturnType<typeof fixture>,v:ReturnType<typeof newVersion>) => {db.versions.push(v);db.activeVersions[v.month]=v.id;return v}
describe('无上月记录时首次排班',() => {
  it('月初在周中时也排满首段，历史缺失只提示而不阻止确认',() => {
    const db=fixture(16),result=generate(db,'2026-07','rebuild',2),v=result.version
    expect(v.historyMode).toBe('initial'); expect(v.sourceVersionId).toBeUndefined()
    expect(coverage(db,v).filter(r => r.expected).every(r => r.actual===2)).toBe(true)
    expect(validate(db,v).filter(i => i.level==='error')).toEqual([])
    expect(result.issues.find(i => i.rule==='HISTORY')?.level).toBe('warning')
    expect(workSegments(db,v,db.employees[0]!)[0]).toMatchObject({start:'2026-07-01',end:'2026-07-03',bounded:true})
    expect(v.inputHash).toBe(inputHash(db,'2026-07'))
  })
  it('有更早月份但没有紧邻上月时也使用首次规则，不制造光子转白欠班',() => {
    const db=fixture(16),may=mount(db,newVersion(db,'2026-05'))
    for (const d of ['2026-05-04','2026-05-05','2026-05-06','2026-05-07','2026-05-08']) may.cells[key('e0',d)]={kind:'shift',shiftId:'photon',locked:true,source:'import'}
    const result=generate(db,'2026-07','rebuild',1)
    expect(result.version.historyMode).toBe('initial');expect(result.debts).toEqual([])
    expect(validate(db,result.version).some(i => i.rule==='H05')).toBe(false)
    expect(coverage(db,result.version).filter(r => r.expected).every(r => r.actual===2)).toBe(true)
  })
  it('首次排班仍保护休假、请假、休息与锁定，并支持手工调整及再次补空位',() => {
    const db=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-07',dates:['2026-07-02'],reason:'预定休假'})
    adjustCell(db,'e1','2026-07-02',{kind:'leave',source:'manual',locked:true})
    adjustCell(db,'e2','2026-07-06',{kind:'rest',source:'manual',locked:true})
    adjustCell(db,'e3','2026-07-01',{kind:'shift',shiftId:'orange-early',source:'manual',locked:true})
    const v=mount(db,generate(db,'2026-07','rebuild',2).version)
    expect(v.cells[key('e0','2026-07-02')]?.kind).toBe('vacation');expect(v.cells[key('e1','2026-07-02')]?.kind).toBe('leave')
    expect(v.cells[key('e2','2026-07-06')]?.kind).toBe('rest');expect(v.cells[key('e3','2026-07-01')]?.shiftId).toBe('orange-early')
    adjustCell(db,'e4','2026-07-09',{kind:'shift',shiftId:'red-late',source:'manual',locked:true,note:'人工调整'})
    expect(generate(db,'2026-07','fill',1).version.cells[key('e4','2026-07-09')]).toMatchObject({shiftId:'red-late',note:'人工调整',locked:true})
    expect(activeVersion(db,'2026-07')?.id).toBe(v.id)
  })
  it('首次模式不能放宽每天两人配对，15人仍报告缺口且不允许确认',() => {
    const db=fixture(15),v=generate(db,'2026-07','rebuild',1).version
    expect(validate(db,v).some(i => i.rule==='H02' && i.level==='error')).toBe(true)
    expect(coverage(db,v).every(r => r.actual<=r.expected)).toBe(true)
  })
  it('后补上月历史不会改变已保存首次版本的起点，重新生成才使用新历史',() => {
    const db=fixture(16),july=mount(db,generate(db,'2026-07','rebuild',1).version)
    const before=workSegments(db,july,db.employees[0]!);mount(db,newVersion(db,'2026-06'))
    expect(sourceVersion(db,july)).toBeUndefined();expect(workSegments(db,july,db.employees[0]!)).toEqual(before)
    expect(inputHash(db,'2026-07')).not.toBe(july.inputHash)
    expect(generate(db,'2026-07','rebuild',1).version.historyMode).toBe('reference')
  })
  it('没有目标月在职员工时明确拒绝生成，不保存伪班表',() => {
    const db=fixture(0);expect(() => generate(db,'2026-07')).toThrow('没有在职员工')
    const other=fixture();for (const e of other.employees) e.from='2026-08-01'
    expect(() => generate(other,'2026-07')).toThrow('没有在职员工')
    expect(db.versions).toEqual([])
  })
  it('首月之后仍按上月续段，首次模式不传播到下个月',() => {
    const db=fixture(16),july=mount(db,generate(db,'2026-07','rebuild',1).version)
    const august=generate(db,'2026-08','rebuild',1).version
    expect(august.historyMode).toBe('reference');expect(august.sourceVersionId).toBe(july.id)
    for (const e of db.employees) for (const d of daysInMonth('2026-08').slice(2,3)) expect(august.cells[key(e.id,d)]?.kind).toBe('shift')
  })
})
