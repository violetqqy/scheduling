import { describe, expect, it } from 'vitest'
import type { Cell, Version } from './types'
import { activeVersion, completedSegments, effectiveCell, emptyDatabase, key, newVersion, oppositeRoom, workSegments } from './model'
import { adjustCell, cancelOvertime, saveVacationPlan } from './absences'
import { applyScheduleSelection, clearMonthSchedule } from './schedule-edit'
import { generate } from './scheduler'
import { coverage, validate } from './validation'
import { assignmentDetails, employeeStatistics } from './statistics'
import { parseDatabase } from '../services/storage'
import { exportWorkbook, parseCell, previewSheet, readWorkbook } from '../services/excel'
import { applyScheduleImport } from './schedule-import'

function fixture(count=18){const db=emptyDatabase();db.employees=Array.from({length:count},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}));return db}
function mount(db:ReturnType<typeof fixture>,v:Version){db.versions.push(v);db.activeVersions[v.month]=v.id;return v}
const regular:Cell={kind:'shift',shiftId:'red-early',locked:true,source:'manual'}
const custom:Cell={kind:'custom',customName:'培训U',locked:true,source:'manual'}

describe('按早中晚分别轮换房间',()=>{
  it('红早、橙中、红晚分别映射橙早、红中、橙晚，不以总体房间判断',()=>{
    const db=fixture(),v=mount(db,newVersion(db,'2026-10'))
    for(const [date,shiftId] of [['2026-10-05','red-early'],['2026-10-06','orange-middle'],['2026-10-07','red-late']])v.cells[key('e0',date!)]={...regular,shiftId}
    expect(['早','中','晚'].map(c=>oppositeRoom(db,v,'e0',c))).toEqual(['orange','red','orange'])
    expect(oppositeRoom(db,v,'e1','早')).toBeUndefined();expect(oppositeRoom(db,undefined,'e0','早')).toBeUndefined()
    expect(oppositeRoom(db,v,'e0','白')).toBeUndefined()
  })
  it('同类别累计天数优先，只有平票时才取最后一次',()=>{
    const db=fixture(),v=mount(db,newVersion(db,'2026-10'))
    for(const [date,shiftId] of [['2026-10-05','red-early'],['2026-10-06','red-early'],['2026-10-07','orange-early']])v.cells[key('e0',date!)]={...regular,shiftId}
    expect(oppositeRoom(db,v,'e0','早')).toBe('orange')
    v.cells[key('e0','2026-10-08')]={...regular,shiftId:'orange-early'}
    expect(oppositeRoom(db,v,'e0','早')).toBe('red')
  })
  it.each(['早','中','晚'])('%s类自动匹配采用相反房间且保持每班2人',category=>{
    const db=fixture(4),prev=mount(db,newVersion(db,'2026-10'))
    const red=db.shifts.find(s=>s.roomId==='red' && s.category===category)!,orange=db.shifts.find(s=>s.roomId==='orange' && s.category===category)!
    db.shifts.forEach(s=>s.enabled=s.category===category)
    for(let day=1;day<=30;day++)db.calendar[`2026-11-${String(day).padStart(2,'0')}`]=day>=2 && day<=6
    for(let i=0;i<4;i++)for(let day=5;day<=9;day++)prev.cells[key(`e${i}`,`2026-10-${String(day).padStart(2,'0')}`)]={...regular,shiftId:i<2?red.id:orange.id}
    // The new order requires the preceding ordinary segment to be the predecessor category.
    const predecessor=category==='早'?'晚':category==='中'?'早':'中'
    for(let i=0;i<4;i++)prev.cells[key(`e${i}`,'2026-10-30')]={...regular,shiftId:db.shifts.find(s=>s.category===predecessor && s.roomId==='red')!.id}
    const result=generate(db,'2026-11','rebuild',1).version
    for(let i=0;i<4;i++)expect(result.cells[key(`e${i}`,'2026-11-02')]?.shiftId).toBe(i<2?orange.id:red.id)
    expect(coverage(db,result).every(r=>r.actual===r.expected)).toBe(true)
  })
})

describe('任意月份与状态编辑，计划独立',()=>{
  it('未来未生成月份可直接编辑，所有状态互改且不产生计划',()=>{
    const db=fixture(),calendar=structuredClone(db.calendar)
    for(const cell of [regular,{kind:'rest'},{kind:'vacation'},{kind:'leave'},{kind:'overtime'},custom,{kind:'unassigned'}]){
      const input={locked:true,source:'manual',...cell} as Cell
      adjustCell(db,'e0','2027-01-03',input)
      expect(activeVersion(db,'2027-01')?.cells[key('e0','2027-01-03')]?.kind).toBe(input.kind)
    }
    expect(db.versions).toHaveLength(1);expect(db.calendar).toEqual(calendar);expect(db.vacationPlans).toEqual([])
  })
  it.each(['fill','rebuild'] as const)('%s保留已锁定计划休假改班，解锁后恢复计划',mode=>{
    const db=fixture(),plan=saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-04'],reason:'计划'})
    adjustCell(db,'e0','2026-11-04',regular)
    const v=activeVersion(db,'2026-11')!
    expect(generate(db,'2026-11',mode,1).version.cells[key('e0','2026-11-04')]).toEqual(regular)
    expect(validate(db,v).some(i=>i.rule==='H06')).toBe(true)
    applyScheduleSelection(db,v.month,v.id,[{employeeId:'e0',date:'2026-11-04'}],{type:'lock',locked:false})
    expect(generate(db,'2026-11',mode,1).version.cells[key('e0','2026-11-04')]).toMatchObject({kind:'vacation',planId:plan.id})
    expect(db.vacationPlans).toEqual([plan])
  })
  it('周末普通班可保存，锁定后保留，解锁重排恢复休息',()=>{
    const db=fixture();adjustCell(db,'e0','2026-11-07',regular)
    const v=activeVersion(db,'2026-11')!
    expect(validate(db,v).some(i=>i.rule==='H02' && i.date==='2026-11-07')).toBe(true)
    expect(generate(db,v.month,'rebuild',1).version.cells[key('e0','2026-11-07')]).toEqual(regular)
    applyScheduleSelection(db,v.month,v.id,[{employeeId:'e0',date:'2026-11-07'}],{type:'lock',locked:false})
    expect(generate(db,v.month,'rebuild',1).version.cells[key('e0','2026-11-07')]?.kind).toBe('rest')
  })
  it('任职期外可人工安排并显示，仍报告硬冲突，自动不新增该员工班次',()=>{
    const db=fixture();db.employees[0]!.to='2026-11-01'
    adjustCell(db,'e0','2026-11-02',regular)
    const v=activeVersion(db,'2026-11')!
    expect(effectiveCell(db,v,db.employees[0]!,'2026-11-02')).toEqual(regular)
    expect(validate(db,v).some(i=>i.rule==='H03' && i.employeeId==='e0')).toBe(true)
    expect(employeeStatistics(db,v).find(r=>r.employee.id==='e0')?.work).toBe(1)
    const next=generate(db,'2026-11','rebuild',1).version
    expect(Object.entries(next.cells).filter(([k,c])=>k.startsWith('e0|') && c.kind==='shift')).toHaveLength(1)
  })
  it('工作段不受实际休息、请假、自定义和周末班影响，整段自定义不获得早晚目标',()=>{
    const db=fixture(),v=mount(db,newVersion(db,'2026-11')),before=workSegments(db,v,db.employees[0]!)
    for(const [date,kind] of [['2026-11-02','rest'],['2026-11-03','leave'],['2026-11-04','custom'],['2026-11-07','shift']])adjustCell(db,'e0',date!,{...regular,kind,customName:'培训'} as Cell)
    expect(workSegments(db,v,db.employees[0]!)).toEqual(before)
    for(let day=2;day<=6;day++)adjustCell(db,'e0',`2026-11-0${day}`,custom)
    expect(completedSegments(db,v,db.employees[0]!).some(s=>s.start==='2026-11-02')).toBe(false)
    expect(v.ruleSettings).toEqual({photonCarry:'continue',leaveSplits:false,redYellowOrder:true,monthlyRoomDiversity:true,earlyLatePriority:true,earlyLateCarry:true,singleDayCredit:true})
  })
})

describe('自定义保留、缺口、统计和文件往返',()=>{
  it.each(['fill','rebuild'] as const)('%s保留自定义，16人中一人自定义造成真实缺口',mode=>{
    const db=fixture(16);saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-04'],reason:'原计划'})
    adjustCell(db,'e0','2026-11-04',custom);adjustCell(db,'e1','2026-11-07',custom)
    const next=generate(db,'2026-11',mode,1).version
    expect(next.cells[key('e0','2026-11-04')]).toEqual(custom);expect(next.cells[key('e1','2026-11-07')]).toEqual(custom)
    expect(coverage(db,next).filter(r=>r.date==='2026-11-04').reduce((n,r)=>n+r.actual,0)).toBe(15)
    expect(validate(db,next).some(i=>i.rule==='H02' && i.date==='2026-11-04')).toBe(true)
    expect(db.vacationPlans[0]!.dates).toEqual(['2026-11-04'])
  })
  it('自定义名称校验和批量原子失败，计划修改保留自定义和锁定人工班',()=>{
    const db=fixture(),v=mount(db,newVersion(db,'2026-11')),before=structuredClone(db)
    for(const name of ['', ' '.repeat(3),'长'.repeat(31)])expect(()=>applyScheduleSelection(db,v.month,v.id,[{employeeId:'e0',date:'2026-11-02'},{employeeId:'e1',date:'2026-11-03'}],{type:'adjust',cell:{...custom,customName:name}})).toThrow('1至30')
    expect(db).toEqual(before)
    adjustCell(db,'e0','2026-11-04',custom);adjustCell(db,'e0','2026-11-05',regular)
    saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-04','2026-11-05'],reason:'计划'})
    expect(v.cells[key('e0','2026-11-04')]).toEqual(custom);expect(v.cells[key('e0','2026-11-05')]).toEqual(regular)
  })
  it('自定义计出勤并独立明细，清空创建副本且不改变原版本和计划',()=>{
    const db=fixture();adjustCell(db,'e0','2026-11-02',custom);const v=activeVersion(db,'2026-11')!
    expect(employeeStatistics(db,v)[0]).toMatchObject({work:1,custom:1,overtime:0})
    expect(assignmentDetails(db,v,'e0','[自定义]培训U')).toHaveLength(1)
    expect(parseDatabase(JSON.parse(JSON.stringify(db)))).toEqual(db)
    const cleared=clearMonthSchedule(db,v.month,v.id)
    expect(cleared.cleared).toBe(1);expect(cleared.version.cells[key('e0','2026-11-02')]).toBeUndefined()
    expect(v.cells[key('e0','2026-11-02')]).toEqual(custom)
  })
  it('任意状态改加班后可撤销恢复，保留普通班、自定义名称和请假',()=>{
    const db=fixture()
    for(const cell of [regular,custom,{kind:'leave',locked:true,source:'manual'} as Cell]){
      adjustCell(db,'e0','2026-11-02',cell)
      adjustCell(db,'e0','2026-11-02',{kind:'overtime',source:'manual',locked:true})
      expect(parseDatabase(JSON.parse(JSON.stringify(db)))).toEqual(db)
      cancelOvertime(db,'e0','2026-11-02')
      expect(activeVersion(db,'2026-11')!.cells[key('e0','2026-11-02')]).toEqual(cell)
    }
  })
  it('清空加班不会将原普通班或自定义重新恢复为出勤安排',()=>{
    const db=fixture()
    for(const [index,cell] of [regular,custom].entries()){
      adjustCell(db,`e${index}`,'2026-11-02',cell)
      adjustCell(db,`e${index}`,'2026-11-02',{kind:'overtime',source:'manual',locked:true})
    }
    const v=activeVersion(db,'2026-11')!,cleared=clearMonthSchedule(db,v.month,v.id)
    expect(employeeStatistics(db,cleared.version).reduce((n,r)=>n+r.work,0)).toBe(0)
    expect(cleared.cleared).toBe(2)
  })
  it('矩阵与明细Excel往返保留自定义名称尾部U，未知普通标记不自动转自定义',async()=>{
    const db=fixture();adjustCell(db,'e0','2026-11-02',custom);const v=activeVersion(db,'2026-11')!
    const book=await readWorkbook(new Uint8Array(await exportWorkbook(db,v).xlsx.writeBuffer()).buffer as ArrayBuffer)
    for(const detail of [false,true]){
      const fresh=fixture(),options={month:'2026-11',headerRow:1,startRow:2,nameColumn:2,codeColumn:1,dateStartColumn:3,colorMap:{'#555F65':'rest'},...(detail?{format:'detail' as const,dateColumn:1,codeColumn:2,nameColumn:3,roomColumn:4,shiftColumn:5,lockColumn:6,statusColumn:7,noteColumn:8}:{})}
      const rows=previewSheet(book.getWorksheet(detail?'排班明细':'月度排班')!,fresh,options)
      expect(rows.filter(r=>r.error)).toEqual([])
      const imported=applyScheduleImport(fresh,rows,'2026-11','schedule','自定义.xlsx',false)
      expect(imported.cells[key('e0','2026-11-02')]).toMatchObject({kind:'custom',customName:'培训U'})
    }
    expect(parseCell('培训','',{},db).error).toContain('未知标记')
    expect(parseCell('[自定义]','',{},db).error).toContain('1至30')
  })
})
