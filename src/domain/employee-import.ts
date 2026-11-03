import type { Database, Employee, EmployeeImportRow } from './types'
import { uid, validDate } from './dates'

export function employeeImportPreview(db: Database, rows: EmployeeImportRow[]): EmployeeImportRow[] {
  const reserved = new Set([...db.employees.map(e => e.code),...rows.map(r => (r.rawCode ?? r.code).trim()).filter(Boolean)])
  const codes = new Map<string,number>(), unnamed = new Map<string,number>()
  for (const r of rows.filter(r => !r.skip)) {
    const code = (r.rawCode ?? r.code).trim(), name = r.name.trim()
    if (code) codes.set(code,(codes.get(code) || 0)+1)
    unnamed.set(name,(unnamed.get(name) || 0)+1)
  }
  let nextNumber = db.employees.length+1
  const preview = rows.map(raw => {
    const rawCode = (raw.rawCode ?? raw.code).trim(), name = raw.name.trim()
    let code = rawCode, error = raw.parseError || ''
    if (!code) {
      const matches = db.employees.filter(e => e.name === name)
      if (matches.length > 1 || (unnamed.get(name) || 0) > 1) error = '无编号员工存在同名，请提供唯一员工编号'
      if (matches.length === 1) code = matches[0]!.code
      else { while (reserved.has(`E${String(nextNumber).padStart(3,'0')}`)) nextNumber++; code = `E${String(nextNumber++).padStart(3,'0')}`; reserved.add(code) }
    }
    const row = {...raw,rawCode,code,name}, existing = db.employees.find(e => e.code === code)
    if (!row.name) error = '员工姓名必填'
    if (rawCode && (codes.get(rawCode) || 0) > 1) error = '文件内员工编号重复，请修正或跳过重复行'
    if (row.order !== undefined && (!Number.isInteger(row.order) || row.order < 1)) error = '顺序必须是大于0的整数，或留空'
    const from = row.from || existing?.from || '', to = row.to || existing?.to || ''
    if (from && !validDate(from) || to && !validDate(to) || from && to && to <= from) error = '日期无效；停用日期必须晚于生效日期'
    return {...row,from,to,note:row.note || existing?.note || '',employeeId:existing?.id,error}
  })
  const assigned = new Map<string,number>()
  for (const r of preview.filter(r => !r.skip)) assigned.set(r.code,(assigned.get(r.code) || 0)+1)
  return preview.map(r => (assigned.get(r.code) || 0) > 1 ? {...r,error:'文件内员工编号重复，请修正或跳过重复行'} : r)
}
// Run against the latest database in the same transaction as saving. No missing rows delete staff.
export function applyEmployeeImport(db: Database, rows: EmployeeImportRow[], allowUpdates: boolean) {
  const preview = employeeImportPreview(db,rows).filter(r => !r.skip)
  if (!preview.length) throw new Error('没有可导入的员工，请先填写员工名单')
  if (preview.some(r => r.error)) throw new Error('请先处理或跳过全部员工导入错误')
  if (!allowUpdates && preview.some(r => r.employeeId)) throw new Error('存在相同编号的员工，请确认更新已有员工资料')
  if (db.employees.length + preview.filter(r => !r.employeeId).length > 1000) throw new Error('员工总数不能超过1000人')
  const employees: Employee[] = preview.map((r,i) => {
    const existing = db.employees.find(e => e.code === r.code)
    return {id:existing?.id || uid(),code:r.code,name:r.name,order:r.order !== undefined ? r.order-1 : existing?.order ?? db.employees.length+i,from:r.from,to:r.to,note:r.note}
  })
  for (const e of employees) {
    const index = db.employees.findIndex(x => x.id === e.id)
    if (index >= 0) db.employees[index] = e; else db.employees.push(e)
  }
  return {created:employees.filter(e => preview.find(r => r.code === e.code)?.employeeId === undefined).length,updated:preview.filter(r => r.employeeId).length}
}
