import { describe, expect, it } from 'vitest'
import type { Cell, Version } from './types'
import { emptyDatabase, key, newVersion, workSegments } from './model'
import { nextRotationCategory, rotationCategory } from './rotation'
import { generate } from './scheduler'
import { coverage, validate } from './validation'

function fixture(count=18){const db=emptyDatabase();db.employees=Array.from({length:count},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}));return db}
function mount(db:ReturnType<typeof fixture>,v:Version){db.versions.push(v);db.activeVersions[v.month]=v.id;return v}
const shift=(shiftId:string,locked=false):Cell=>({kind:'shift',shiftId,locked,source:locked?'manual':'auto'})
const following:Record<string,string>={早:'中',中:'晚',晚:'早'}

describe('红黄房间早中晚循环',()=>{
  it.each([16,18])('%i人整月按工作段循环，保持八班两人和段内同班',count=>{
    const db=fixture(count),v=generate(db,'2026-11','rebuild',4).version
    let checked=0
    for(const employee of db.employees){
      const sequence=workSegments(db,v,employee).flatMap(segment=>{
        const ids=[...new Set(segment.dates.map(date=>v.cells[key(employee.id,date)]).filter(c=>c?.kind==='shift').map(c=>c!.shiftId))]
        expect(ids.length).toBeLessThanOrEqual(1)
        const category=rotationCategory(db,ids[0]?shift(ids[0]):undefined)
        return category?[category]:[]
      })
      for(let i=1;i<sequence.length;i++){expect(sequence[i]).toBe(following[sequence[i-1]!]);checked++}
    }
    expect(checked).toBeGreaterThan(10)
    expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
    expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
  })

  it('红早之后即使切到黄房间也必须中班，房间不重置轮转',()=>{
    const db=fixture(),previous=mount(db,newVersion(db,'2026-10'))
    previous.cells[key('e0','2026-10-30')]=shift('red-early')
    const v=newVersion(db,'2026-11')
    expect(nextRotationCategory(db,v,'e0','2026-11-02')).toBe('中')
    v.cells[key('e0','2026-11-02')]=shift('orange-middle')
    expect(nextRotationCategory(db,v,'e0','2026-11-09')).toBe('晚')
    v.cells[key('e0','2026-11-09')]=shift('red-late')
    expect(nextRotationCategory(db,v,'e0','2026-11-16')).toBe('早')
  })

  it('白班、光子、自定义、休假和未分配不推进或重置普通班轮转',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-02')]=shift('red-early')
    for(const [date,cell] of [
      ['2026-11-09',shift('blue-day')],['2026-11-16',shift('photon')],
      ['2026-11-17',{kind:'custom',customName:'培训',source:'manual',locked:true}],
      ['2026-11-18',{kind:'vacation',source:'manual',locked:true}],
      ['2026-11-19',{kind:'unassigned',source:'manual',locked:false}],
    ] as [string,Cell][])v.cells[key('e0',date)]=cell
    expect(nextRotationCategory(db,v,'e0','2026-11-23')).toBe('中')
    expect(nextRotationCategory(db,v,'e1','2026-11-23')).toBeUndefined()
  })

  it('4天和6天工作段各只推进一次，日数不会变成轮转次数',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.calendar['2026-11-06']=false;v.calendar['2026-11-14']=true
    for(const date of ['02','03','04','05'])v.cells[key('e0',`2026-11-${date}`)]=shift('red-early')
    expect(nextRotationCategory(db,v,'e0','2026-11-09')).toBe('中')
    for(let day=9;day<=14;day++)v.cells[key('e0',`2026-11-${String(day).padStart(2,'0')}`)]=shift('orange-middle')
    expect(nextRotationCategory(db,v,'e0','2026-11-16')).toBe('晚')
  })

  it('跨月续完原早班段后才推进到中班，不在月初再次计步',()=>{
    const db=fixture(),previous=mount(db,newVersion(db,'2026-06'))
    for(const id of ['e0','e1'])for(const date of ['2026-06-29','2026-06-30'])previous.cells[key(id,date)]=shift('red-early')
    const v=generate(db,'2026-07','rebuild',2).version
    for(const date of ['01','02','03'])expect(v.cells[key('e0',`2026-07-${date}`)]?.shiftId).toBe('red-early')
    expect(nextRotationCategory(db,v,'e0','2026-07-06')).toBe('中')
    const ordinary=Object.entries(v.cells).filter(([k,c])=>k.startsWith('e0|') && k.split('|')[1]!>='2026-07-06' && rotationCategory(db,c)).sort(([a],[b])=>a.localeCompare(b))[0]
    expect(rotationCategory(db,ordinary?.[1])).toBe('中')
    expect(validate(db,v).some(i=>i.rule==='H07' && i.employeeId==='e0')).toBe(false)
  })

  it.each(['fill','rebuild'] as const)('%s保留违序人工锁定，报告冲突但不自动延长错误班段',mode=>{
    const db=fixture(),base=mount(db,newVersion(db,'2026-11'))
    for(let day=2;day<=6;day++)base.cells[key('e0',`2026-11-0${day}`)]=shift('red-early',true)
    base.cells[key('e0','2026-11-09')]=shift('orange-early',true)
    const result=generate(db,'2026-11',mode,1)
    expect(result.version.cells[key('e0','2026-11-09')]).toEqual(base.cells[key('e0','2026-11-09')])
    expect(result.issues.some(i=>i.rule==='H07' && i.employeeId==='e0' && i.date==='2026-11-09')).toBe(true)
    expect(result.version.cells[key('e0','2026-11-10')]?.kind).not.toBe('shift')
  })

  it('需要中班但中班停用时保留缺口，不能用连续早班补位',()=>{
    const db=fixture(2),previous=mount(db,newVersion(db,'2026-10'))
    for(const id of ['e0','e1'])previous.cells[key(id,'2026-10-30')]=shift('red-early')
    db.shifts.forEach(s=>s.enabled=s.id==='red-early')
    const result=generate(db,'2026-11','rebuild',1)
    expect(Object.values(result.version.cells).some(c=>c.kind==='shift')).toBe(false)
    expect(result.issues.some(i=>i.rule==='H02')).toBe(true)
  })

  it('当前段内部休假不切段，已有日期不导致同段提前轮到中班',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-02')]=shift('red-early')
    v.cells[key('e0','2026-11-03')]={kind:'vacation',source:'manual',locked:true}
    expect(nextRotationCategory(db,v,'e0','2026-11-02')).toBeUndefined()
    expect(nextRotationCategory(db,v,'e0','2026-11-09')).toBe('中')
  })

  it.each(['red-early','orange-middle','red-late'])('相邻工作段重复%s会产生轮转冲突',shiftId=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-02')]=shift(shiftId,true)
    v.cells[key('e0','2026-11-09')]=shift(shiftId,true)
    expect(validate(db,v).some(i=>i.rule==='H07' && i.employeeId==='e0' && i.date==='2026-11-09')).toBe(true)
  })

  it('工作日历休息日上的人工普通班不算新的工作段，不推进轮转',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    v.cells[key('e0','2026-11-06')]=shift('red-early')
    v.cells[key('e0','2026-11-07')]=shift('orange-late',true)
    expect(nextRotationCategory(db,v,'e0','2026-11-09')).toBe('中')
  })

  it('连续历史月份里整月没有红黄普通班，仍沿版本链接续最后一次进度',()=>{
    const db=fixture(),sept=mount(db,newVersion(db,'2026-09'))
    sept.cells[key('e0','2026-09-25')]=shift('red-early')
    const october=mount(db,newVersion(db,'2026-10'))
    october.cells[key('e0','2026-10-30')]=shift('blue-day')
    const november=newVersion(db,'2026-11')
    expect(nextRotationCategory(db,november,'e0','2026-11-02')).toBe('中')
  })

  it('历史版本沿用旧规则快照，首次模式不引用后来补入的上月',()=>{
    const db=fixture(),v=newVersion(db,'2026-11')
    delete v.ruleSettings.redYellowOrder
    v.cells[key('e0','2026-11-02')]=shift('red-early')
    v.cells[key('e0','2026-11-09')]=shift('orange-early')
    expect(validate(db,v).some(i=>i.rule==='H07')).toBe(false)
    const previous=mount(db,newVersion(db,'2026-10'));previous.cells[key('e0','2026-10-30')]=shift('red-late')
    expect(nextRotationCategory(db,v,'e0','2026-11-02')).toBeUndefined()
    v.ruleSettings.redYellowOrder=true
    expect(validate(db,v).some(i=>i.rule==='H07')).toBe(true)
  })
})
