import { describe, expect, it } from 'vitest'
import type { Cell, Version } from './types'
import { daysInMonth } from './dates'
import { emptyDatabase, key, newVersion, workSegments } from './model'
import { monthlyRooms } from './room-diversity'
import { generate } from './scheduler'
import { saveVacationPlan } from './absences'
import { coverage, validate } from './validation'

function fixture(count=18){const db=emptyDatabase();db.employees=Array.from({length:count},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}));return db}
function mount(db:ReturnType<typeof fixture>,v:Version){db.versions.push(v);db.activeVersions[v.month]=v.id;return v}
const shift=(shiftId:string,locked=false):Cell=>({kind:'shift',shiftId,locked,source:locked?'manual':'auto'})

describe('每人当月房间分散',()=>{
  it.each([16,18])('%i人首次整月分散房间，同时覆盖八班并保持轮转和段内同班',count=>{
    const db=fixture(count),v=generate(db,'2026-11','rebuild',4).version
    for(const e of db.employees){
      expect(monthlyRooms(db,v,e.id).size, e.id).toBeGreaterThanOrEqual(2)
      for(const segment of workSegments(db,v,e))expect(new Set(segment.dates.map(d=>v.cells[key(e.id,d)]).filter(c=>c?.kind==='shift').map(c=>c!.shiftId)).size).toBeLessThanOrEqual(1)
    }
    expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
    expect(validate(db,v).filter(i=>i.level==='error' || i.rule==='P04')).toEqual([])
  })

  it('相反房间偏好使早中晚都倾向橙房间时，月内分散优先',()=>{
    const db=fixture(12),previous=mount(db,newVersion(db,'2026-10'))
    db.shifts.forEach(s=>s.enabled=['red','orange'].includes(s.roomId))
    for(const [date,id] of [['2026-10-02','red-early'],['2026-10-09','red-middle'],['2026-10-30','red-late']])previous.cells[key('e0',date!)]=shift(id!)
    const v=generate(db,'2026-11','rebuild',4).version
    for(const e of db.employees)expect([...monthlyRooms(db,v,e.id).keys()].sort()).toEqual(['orange','red'])
    expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
  })

  it.each(['2027-02','2027-04','2027-07'])('%s不同月长和月初边界仍为每人分散房间',month=>{
    const db=fixture(16),v=generate(db,month,'rebuild',4).version
    expect(db.employees.every(e=>monthlyRooms(db,v,e.id).size>=2)).toBe(true)
    expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
  })

  it('统计按房间ID合并同房间早中晚，不把换班当换房间',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    for(const [date,id] of [['02','red-early'],['09','red-middle'],['16','red-late']])v.cells[key('e0',`2026-11-${date}`)]=shift(id!)
    expect([...monthlyRooms(db,v,'e0')]).toEqual([['red',3]])
    expect(validate(db,v).some(i=>i.rule==='P04' && i.employeeId==='e0')).toBe(true)
    db.rooms.find(r=>r.id==='red')!.name='第一机房'
    expect(validate(db,v).find(i=>i.rule==='P04' && i.employeeId==='e0')?.message).toContain('第一机房')
  })

  it('白班和光子各自算独立房间，非当月普通班不混入',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-02')]=shift('blue-day')
    v.cells[key('e0','2026-11-09')]=shift('photon')
    v.cells[key('e0','2026-10-30')]=shift('red-late')
    expect([...monthlyRooms(db,v,'e0')]).toEqual([['blue',1],['photon',1]])
    expect(validate(db,v).some(i=>i.rule==='P04' && i.employeeId==='e0')).toBe(false)
  })

  it.each(['custom','overtime','vacation','leave','rest','unassigned'] as const)('%s不算房间，不能伪装成已换房间',kind=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-02')]=shift('red-early')
    v.cells[key('e0','2026-11-09')]={kind,shiftId:'orange-middle',customName:'培训',source:'manual',locked:true}
    expect([...monthlyRooms(db,v,'e0').keys()]).toEqual(['red'])
    expect(monthlyRooms(db,v,'e1').size).toBe(0)
    expect(validate(db,v).some(i=>i.rule==='P04' && i.employeeId==='e1')).toBe(false)
  })

  it.each(['fill','rebuild'] as const)('%s保留整月单房间人工锁定，并提示未达成而不偷偷覆盖',mode=>{
    const db=fixture(),base=mount(db,newVersion(db,'2026-11'))
    for(const [index,segment] of workSegments(db,base,db.employees[0]!).entries())for(const date of segment.dates.filter(d=>d.startsWith(base.month)))base.cells[key('e0',date)]=shift(['red-early','red-middle','red-late'][index%3]!,true)
    const result=generate(db,'2026-11',mode,2)
    for(const date of daysInMonth(base.month))expect(result.version.cells[key('e0',date)]).toEqual(base.cells[key('e0',date)])
    expect(result.issues.find(i=>i.rule==='P04' && i.employeeId==='e0')?.level).toBe('warning')
  })

  it('预先知道后面锁定同一房间时，较早可调段就避开它',()=>{
    const db=fixture(),base=mount(db,newVersion(db,'2026-11'))
    for(const date of ['23','24','25','26','27'])base.cells[key('e0',`2026-11-${date}`)]=shift('red-late',true)
    const v=generate(db,'2026-11','rebuild',4).version
    expect(monthlyRooms(db,v,'e0').size).toBeGreaterThanOrEqual(2)
    expect(v.cells[key('e0','2026-11-23')]).toEqual(base.cells[key('e0','2026-11-23')])
  })

  it.each(['fill','rebuild'] as const)('%s遵循原有未锁定班次的保留范围',mode=>{
    const db=fixture(),base=mount(db,newVersion(db,'2026-11'))
    for(const [index,segment] of workSegments(db,base,db.employees[0]!).entries())for(const date of segment.dates.filter(d=>d.startsWith(base.month)))base.cells[key('e0',date)]=shift(['red-early','red-middle','red-late'][index%3]!)
    const result=generate(db,'2026-11',mode,4)
    if(mode==='fill'){
      expect([...monthlyRooms(db,result.version,'e0').keys()]).toEqual(['red'])
      expect(result.issues.some(i=>i.rule==='P04' && i.employeeId==='e0')).toBe(true)
      for(const date of daysInMonth(base.month))expect(result.version.cells[key('e0',date)]).toEqual(base.cells[key('e0',date)])
    }else expect(monthlyRooms(db,result.version,'e0').size).toBeGreaterThanOrEqual(2)
  })

  it('预定休假只剩一段可用时保留计划，不拆段强行达成房间目标',()=>{
    const db=fixture(),dates=daysInMonth('2026-11').filter(d=>d<'2026-11-23' || d==='2026-11-30')
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates,reason:''})
    const result=generate(db,'2026-11','rebuild',2)
    for(const date of dates)expect(result.version.cells[key('e0',date)]?.kind).toBe('vacation')
    expect(monthlyRooms(db,result.version,'e0').size).toBe(1)
    expect(result.issues.some(i=>i.rule==='P04' && i.employeeId==='e0')).toBe(true)
    expect(coverage(db,result.version).every(r=>r.actual===r.expected)).toBe(true)
  })

  it('只开放一个房间时保持覆盖与早中晚循环，明确提示单房间',()=>{
    const db=fixture(6);db.shifts.forEach(s=>s.enabled=s.roomId==='red')
    const result=generate(db,'2026-11','rebuild',2)
    expect(coverage(db,result.version).every(r=>r.actual===r.expected)).toBe(true)
    expect(result.issues.filter(i=>i.level==='error')).toEqual([])
    expect(result.issues.filter(i=>i.rule==='P04')).toHaveLength(6)
    expect(Object.values(result.version.cells).filter(c=>c.kind==='shift').every(c=>c.shiftId!.startsWith('red-'))).toBe(true)
  })

  it('员工月底入职只剩一段时不拆段换房间，也不伪造第二个房间',()=>{
    const db=fixture();db.employees[0]!.from='2026-11-23';db.employees[0]!.to='2026-11-27'
    const result=generate(db,'2026-11','rebuild',2)
    expect(monthlyRooms(db,result.version,'e0').size).toBe(1)
    expect(result.issues.find(i=>i.rule==='P04' && i.employeeId==='e0')?.level).toBe('warning')
  })

  it('跨月原房间优先续完，新段再分散房间',()=>{
    const db=fixture(),previous=mount(db,newVersion(db,'2026-06'))
    for(const id of ['e0','e1'])for(const date of ['2026-06-29','2026-06-30'])previous.cells[key(id,date)]=shift('red-early')
    const v=generate(db,'2026-07','rebuild',4).version
    for(const date of ['01','02','03'])expect(v.cells[key('e0',`2026-07-${date}`)]?.shiftId).toBe('red-early')
    expect(monthlyRooms(db,v,'e0').size).toBeGreaterThanOrEqual(2)
    expect(validate(db,v).some(i=>['H04','H07'].includes(i.rule) && i.employeeId==='e0')).toBe(false)
  })

  it('旧版本快照不追溯加新提示，新建版本固定启用',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    expect(v.ruleSettings.monthlyRoomDiversity).toBe(true)
    v.cells[key('e0','2026-11-02')]=shift('red-early')
    delete v.ruleSettings.monthlyRoomDiversity
    expect(validate(db,v).some(i=>i.rule==='P04')).toBe(false)
  })
})
