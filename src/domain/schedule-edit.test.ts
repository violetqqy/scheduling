import { describe, expect, it } from 'vitest'
import type { Cell, Version } from './types'
import { activeVersion, effectiveCell, emptyDatabase, key, newVersion } from './model'
import { adjustCell, saveVacationPlan } from './absences'
import { applyScheduleSelection, clearMonthSchedule, selectableScheduleTargets } from './schedule-edit'
import { generate } from './scheduler'
import { coverage, validate } from './validation'
import { parseDatabase } from '../services/storage'

function fixture() {
  const db=emptyDatabase()
  db.employees=Array.from({length:18},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-10-01',to:'',note:''}))
  const version=newVersion(db,'2026-11');db.versions.push(version);db.activeVersions[version.month]=version.id
  return {db,version}
}
const shift:Cell={kind:'shift',shiftId:'red-early',locked:true,source:'manual',note:'保留原因'}
const target=(employeeId='e0',date='2026-11-02')=>({employeeId,date})
const mount=(db:ReturnType<typeof emptyDatabase>,v:Version)=>{db.versions.push(v);db.activeVersions[v.month]=v.id;return v}

describe('清空当月排班',()=>{
  it.each(['draft','confirmed','imported'] as const)('从%s建立清空子草稿，保留原班表和其他月份',status=>{
    const {db,version}=fixture();version.status=status
    version.cells[key('e0','2026-11-02')]=shift
    version.cells[key('e1','2026-11-02')]={...shift,locked:false,source:'auto'}
    version.cells[key('e2','2026-11-02')]={...shift,source:'import'}
    const other=mount(db,newVersion(db,'2026-12'));other.cells[key('e0','2026-12-01')]=shift
    const before=structuredClone(version),otherBefore=structuredClone(other)
    const result=clearMonthSchedule(db,'2026-11',version.id)
    expect(result.cleared).toBe(3);expect(result.version.status).toBe('draft');expect(result.version.parentId).toBe(version.id)
    expect(Object.values(result.version.cells).some(c=>c.kind==='shift')).toBe(false)
    expect(version).toEqual(before);expect(other).toEqual(otherBefore)
    expect(activeVersion(db,'2026-11')?.id).toBe(result.version.id)
    expect(parseDatabase(JSON.parse(JSON.stringify(db)))).toEqual(db)
  })
  it('清空保留调休日历、需求快照、个人休息、两类假期及计划，并可重新生成',()=>{
    const {db}=fixture();db.calendar['2026-11-07']=true
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-03'],reason:'预定休假'})
    adjustCell(db,'e1','2026-11-03',{kind:'leave',locked:true,source:'manual',note:'请假'})
    adjustCell(db,'e2','2026-11-04',{kind:'rest',locked:true,source:'manual',note:'个人调休'})
    const filled=mount(db,generate(db,'2026-11','rebuild',2).version)
    const before=structuredClone(filled),plans=structuredClone(db.vacationPlans)
    const {version}=clearMonthSchedule(db,'2026-11',filled.id)
    expect(version.calendar).toEqual(before.calendar);expect(version.requirements).toEqual(before.requirements)
    expect(db.vacationPlans).toEqual(plans);expect(version.vacationPlans).toEqual(before.vacationPlans)
    for(const [k,c] of Object.entries(before.cells).filter(([,c])=>c.kind!=='shift'))expect(version.cells[k]).toEqual(c)
    const rebuilt=generate(db,'2026-11','rebuild',2).version
    expect(rebuilt.cells[key('e0','2026-11-03')]?.kind).toBe('vacation')
    expect(rebuilt.cells[key('e1','2026-11-03')]?.kind).toBe('leave')
    expect(rebuilt.cells[key('e2','2026-11-04')]?.kind).toBe('rest')
    expect(coverage(db,rebuilt).some(r=>r.actual>0)).toBe(true)
  })
  it('拒绝过期版本和空班表，不产生多余版本',()=>{
    const {db,version}=fixture(),before=structuredClone(db)
    expect(()=>clearMonthSchedule(db,'2026-11','old-version')).toThrow('版本已变化')
    expect(()=>clearMonthSchedule(db,'2026-11',version.id)).toThrow('没有可清空')
    expect(db).toEqual(before)
  })
})

describe('多选排班调整与锁定',()=>{
  it('选择入口允许所有状态与日历休息，重复格仍去重',()=>{
    const {db,version}=fixture()
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-03'],reason:'年假'})
    adjustCell(db,'e1','2026-11-03',{kind:'leave',locked:true,source:'manual'})
    adjustCell(db,'e2','2026-11-03',{kind:'rest',locked:true,source:'manual'})
    adjustCell(db,'e3','2026-11-03',{kind:'overtime',locked:true,source:'manual'})
    version.cells[key('e5','2026-11-03')]=shift
    // Missing snapshot cells must not make calendar rest or an independent plan selectable.
    delete version.cells[key('e0','2026-11-01')]
    delete version.cells[key('e0','2026-11-03')]
    const targets=[target('e0','2026-11-01'),...Array.from({length:6},(_,i)=>target(`e${i}`,'2026-11-03'))]
    expect(selectableScheduleTargets(db,version,[...targets,targets.at(-1)!])).toEqual(targets)
    expect(selectableScheduleTargets(db,version,[])).toEqual([])
  })
  it('整月、整行和整列覆盖全部自然日，不跳过休假和休息',()=>{
    const {db,version}=fixture()
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'年假'})
    const all=Array.from({length:30},(_,i)=>`2026-11-${String(i+1).padStart(2,'0')}`).flatMap(date=>['e0','e1'].map(employeeId=>({employeeId,date})))
    const selected=selectableScheduleTargets(db,version,all)
    expect(selected).toHaveLength(60)
    expect(selected.filter(t=>t.employeeId==='e0')).toHaveLength(30)
    expect(selected.filter(t=>t.date==='2026-11-02')).toEqual([target('e0'),target('e1')])
    expect(selectableScheduleTargets(db,version,all.filter(t=>t.date==='2026-11-01'))).toHaveLength(2)
  })
  it('跨员工、不连续日期批量改班且默认可锁定，重复选择只处理一次',()=>{
    const {db,version}=fixture()
    const result=applyScheduleSelection(db,'2026-11',version.id,[target(),target('e1'),target('e0','2026-11-05'),target()],{type:'adjust',cell:shift})
    expect(result.changed).toBe(3)
    for(const t of [target(),target('e1'),target('e0','2026-11-05')])expect(version.cells[key(t.employeeId,t.date)]).toEqual(shift)
    expect(version.cells[key('e0','2026-11-04')]).toBeUndefined()
    expect(validate(db,version).some(i=>i.rule==='H02')).toBe(true)
  })
  it('批量可改个人休息、全局休息、预定休假、事后请假，计划不变',()=>{
    const {db,version}=fixture()
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-03'],reason:'年假'})
    adjustCell(db,'e1','2026-11-03',{kind:'leave',locked:true,source:'manual'})
    adjustCell(db,'e2','2026-11-03',{kind:'rest',locked:true,source:'manual'})
    const targets=[target(),target('e0','2026-11-03'),target('e1','2026-11-03'),target('e2','2026-11-03'),target('e0','2026-11-01')]
    const before=structuredClone(db.vacationPlans)
    expect(applyScheduleSelection(db,'2026-11',version.id,targets,{type:'adjust',cell:shift})).toEqual({changed:5,protected:0,skipped:0})
    for(const t of targets)expect(version.cells[key(t.employeeId,t.date)]).toEqual(shift)
    expect(db.vacationPlans).toEqual(before)
  })
  it('批量锁定只作用于班次，重排保留人工锁定，解锁不改变原班次和原因',()=>{
    const {db,version}=fixture()
    for(const id of ['e0','e1'])version.cells[key(id,'2026-11-02')]={...shift,locked:false,source:'auto'}
    const targets=[target(),target('e1'),target('e2'),target('e0','2026-11-01')]
    expect(applyScheduleSelection(db,'2026-11',version.id,targets,{type:'lock',locked:true}).changed).toBe(2)
    const rebuilt=generate(db,'2026-11','rebuild',1).version
    expect(rebuilt.cells[key('e0','2026-11-02')]).toEqual(shift)
    applyScheduleSelection(db,'2026-11',version.id,targets,{type:'lock',locked:false})
    expect(version.cells[key('e0','2026-11-02')]).toEqual({...shift,locked:false})
    expect(effectiveCell(db,version,db.employees[0]!,'2026-11-01')).toMatchObject({kind:'rest',locked:true})
  })
  it('已确认版本的批量修改建立修订草稿，原版本不变',()=>{
    const {db,version}=fixture();version.cells[key('e0','2026-11-02')]={...shift,locked:false};version.status='confirmed'
    const before=structuredClone(version)
    applyScheduleSelection(db,'2026-11',version.id,[target()],{type:'lock',locked:true})
    expect(version).toEqual(before)
    expect(activeVersion(db,'2026-11')).toMatchObject({parentId:version.id,status:'draft'})
    expect(activeVersion(db,'2026-11')!.cells[key('e0','2026-11-02')]?.locked).toBe(true)
  })
  it('范围中任一日期非法、跨月或员工不存在时整批拒绝',()=>{
    const {db,version}=fixture();db.employees[1]!.to='2026-11-02'
    const before=structuredClone(db)
    for(const bad of [target('e0','2026-12-01'),target('e0','2026-11-31'),target('missing')])expect(()=>applyScheduleSelection(db,'2026-11',version.id,[target(),bad],{type:'adjust',cell:shift})).toThrow('选择范围')
    expect(db).toEqual(before)
  })
  it('拒绝空选择、过期版本和未知班次，但允许停用班次、预定休假及任职期外人工调整',()=>{
    const {db,version}=fixture();db.shifts[0]!.enabled=false;db.employees[0]!.to='2026-11-01'
    expect(()=>applyScheduleSelection(db,'2026-11',version.id,[],{type:'lock',locked:true})).toThrow('请先选择')
    expect(()=>applyScheduleSelection(db,'2026-11','stale',[target()],{type:'adjust',cell:shift})).toThrow('版本已变化')
    expect(()=>applyScheduleSelection(db,'2026-11',version.id,[target()],{type:'adjust',cell:{...shift,shiftId:'missing'}})).toThrow('有效的班次')
    applyScheduleSelection(db,'2026-11',version.id,[target()],{type:'adjust',cell:shift})
    expect(version.cells[key('e0','2026-11-02')]).toEqual(shift)
    expect(validate(db,version).some(i=>i.rule==='H03')).toBe(true)
    applyScheduleSelection(db,'2026-11',version.id,[target()],{type:'adjust',cell:{kind:'vacation',locked:true,source:'manual'}})
    expect(version.cells[key('e0','2026-11-02')]?.kind).toBe('vacation')
    expect(db.vacationPlans).toEqual([])
  })
  it('批量清除所选班次后保留可用状态，可由补空位重新安排',()=>{
    const {db,version}=fixture();version.cells[key('e0','2026-11-02')]=shift
    applyScheduleSelection(db,'2026-11',version.id,[target()],{type:'adjust',cell:{kind:'unassigned',source:'manual',locked:true}})
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'unassigned',locked:false})
    const filled=generate(db,'2026-11','fill',1).version
    expect(filled.cells[key('e0','2026-11-02')]?.kind).toBe('shift')
  })
})
