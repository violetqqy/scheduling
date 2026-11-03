import { applyEmployeeImport } from '../domain/employee-import'
import { generate } from '../domain/scheduler'
import { coverage } from '../domain/validation'
import { describe, expect, it } from 'vitest'
import { emptyDatabase, key, newVersion } from '../domain/model'
import { saveVacationPlan, adjustCell } from '../domain/absences'
import { activeVersion } from '../domain/model'
import { assertDatabase } from './storage'
import { exportWorkbook, fillColor, parseCell, previewSheet, readWorkbook, employeeTemplateWorkbook, initializationWorkbook, previewEmployeeSheet } from './excel'

describe('Excel导入导出', () => {
  it('有色班次、请假和锁定状态可以导出再导入', async () => {
    const db = emptyDatabase(); db.employees.push({ id:'e1',code:'E001',name:'测试员工',order:0,from:'2026-06-01',to:'',note:'' })
    const v = newVersion(db,'2026-06')
    v.cells[key('e1','2026-06-01')] = { kind:'shift',shiftId:'red-early',source:'manual',locked:false }
    v.cells[key('e1','2026-06-02')] = { kind:'leave',source:'manual',locked:true }
    const buffer = await exportWorkbook(db,v).xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer), imported = await readWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer)
    const sheet = imported.getWorksheet('月度排班')!
    expect(fillColor(sheet.getCell(2,3))).toBe('#FFE5EB')
    const colorMap = Object.fromEntries([...db.rooms.map(r => [r.color.toUpperCase(),r.id]),['#555F65','rest'],['#FFF0A8','leave']])
    const rows = previewSheet(sheet,db,{month:'2026-06',headerRow:1,startRow:2,nameColumn:2,codeColumn:1,dateStartColumn:3,colorMap})
    expect(rows.filter(r => r.error)).toEqual([])
    expect(rows.find(r => r.date === '2026-06-01')?.cell).toMatchObject({kind:'shift',shiftId:'red-early',locked:false})
    expect(rows.find(r => r.date === '2026-06-02')?.cell?.kind).toBe('leave')
    expect(rows.find(r => r.date === '2026-06-06')?.cell?.kind).toBe('rest')
    expect(imported.worksheets.map(s => s.name)).toContain('每日配对')
  })
  it('房间与班次冲突、未知文字不静默导入', () => {
    const db = emptyDatabase()
    expect(parseCell('早U','#00FFFF',{'#00FFFF':'blue'},db).error).not.toBe('')
    expect(parseCell('早U','#FF0088',{'#FF0088':'red'},db).cell?.shiftId).toBe('red-early')
    expect(parseCell('未知代码','',{},db).error).not.toBe('')
    expect(parseCell('早','',{},db).error).not.toBe('')
    expect(parseCell('光子U','',{},db).cell?.shiftId).toBe('photon')
  })
  it('结构化排班明细按显式日期、房间与班次导入', () => {
    const db = emptyDatabase(); db.employees.push({id:'e1',code:'E001',name:'测试员工',order:0,from:'2026-06-01',to:'',note:''})
    const v = newVersion(db,'2026-06'); v.cells[key('e1','2026-06-01')] = {kind:'shift',shiftId:'orange-late',locked:false,source:'auto'}
    const sheet = exportWorkbook(db,v).getWorksheet('排班明细')!
    const rows = previewSheet(sheet,db,{month:'2026-06',headerRow:1,startRow:2,nameColumn:3,codeColumn:2,dateStartColumn:1,colorMap:{},format:'detail',dateColumn:1,roomColumn:4,shiftColumn:5,lockColumn:6})
    expect(rows).toHaveLength(1); expect(rows[0]!.error).toBe(''); expect(rows[0]!.cell).toMatchObject({kind:'shift',shiftId:'orange-late',locked:false})
    sheet.addRow(['2026-06-01','E001','测试员工','橙房间','早','是'])
    expect(previewSheet(sheet,db,{month:'2026-06',headerRow:1,startRow:2,nameColumn:3,codeColumn:2,dateStartColumn:1,colorMap:{},format:'detail',dateColumn:1,roomColumn:4,shiftColumn:5})[1]!.error).toContain('重复')
  })
  it('定位仅作附注，加班是保留原休息状态的独立安排', () => {
    const db = emptyDatabase()
    expect(parseCell('定位','',{},db).skip).toBe(true)
    expect(parseCell('加班','#777777',{'#777777':'rest'},db).cell).toMatchObject({kind:'overtime',locked:true,overtimeBase:{kind:'rest'}})
  })
  it('无效备份和重复员工编号在写入之前被拒绝', () => {
    expect(() => assertDatabase({schema:1})).toThrow()
    const db = emptyDatabase(); db.employees = [0,1].map(i => ({id:`e${i}`,code:'E001',name:'同名员工',order:i,from:'',to:'',note:''}))
    expect(() => assertDatabase(db)).toThrow('员工编号')
  })
})

describe('休假计划与事后请假Excel往返',() => {
  it('黄色旧表默认是预定休假，明确请假文字与映射单独识别',() => {
    const db = emptyDatabase()
    expect(parseCell('rl','#FFFF00',{'#FFFF00':'vacation'},db).cell?.kind).toBe('vacation')
    expect(parseCell('','#FFFF00',{'#FFFF00':'vacation'},db).cell?.kind).toBe('vacation')
    expect(parseCell('休假','',{},db).cell?.kind).toBe('vacation')
    expect(parseCell('请假','',{},db).cell?.kind).toBe('leave')
    expect(parseCell('','#EDE4FF',{'#EDE4FF':'leave'},db).cell?.kind).toBe('leave')
  })
  it('计划与请假重叠时，月表呈现请假，独立计划页仍保存基线及说明', async () => {
    const db = emptyDatabase(); db.employees.push({id:'e1',code:'E001',name:'测试员工',order:0,from:'2026-06-01',to:'',note:''})
    saveVacationPlan(db,{employeeId:'e1',month:'2026-06',dates:['2026-06-02','2026-06-03'],reason:'预定年假'})
    adjustCell(db,'e1','2026-06-02',{kind:'leave',locked:true,source:'manual',note:'事后调整'})
    const buffer = await exportWorkbook(db,activeVersion(db,'2026-06')!).xlsx.writeBuffer()
    const bytes = new Uint8Array(buffer), wb = await readWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer)
    const matrix = wb.getWorksheet('月度排班')!, options = {month:'2026-06',headerRow:1,startRow:2,nameColumn:2,codeColumn:1,dateStartColumn:3,colorMap:{'#FFF0A8':'vacation','#EDE4FF':'leave','#555F65':'rest'}}
    expect(fillColor(matrix.getCell(2,4))).toBe('#EDE4FF'); expect(fillColor(matrix.getCell(2,5))).toBe('#FFF0A8')
    const rows = previewSheet(matrix,db,options)
    expect(rows.find(r => r.date === '2026-06-02')?.cell).toMatchObject({kind:'leave',note:'事后调整'})
    expect(rows.find(r => r.date === '2026-06-03')?.cell?.kind).toBe('vacation')
    const detailOptions = {...options,format:'detail' as const,nameColumn:3,codeColumn:2,dateColumn:1,roomColumn:4,shiftColumn:5,lockColumn:6,statusColumn:7,noteColumn:8}
    const plans = previewSheet(wb.getWorksheet('员工休假计划')!,db,detailOptions)
    expect(plans).toHaveLength(2); expect(plans.every(r => !r.error && r.cell?.kind === 'vacation' && r.cell.note === '预定年假')).toBe(true)
    const leaves = previewSheet(wb.getWorksheet('事后请假')!,db,detailOptions)
    expect(leaves).toHaveLength(1); expect(leaves[0]!.cell).toMatchObject({kind:'leave',note:'事后调整'})
    const header = wb.getWorksheet('员工统计')!.getRow(1).values as string[]
    expect(header).toContain('预定休假'); expect(header).toContain('事后请假')
    const historical = activeVersion(db,'2026-06')!; historical.status = 'confirmed'
    saveVacationPlan(db,{id:db.vacationPlans[0]!.id,employeeId:'e1',month:'2026-06',dates:['2026-06-04'],reason:'修改后的计划'})
    const oldPlans = exportWorkbook(db,historical).getWorksheet('员工休假计划')!
    expect(oldPlans.rowCount).toBe(3); expect(oldPlans.getCell(2,1).text).toBe('2026-06-02')
    expect(exportWorkbook(db,activeVersion(db,'2026-06')!).getWorksheet('员工休假计划')!.getCell(2,1).text).toBe('2026-06-04')
  })
})

describe('首次使用Excel初始化方案',() => {
  const options={headerRow:1,startRow:2,codeColumn:1,nameColumn:2,orderColumn:3,fromColumn:4,toColumn:5,noteColumn:6}
  it('空工作区可下载无虚构员工的模板，只填写名单即可导入并生成首月',async () => {
    const db=emptyDatabase(),wb=employeeTemplateWorkbook(),sheet=wb.getWorksheet('员工名单')!
    expect(sheet.rowCount).toBe(1)
    for (let i=1;i<=16;i++) sheet.addRow([`E${i}`,`员工${i}`,i,'','','真实名单测试'])
    const bytes=new Uint8Array(await wb.xlsx.writeBuffer()),roundTrip=await readWorkbook(bytes.buffer as ArrayBuffer)
    const rows=previewEmployeeSheet(roundTrip.getWorksheet('员工名单')!,db,options)
    expect(rows).toHaveLength(16);expect(rows.every(r => !r.error)).toBe(true)
    applyEmployeeImport(db,rows,false)
    const v=generate(db,'2026-07','rebuild',1).version
    expect(v.historyMode).toBe('initial');expect(coverage(db,v).filter(r => r.expected).every(r => r.actual===2)).toBe(true)
  })
  it('初始化工作簿既包含名单模板，也包含可直接创建员工的已有排班模板',() => {
    const db=emptyDatabase(),wb=initializationWorkbook('2026-07'),sheet=wb.getWorksheet('已有排班')!
    expect(wb.getWorksheet('员工名单')?.rowCount).toBe(1);expect(sheet.columnCount).toBe(33)
    sheet.addRow(['E001','甲','红早','红早','预定休假'])
    const rows=previewSheet(sheet,db,{month:'2026-07',headerRow:1,startRow:2,codeColumn:1,nameColumn:2,dateStartColumn:3,colorMap:{}})
    expect(rows.every(r => !r.error)).toBe(true);expect(rows.filter(r => r.cell)).toHaveLength(3)
    expect(rows[0]!.employeeId).toBeUndefined();expect(rows[0]!.cell?.shiftId).toBe('red-early')
  })
  it('日期单元格、无编号名单与可选字段缺省均可读，错误映射明确提示',() => {
    const db=emptyDatabase(),sheet=employeeTemplateWorkbook().getWorksheet('员工名单')!
    sheet.addRow(['','甲',1,new Date(2026,6,1,12),'','备注'])
    const rows=previewEmployeeSheet(sheet,db,options)
    expect(rows[0]).toMatchObject({code:'E001',name:'甲',from:'2026-07-01',error:''})
    expect(() => previewEmployeeSheet(sheet,db,{...options,nameColumn:0})).toThrow('字段映射')
  })
})

describe('已有班表一键初始化',() => {
  it('无员工资料时，从已有排班创建员工与历史版本，次月正确引用该历史',async () => {
    const {applyScheduleImport}=await import('../domain/schedule-import'),db=emptyDatabase(),sheet=initializationWorkbook('2026-06').getWorksheet('已有排班')!
    for(let i=1;i<=16;i++) sheet.addRow([`E${i}`,`员工${i}`,...Array.from({length:30},(_,d)=>[0,6].includes(new Date(2026,5,d+1,12).getDay()) ? '休' : ['红早','红中','红晚','橙早','橙中','橙晚','白','光子'][Math.floor((i-1)/2)])])
    const rows=previewSheet(sheet,db,{month:'2026-06',headerRow:1,startRow:2,codeColumn:1,nameColumn:2,dateStartColumn:3,colorMap:{}})
    expect(rows.every(r => !r.error)).toBe(true)
    const history=applyScheduleImport(db,rows,'2026-06','history','已有班表.xlsx',true)
    expect(db.employees).toHaveLength(16);expect(db.versions).toHaveLength(1);expect(history.status).toBe('imported')
    db.rules.photonCarry='continue'
    const next=generate(db,'2026-07','rebuild',1).version
    expect(next.historyMode).toBe('reference');expect(next.sourceVersionId).toBe(history.id)
    expect(coverage(db,next).filter(r => r.date==='2026-07-01').every(r => r.actual===2)).toBe(true)
    const ids=db.employees.map(e=>e.id)
    applyScheduleImport(db,rows.map(r=>({...r,employeeId:db.employees.find(e=>e.code===r.code)!.id})),'2026-06','history','重新导入.xlsx',false)
    expect(db.employees.map(e=>e.id)).toEqual(ids)
  })
  it('初始班表的休假也创建计划，并拒绝未确认新员工或编号姓名冲突',async () => {
    const {applyScheduleImport}=await import('../domain/schedule-import'),db=emptyDatabase(),sheet=initializationWorkbook('2026-06').getWorksheet('已有排班')!
    sheet.addRow(['E001','甲','预定休假','红早'])
    const rows=previewSheet(sheet,db,{month:'2026-06',headerRow:1,startRow:2,codeColumn:1,nameColumn:2,dateStartColumn:3,colorMap:{}})
    expect(() => applyScheduleImport(db,rows,'2026-06','history','已有.xlsx',false)).toThrow('确认创建')
    expect(db.employees).toEqual([])
    expect(() => applyScheduleImport(db,rows.map((r,i)=>({...r,name:i===1?'乙':r.name})),'2026-06','history','有冲突.xlsx',true)).toThrow('多个姓名')
    const v=applyScheduleImport(db,rows,'2026-06','history','已有.xlsx',true)
    expect(db.vacationPlans).toHaveLength(1);expect(v.vacationPlans).toHaveLength(1)
    expect(Object.values(v.cells).some(c=>c.kind==='vacation')).toBe(true)
  })
})
