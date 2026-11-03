import { describe, expect, it } from 'vitest'
import { adjustCell, cancelOvertime, removeVacationPlan, saveVacationPlan } from './absences'
import { activeVersion, completedSegments, emptyDatabase, key, newVersion, workSegments } from './model'
import { applyScheduleSelection, clearMonthSchedule } from './schedule-edit'
import { generate } from './scheduler'
import { coverage, validate } from './validation'
import { assignmentDetails, employeeStatistics } from './statistics'
import { parseDatabase } from '../services/storage'
import { exportWorkbook, previewSheet, readWorkbook } from '../services/excel'
import { applyScheduleImport } from './schedule-import'
import type { Cell } from './types'
const overtime:Cell={kind:'overtime',locked:true,source:'manual',note:'临时加班'}
function fixture() {
  const db=emptyDatabase()
  db.employees=Array.from({length:18},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-11-01',to:'',note:''}))
  const version=newVersion(db,'2026-11');db.versions.push(version);db.activeVersions[version.month]=version.id
  return {db,version}
}
describe('休息与预定休假的月度编辑保护',()=>{
  it('休息日和个人休息不能直接改班或绕道恢复可用，工作日历可解除个人休息',()=>{
    const {db,version}=fixture()
    adjustCell(db,'e0','2026-11-02',{kind:'rest',locked:true,source:'manual',note:'个人调休'})
    for(const date of ['2026-11-01','2026-11-02']) for(const cell of [{kind:'shift' as const,shiftId:'red-early',locked:true,source:'manual' as const},{kind:'unassigned' as const,locked:false,source:'manual' as const}]) expect(()=>adjustCell(db,'e0',date,cell)).toThrow('工作日历')
    expect(version.cells[key('e0','2026-11-02')]?.kind).toBe('rest')
    adjustCell(db,'e0','2026-11-02',{kind:'unassigned',locked:false,source:'manual'},'calendar')
    adjustCell(db,'e0','2026-11-02',{kind:'shift',shiftId:'red-early',locked:true,source:'manual'})
    expect(version.cells[key('e0','2026-11-02')]?.kind).toBe('shift')
  })
  it('预定休假须先在工作日历取消，批量普通改班跳过保护格',()=>{
    const {db,version}=fixture(),plan=saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'预定年假'})
    const shift:Cell={kind:'shift',shiftId:'red-early',locked:true,source:'manual'}
    expect(()=>adjustCell(db,'e0','2026-11-02',shift)).toThrow('工作日历')
    const result=applyScheduleSelection(db,'2026-11',version.id,[{employeeId:'e0',date:'2026-11-02'},{employeeId:'e1',date:'2026-11-02'}],{type:'adjust',cell:shift})
    expect(result).toMatchObject({changed:1,protected:1})
    removeVacationPlan(db,plan.id);adjustCell(db,'e0','2026-11-02',shift)
    expect(version.cells[key('e0','2026-11-02')]).toEqual(shift)
  })
})
describe('加班状态、撤销与自动排班',()=>{
  it('休息日与预定休假可加班，计划继续保留，撤销后恢复原状态及原因',()=>{
    const {db,version}=fixture(),plan=saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'原年假原因'})
    adjustCell(db,'e1','2026-11-03',{kind:'rest',locked:true,source:'manual',note:'原调休原因'})
    for(const [employeeId,date] of [['e0','2026-11-02'],['e0','2026-11-01'],['e1','2026-11-03']])adjustCell(db,employeeId!,date!,overtime)
    expect(db.vacationPlans[0]).toEqual(plan)
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'overtime',locked:true,overtimeBase:{kind:'vacation',planId:plan.id,note:'原年假原因'}})
    expect(()=>adjustCell(db,'e0','2026-11-02',{kind:'shift',shiftId:'red-early',locked:true,source:'manual'})).toThrow('工作日历')
    for(const [employeeId,date] of [['e0','2026-11-02'],['e0','2026-11-01'],['e1','2026-11-03']])cancelOvertime(db,employeeId!,date!)
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'vacation',note:'原年假原因'})
    expect(version.cells[key('e0','2026-11-01')]?.kind).toBe('rest')
    expect(version.cells[key('e1','2026-11-03')]).toMatchObject({kind:'rest',note:'原调休原因'})
  })
  it.each(['fill','rebuild'] as const)('%s保留加班且不占八班人数',mode=>{
    const {db,version}=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'年假'})
    adjustCell(db,'e0','2026-11-02',overtime);adjustCell(db,'e1','2026-11-01',overtime)
    const result=generate(db,'2026-11',mode,2).version
    expect(result.cells[key('e0','2026-11-02')]).toEqual(version.cells[key('e0','2026-11-02')])
    expect(result.cells[key('e1','2026-11-01')]?.kind).toBe('overtime')
    expect(coverage(db,result).filter(r=>r.date==='2026-11-02').reduce((n,r)=>n+r.actual,0)).toBe(16)
    expect(coverage(db,result).filter(r=>r.date==='2026-11-01').reduce((n,r)=>n+r.actual,0)).toBe(0)
    expect(validate(db,result).filter(i=>i.level==='error')).toEqual([])
  })
  it('周末和个人休息上的加班保留休息边界，休假加班不改变完整段归属',()=>{
    const {db,version}=fixture();adjustCell(db,'e0','2026-11-07',overtime)
    expect(workSegments(db,version,db.employees[0]!).find(s=>s.start==='2026-11-02')?.end).toBe('2026-11-06')
    expect(workSegments(db,version,db.employees[0]!).some(s=>s.dates.includes('2026-11-07'))).toBe(false)
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-04'],reason:'休假'})
    adjustCell(db,'e0','2026-11-04',overtime)
    for(const day of ['02','03','05','06'])adjustCell(db,'e0',`2026-11-${day}`,{kind:'shift',shiftId:'red-early',locked:true,source:'manual'})
    expect(completedSegments(db,version,db.employees[0]!).find(s=>s.start==='2026-11-02')).toMatchObject({category:'早',days:4})
  })
  it('批量加班跳过休息、预定休假和请假；休息与休假加班仅通过单格登记',()=>{
    const {db,version}=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'年假'})
    adjustCell(db,'e1','2026-11-02',{kind:'leave',locked:true,source:'manual'})
    const targets=[{employeeId:'e0',date:'2026-11-02'},{employeeId:'e1',date:'2026-11-02'},{employeeId:'e0',date:'2026-11-01'},{employeeId:'e2',date:'2026-11-02'}]
    expect(applyScheduleSelection(db,'2026-11',version.id,targets,{type:'adjust',cell:overtime})).toMatchObject({changed:1,skipped:3})
    expect(version.cells[key('e0','2026-11-02')]?.kind).toBe('vacation')
    expect(version.cells[key('e0','2026-11-01')]?.kind).toBe('rest')
    expect(version.cells[key('e2','2026-11-02')]?.kind).toBe('overtime')
    expect(()=>applyScheduleSelection(db,'2026-11',version.id,targets,{type:'lock',locked:false})).toThrow('没有需要更改')
    expect(()=>adjustCell(db,'e1','2026-11-02',overtime)).toThrow('事后请假')
  })
  it('修改或取消原休假计划不删除加班，撤销加班按最新计划恢复',()=>{
    const {db,version}=fixture(),p=saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'年假'})
    adjustCell(db,'e0','2026-11-02',overtime)
    removeVacationPlan(db,p.id)
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'overtime',overtimeBase:{kind:'unassigned'}})
    const next=saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'新的休假'})
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'overtime',overtimeBase:{planId:next.id}})
    cancelOvertime(db,'e0','2026-11-02')
    expect(version.cells[key('e0','2026-11-02')]).toMatchObject({kind:'vacation',note:'新的休假'})
  })
  it('清空月份时加班恢复原状态，统计不重复计假期，备份可往返',()=>{
    const {db,version}=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'年假'})
    adjustCell(db,'e0','2026-11-02',overtime);adjustCell(db,'e0','2026-11-01',overtime)
    const stats=employeeStatistics(db,version)[0]!
    expect(stats.work).toBe(2);expect(stats.overtime).toBe(2);expect(stats.vacation).toBe(0)
    expect(stats.work+stats.rest+stats.vacation+stats.leave+stats.empty).toBe(30)
    expect(assignmentDetails(db,version,'e0','加班')).toHaveLength(2)
    expect(parseDatabase(JSON.parse(JSON.stringify(db)))).toEqual(db)
    const cleared=clearMonthSchedule(db,'2026-11',version.id)
    expect(cleared.cleared).toBe(2)
    expect(cleared.version.cells[key('e0','2026-11-02')]?.kind).toBe('vacation')
    expect(cleared.version.cells[key('e0','2026-11-01')]?.kind).toBe('rest')
    expect(version.cells[key('e0','2026-11-02')]?.kind).toBe('overtime')
  })
  it('确认后的加班撤销建立修订副本，不改历史',()=>{
    const {db,version}=fixture();adjustCell(db,'e0','2026-11-01',overtime);version.status='confirmed'
    cancelOvertime(db,'e0','2026-11-01')
    expect(activeVersion(db,'2026-11')?.parentId).toBe(version.id)
    expect(version.cells[key('e0','2026-11-01')]?.kind).toBe('overtime')
  })
})
describe('加班Excel往返',()=>{
  it('月表与结构化明细导出再导入，均保留加班原休息或休假状态',async()=>{
    const {db,version}=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-02'],reason:'原年假'})
    adjustCell(db,'e0','2026-11-02',overtime)
    adjustCell(db,'e1','2026-11-03',{kind:'rest',locked:true,source:'manual',note:'个人休息'})
    adjustCell(db,'e1','2026-11-03',overtime)
    const buffer=new Uint8Array(await exportWorkbook(db,version).xlsx.writeBuffer()),book=await readWorkbook(buffer.buffer as ArrayBuffer)
    const options={month:'2026-11',headerRow:1,startRow:2,nameColumn:2,codeColumn:1,dateStartColumn:3,colorMap:{'#555F65':'rest','#DBEAFE':'overtime'}}
    for(const detail of [false,true]){
      const fresh=fixture().db
      const opts=detail?{...options,format:'detail' as const,dateColumn:1,codeColumn:2,nameColumn:3,roomColumn:4,shiftColumn:5,lockColumn:6,statusColumn:7,noteColumn:8}:options
      const rows=previewSheet(book.getWorksheet(detail?'排班明细':'月度排班')!,fresh,opts)
      expect(rows.filter(r=>r.error)).toEqual([])
      const imported=applyScheduleImport(fresh,rows,'2026-11','schedule','加班往返.xlsx',false)
      expect(imported.cells[key('e0','2026-11-02')]).toMatchObject({kind:'overtime',locked:true,overtimeBase:{kind:'vacation',note:'原年假'}})
      expect(imported.cells[key('e1','2026-11-03')]).toMatchObject({kind:'overtime',overtimeBase:{kind:'rest',note:'个人休息'}})
      expect(fresh.vacationPlans).toHaveLength(1)
      cancelOvertime(fresh,'e0','2026-11-02');cancelOvertime(fresh,'e1','2026-11-03')
      expect(activeVersion(fresh,'2026-11')!.cells[key('e0','2026-11-02')]?.kind).toBe('vacation')
      expect(activeVersion(fresh,'2026-11')!.cells[key('e1','2026-11-03')]?.kind).toBe('rest')
    }
  })
})
