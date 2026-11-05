import { describe, expect, it } from 'vitest'
import type { Cell } from './types'
import { adjustCell } from './absences'
import { completedSegments, emptyDatabase, key, workSegments } from './model'
import { generate } from './scheduler'
import { coverage, validate } from './validation'
import { parseDatabase } from '../services/storage'

function fixture(){
  const db=emptyDatabase();db.employees=Array.from({length:16},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}))
  const v=generate(db,'2026-11','rebuild',2).version;db.versions.push(v);db.activeVersions[v.month]=v.id
  const find=(id:string)=>db.employees.find(e=>v.cells[key(e.id,'2026-11-02')]?.shiftId===id)!
  return {db,v,early:find('red-early'),middle:find('red-middle'),orange:find('orange-early')}
}
const manual=(shiftId:string):Cell=>({kind:'shift',shiftId,source:'manual',locked:true})

describe('人工允许混班，自动段内同班',()=>{
  it.each(['2026-11-02','2026-11-06'])('%s互换一天早中班，逐日2人即可保存确认，混班只提醒',date=>{
    const {db,v,early,middle}=fixture()
    adjustCell(db,early.id,date,manual('red-middle'));adjustCell(db,middle.id,date,manual('red-early'))
    expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
    const issues=validate(db,v)
    expect(issues.filter(i=>i.level==='error')).toEqual([])
    expect(issues.filter(i=>i.rule==='P05').length).toBeGreaterThanOrEqual(2)
    expect(completedSegments(db,v,early).find(s=>s.start==='2026-11-02')).toMatchObject({category:'早',credited:true})
    expect(completedSegments(db,v,middle).find(s=>s.start==='2026-11-02')).toMatchObject({category:'中',credited:true})
  })

  it('仅改一个人导致原班1人新班3人时仍报告硬冲突',()=>{
    const {db,v,early}=fixture();adjustCell(db,early.id,'2026-11-02',manual('red-middle'))
    expect(validate(db,v).some(i=>i.rule==='H02' && i.level==='error')).toBe(true)
    expect(validate(db,v).some(i=>i.rule==='P05')).toBe(true)
  })

  it('早班内部对调红橙房间也允许人工混段，仍保持每天配对',()=>{
    const {db,v,early,orange}=fixture()
    adjustCell(db,early.id,'2026-11-04',manual('orange-early'));adjustCell(db,orange.id,'2026-11-04',manual('red-early'))
    expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
    expect(validate(db,v).filter(i=>i.rule==='P05').length).toBeGreaterThanOrEqual(2)
  })

  it('没有人工调整依据的自动混班仍是H04硬冲突',()=>{
    const {db,v,early}=fixture();v.cells[key(early.id,'2026-11-02')]={kind:'shift',shiftId:'red-middle',source:'auto',locked:false}
    expect(validate(db,v).some(i=>i.rule==='H04' && i.level==='error' && i.employeeId===early.id)).toBe(true)
  })

  it.each(['fill','rebuild'] as const)('%s保留已锁定的人工混班，新的自动工作段仍同房间同班',mode=>{
    const {db,v,early,middle}=fixture()
    for(const employee of [early,middle])for(const date of ['02','03','04','05','06'].map(d=>`2026-11-${d}`))adjustCell(db,employee.id,date,manual(v.cells[key(employee.id,date)]!.shiftId!))
    adjustCell(db,early.id,'2026-11-02',manual('red-middle'));adjustCell(db,middle.id,'2026-11-02',manual('red-early'))
    const next=generate(db,v.month,mode,2).version
    for(const e of db.employees)for(const s of workSegments(db,next,e)){
      const cells=s.dates.filter(d=>d.startsWith(next.month)).map(d=>next.cells[key(e.id,d)]).filter(c=>c?.kind==='shift')
      if(s.start==='2026-11-02' && [early.id,middle.id].includes(e.id))expect(cells.every(c=>c!.source==='manual' && c!.locked)).toBe(true)
      else expect(new Set(cells.map(c=>c!.shiftId)).size).toBeLessThanOrEqual(1)
    }
    expect(validate(db,next).some(i=>i.rule==='H04')).toBe(false)
  })

  it('恢复段内同班后移除人工混班标记，JSON保留有效记录',()=>{
    const {db,v,early}=fixture();adjustCell(db,early.id,'2026-11-02',manual('red-middle'))
    expect(parseDatabase(JSON.parse(JSON.stringify(db))).versions[0]!.manualMixedSegments).toEqual(v.manualMixedSegments)
    adjustCell(db,early.id,'2026-11-02',manual('red-early'))
    expect(v.manualMixedSegments).not.toContain(`${early.id}:2026-11-02`)
    expect(validate(db,v).some(i=>i.rule==='P05' && i.employeeId===early.id)).toBe(false)
  })

  it('跨月原段内的人工对调，在关联的两个月都仅提醒混班',()=>{
    const db=emptyDatabase();db.employees=Array.from({length:16},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}))
    const june=generate(db,'2026-06').version;db.versions.push(june);db.activeVersions[june.month]=june.id
    const july=generate(db,'2026-07').version;db.versions.push(july);db.activeVersions[july.month]=july.id
    const early=db.employees.find(e=>july.cells[key(e.id,'2026-07-01')]?.shiftId==='red-early')!
    const middle=db.employees.find(e=>july.cells[key(e.id,'2026-07-01')]?.shiftId==='red-middle')!
    adjustCell(db,early.id,'2026-07-01',manual('red-middle'));adjustCell(db,middle.id,'2026-07-01',manual('red-early'))
    expect(validate(db,june).filter(i=>i.level==='error')).toEqual([])
    expect(validate(db,july).filter(i=>i.level==='error')).toEqual([])
    expect(validate(db,june).some(i=>i.rule==='P05')).toBe(true)
    expect(validate(db,july).some(i=>i.rule==='P05')).toBe(true)
    expect(completedSegments(db,june,early).find(s=>s.start==='2026-06-29')).toMatchObject({category:'早',credited:true})
    expect(completedSegments(db,july,early).find(s=>s.start==='2026-06-29')).toMatchObject({category:'早',credited:true})
  })
})
