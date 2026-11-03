import { describe, expect, it } from 'vitest'
import type { EmployeeImportRow } from './types'
import { applyEmployeeImport, employeeImportPreview } from './employee-import'
import { emptyDatabase } from './model'

const row = (code='E001',name='测试员工',i=2):EmployeeImportRow => ({row:i,code,name,from:'',to:'',note:'',error:''})
describe('首次员工名单初始化',() => {
  it('只有员工名单即可初始化，不需要班表或日期字段，也不创建排班版本',() => {
    const db=emptyDatabase();expect(applyEmployeeImport(db,[row(),row('E002','第二人',3)],false)).toEqual({created:2,updated:0})
    expect(db.employees.map(e => e.code)).toEqual(['E001','E002']);expect(db.employees[0]!.from).toBe('')
    expect(db.versions).toEqual([])
  })
  it('姓名表自动编号，预览与写入一致；同名无编号必须消歧',() => {
    const db=emptyDatabase(),rows=employeeImportPreview(db,[row('','甲'),row('','乙',3)])
    expect(rows.map(r => r.code)).toEqual(['E001','E002']);applyEmployeeImport(db,rows,false)
    expect(db.employees.map(e => e.code)).toEqual(['E001','E002'])
    expect(employeeImportPreview(db,[row('','重复'),row('','重复',3)]).every(r => !!r.error)).toBe(true)
    expect(employeeImportPreview(db,[row('','甲')])[0]!.employeeId).toBe(db.employees[0]!.id)
  })
  it('相同编号更新需确认，保留员工主键、空白可选信息及未列入的员工',() => {
    const db=emptyDatabase();applyEmployeeImport(db,[{...row(),from:'2026-06-01',note:'保留备注',order:2},row('E002','乙',3)],false)
    const id=db.employees[0]!.id
    expect(() => applyEmployeeImport(db,[row('E001','新姓名')],false)).toThrow('确认更新')
    applyEmployeeImport(db,[row('E001','新姓名')],true)
    expect(db.employees[0]).toMatchObject({id,name:'新姓名',from:'2026-06-01',note:'保留备注',order:1})
    expect(db.employees).toHaveLength(2)
  })
  it('重复编号、无效日期和不合法顺序整批拒绝，不部分创建员工',() => {
    const db=emptyDatabase()
    for (const invalid of [[row(),row('E001','乙',3)],[row(),{...row('E002','乙',3),from:'2026-02-30'}],[row(),{...row('E002','乙',3),order:0}]]) {
      expect(() => applyEmployeeImport(db,invalid,false)).toThrow('错误');expect(db.employees).toEqual([])
    }
  })
  it('跳过重复或错误行后可重新预览，不保留过期错误',() => {
    const db=emptyDatabase(),bad=employeeImportPreview(db,[row(),row('E001','乙',3)])
    expect(bad.every(r => !!r.error)).toBe(true)
    const fixed=employeeImportPreview(db,bad.map(r => ({...r,skip:r.row===3})))
    expect(fixed[0]!.error).toBe('');applyEmployeeImport(db,fixed,false);expect(db.employees).toHaveLength(1)
  })
})
