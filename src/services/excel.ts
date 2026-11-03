import ExcelJS from 'exceljs'
import type { Database, ImportRow, EmployeeImportRow, Version } from '../domain/types'
import { daysInMonth, iso, validDate } from '../domain/dates'
import { effectiveCell, orderedEmployees } from '../domain/model'
import { assignmentDetails, employeeStatistics } from '../domain/statistics'
import { employeeImportPreview } from '../domain/employee-import'
import { coverage } from '../domain/validation'

export interface ImportOptions { month: string; headerRow: number; startRow: number; nameColumn: number; codeColumn: number; dateStartColumn: number; colorMap: Record<string, string>; format?: 'matrix' | 'detail'; dateColumn?: number; roomColumn?: number; shiftColumn?: number; statusColumn?: number; lockColumn?: number; noteColumn?: number }
export async function readWorkbook(buffer: ArrayBuffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  return workbook
}
export function fillColor(cell: ExcelJS.Cell): string {
  const fill = cell.fill
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const c = fill.fgColor || fill.bgColor
    if (c?.argb) return `#${c.argb.slice(-6).toUpperCase()}`
    if (c?.theme !== undefined) return `theme:${c.theme}:${(c as { tint?: number }).tint || 0}`
  }
  return ''
}
export function suggestColor(color: string) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color ? '' : 'photon'
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16)) as [number, number, number]
  if (r > 240 && g > 240 && b > 240) return 'photon'
  if (Math.max(r, g, b) - Math.min(r, g, b) < 28 && r < 200) return 'rest'
  if (r > 190 && g > 180 && b < 150) return 'vacation'
  if ((b > r + 15 && g > r) || (r < 170 && g > 170 && b > 170) || b > 220 && b > r + 5) return 'blue'
  if (r > 190 && b > g + 15) return 'red'
  if (r > 190 && g > b + 20) return 'orange'
  return ''
}
export function discoverColors(sheet: ExcelJS.Worksheet, options: ImportOptions) {
  const colors = new Map<string, number>()
  for (let r = options.startRow; r <= Math.min(sheet.rowCount, 1001); r++) {
    if (!sheet.getCell(r, options.nameColumn).text.trim()) continue
    for (let c = options.dateStartColumn; c <= Math.min(sheet.columnCount, options.dateStartColumn + 31); c++) {
      const color = fillColor(sheet.getCell(r, c)); if (color) colors.set(color, (colors.get(color) || 0) + 1)
    }
  }
  return [...colors].map(([color, count]) => ({ color, count, suggested: suggestColor(color) }))
}
export function parseCell(raw: string, color: string, map: Record<string, string>, db: Database): Pick<ImportRow, 'cell' | 'error' | 'skip'> {
  const text = raw.trim().replace(/[UＵ]+$/i, '').trim(), mapped = color ? map[color] : 'photon'
  const result = (kind: 'rest' | 'vacation' | 'leave') => ({ cell: { kind, locked: true, source: 'import' as const, note: raw }, error: '' })
  if (/^(请|请假|事后请假|事假|病假)$/.test(text)) return result('leave')
  if (/^(预|预定休假|计划休假|休假|年假|假|rl|r1|al)$/i.test(text)) return result('vacation')
  if (mapped === 'vacation') return result('vacation')
  if (mapped === 'rest' || /^(休|休息)$/.test(text)) return result('rest')
  if (mapped === 'leave') return result('leave')
  if (/^(定位|加班)$/.test(text)) return { skip: true, error: '' }
  if (!text || text === '—' || text === '-' || text === '未分配') return { cell: text === '未分配' ? { kind: 'unassigned', locked: false, source: 'import' } : undefined, error: '' }
  const category = text.includes('光子') ? '光子' : text.includes('白') ? '白' : text.includes('早') ? '早' : text.includes('晚') ? '晚' : text.includes('中') ? '中' : undefined
  if (!category) return { error: `未知标记“${raw}”，请修正或选择跳过` }
  const textRoom = text.includes('红') ? 'red' : text.includes('橙') ? 'orange' : text.includes('蓝') ? 'blue' : undefined
  if (textRoom && color && mapped && mapped !== 'photon' && mapped !== textRoom) return { error: '文字房间与底色映射不一致' }
  const roomId = textRoom || (category === '白' ? 'blue' : category === '光子' ? 'photon' : mapped)
  if (color && !mapped) return { error: '底色尚未映射，请确认颜色含义' }
  if (color && mapped && ((category === '白' && mapped !== 'blue') || (category === '光子' && mapped !== 'photon'))) return { error: '底色房间与班次不兼容' }
  const shift = db.shifts.find(s => s.roomId === roomId && s.category === category)
  if (!shift) return { error: '房间与班次不兼容；早中晚必须区分红房间或橙房间' }
  return { cell: { kind: 'shift', shiftId: shift.id, locked: true, source: 'import', note: raw }, error: '' }
}
function columnDate(cell: ExcelJS.Cell, month: string) {
  if (cell.value instanceof Date) return iso(cell.value)
  const text = cell.text.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const day = text.match(/^(\d{1,2})(?:日)?$/)
  return day ? `${month}-${String(Number(day[1])).padStart(2, '0')}` : ''
}
export function previewSheet(sheet: ExcelJS.Worksheet, db: Database, options: ImportOptions): ImportRow[] {
  if (options.format === 'detail') return previewDetails(sheet,db,options)
  const dates = new Map<number, string>(), rows: ImportRow[] = []
  for (let c = options.dateStartColumn; c <= Math.min(sheet.columnCount, options.dateStartColumn + 31); c++) {
    const date = columnDate(sheet.getCell(options.headerRow, c), options.month)
    if (date) dates.set(c, date)
  }
  if (!dates.size) throw new Error('没有识别到日期表头，请调整表头行和日期起始列')
  for (let r = options.startRow; r <= Math.min(sheet.rowCount, 1001); r++) {
    const name = sheet.getCell(r, options.nameColumn).text.trim(); if (!name) continue
    const code = options.codeColumn ? sheet.getCell(r, options.codeColumn).text.trim() : ''
    const matches = db.employees.filter(e => code ? e.code === code : e.name === name)
    for (const [column, date] of dates) {
      const excelCell = sheet.getCell(r, column), raw = excelCell.text.trim(), color = fillColor(excelCell)
      const result = parseCell(raw, color, options.colorMap, db)
      let error = result.error
      if (!validDate(date) || !date.startsWith(options.month)) error = '日期与所选年月不匹配或不存在'
      if (matches.length > 1) error = '存在同名员工，请提供唯一编号列'
      if (matches.length === 1 && code && matches[0]!.name !== name) error = '员工编号与姓名不一致'
      if (excelCell.isMerged && excelCell.master.address !== excelCell.address) error = '数据区域含合并单元格，请拆分后重新导入'
      const note = typeof excelCell.note === 'string' ? excelCell.note : ''
      if (result.cell && note.includes('原始备注:')) result.cell.note = note.split('原始备注:').slice(1).join('原始备注:')
      if (result.cell && note.includes('锁定:否')) result.cell.locked = false
      rows.push({ row: r, employeeId: matches.length === 1 ? matches[0]!.id : undefined, code, name, date, cell: result.cell, raw, color, error, skip: result.skip })
    }
  }
  const seen = new Set<string>()
  for (const row of rows) {
    const identity = `${row.employeeId || row.code || row.name}|${row.date}`
    if (seen.has(identity)) row.error = '文件中同一员工日期重复，请合并重复行'
    seen.add(identity)
  }
  return rows
}
function previewDetails(sheet: ExcelJS.Worksheet, db: Database, options: ImportOptions): ImportRow[] {
  const rows: ImportRow[] = [], seen = new Set<string>()
  for (let r = options.startRow; r <= Math.min(sheet.rowCount,1001); r++) {
    const name = sheet.getCell(r,options.nameColumn).text.trim(); if (!name) continue
    const code = options.codeColumn ? sheet.getCell(r,options.codeColumn).text.trim() : ''
    const dateCell = sheet.getCell(r,options.dateColumn || 1)
    const date = dateCell.value instanceof Date ? iso(dateCell.value) : dateCell.text.trim().replace(/\//g,'-').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/,(_,y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`)
    const shiftCell = sheet.getCell(r,options.shiftColumn || 5), status = options.statusColumn ? sheet.getCell(r,options.statusColumn).text.trim() : ''
    const raw = status && /休|假|未分配/.test(status) ? status : shiftCell.text.trim()
    const roomName = options.roomColumn ? sheet.getCell(r,options.roomColumn).text.trim() : ''
    const room = db.rooms.find(x => x.name === roomName || x.id === roomName || ({red:'红',orange:'橙',blue:'蓝',photon:'无色'} as Record<string,string>)[x.id] === roomName)
    const color = room ? `room:${room.id}` : fillColor(shiftCell)
    const result = parseCell(raw,color,{...options.colorMap,...(room ? {[color]:room.id} : {})},db)
    if (result.cell && options.noteColumn) result.cell.note = sheet.getCell(r,options.noteColumn).text.trim() || raw
    const matches = db.employees.filter(e => code ? e.code === code : e.name === name)
    let error = result.error
    if (!validDate(date) || !date.startsWith(options.month)) error = '日期与所选年月不匹配或不存在'
    if (roomName && !room && !/休|假|未分配/.test(raw)) error = `未知房间“${roomName}”`
    if (matches.length > 1) error = '存在同名员工，请提供唯一编号列'
    if (matches.length === 1 && code && matches[0]!.name !== name) error = '员工编号与姓名不一致'
    const identity = `${matches[0]?.id || code || name}|${date}`
    if (seen.has(identity)) error = '文件中同一员工日期重复，请合并重复行'
    seen.add(identity)
    if (result.cell && options.lockColumn && /^(否|false|0)$/i.test(sheet.getCell(r,options.lockColumn).text.trim())) result.cell.locked = false
    rows.push({row:r,employeeId:matches.length === 1 ? matches[0]!.id : undefined,code,name,date,raw,color,cell:result.cell,error,skip:result.skip})
  }
  return rows
}
const solid = (hex: string): ExcelJS.Fill => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex.replace('#', '')}` } })
function styleSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]
  sheet.getRow(1).height = 30
  sheet.getRow(1).eachCell(cell => { cell.fill = solid('#176953'); cell.font = { color: { argb: 'FFFFFFFF' }, bold: true, size: 11 }; cell.alignment = { horizontal: 'center', vertical: 'middle' } })
  sheet.eachRow((row, index) => {
    if (index > 1) row.height = 25
    row.eachCell(cell => { cell.alignment = { vertical: 'middle', horizontal: 'center' }; cell.border = { bottom: { style: 'thin', color: { argb: 'FFE6EBE9' } } } })
  })
  sheet.autoFilter = { from: 'A1', to: { row: sheet.rowCount, column: sheet.columnCount } }
}
export function exportWorkbook(db: Database, version: Version) {
  const workbook = new ExcelJS.Workbook(); workbook.creator = '班序'; workbook.created = new Date()
  const dates = daysInMonth(version.month), sheet = workbook.addWorksheet('月度排班')
  sheet.addRow(['员工编号', '姓名', ...dates.map(d => Number(d.slice(8)))])
  for (const employee of orderedEmployees(db).filter(e => version.employeeIds.includes(e.id))) {
    const row = sheet.addRow([employee.code, employee.name, ...dates.map(() => '')])
    dates.forEach((date, index) => {
      const value = effectiveCell(db, version, employee, date), cell = row.getCell(index + 3)
      if (!value) return
      const shift = db.shifts.find(s => s.id === value.shiftId), room = db.rooms.find(r => r.id === shift?.roomId)
      cell.value = value.kind === 'rest' ? '休' : value.kind === 'vacation' ? '预定休假' : value.kind === 'leave' ? '事后请假' : value.kind === 'shift' ? shift?.category || '' : '未分配'
      if (value.kind === 'rest') { cell.fill = solid('#555F65'); cell.font = { color: { argb: 'FFFFFFFF' } } }
      else if (value.kind === 'vacation') cell.fill = solid('#FFF0A8')
      else if (value.kind === 'leave') cell.fill = solid('#EDE4FF')
      else if (room) { cell.fill = solid(room.color); cell.font = { color: { argb: `FF${room.ink.slice(1)}` } } }
      cell.note = `锁定:${value.locked ? '是' : '否'}${value.note ? `\n原始备注:${value.note}` : ''}`
    })
  }
  sheet.columns.forEach((column, index) => column.width = index < 2 ? 14 : 7)
  styleSheet(sheet)
  const statistics = workbook.addWorksheet('员工统计')
  statistics.addRow(['编号', '姓名', '出勤', '早', '中', '晚', '白', '光子', '休息', '预定休假', '事后请假', '未分配', '早段达成', '晚段达成'])
  for (const r of employeeStatistics(db, version)) statistics.addRow([r.employee.code, r.employee.name, r.work, ...['早', '中', '晚', '白', '光子'].map(c => r.categories[c]), r.rest, r.vacation, r.leave, r.empty, r.early ? '是' : '否', r.late ? '是' : '否'])
  const details = workbook.addWorksheet('排班明细'); details.addRow(['日期', '员工编号', '姓名', '房间', '班次', '锁定'])
  for (const r of assignmentDetails(db, version)) details.addRow([r.date, r.code, r.employee, r.room, r.category, r.locked ? '是' : '否'])
  const plans = workbook.addWorksheet('员工休假计划'); plans.addRow(['日期','员工编号','姓名','房间','班次','锁定','状态','说明'])
  for (const p of version.vacationPlans) {
    const e = db.employees.find(e => e.id === p.employeeId)
    for (const date of p.dates) plans.addRow([date,e?.code,e?.name,'','','是','预定休假',p.reason])
  }
  const leaves = workbook.addWorksheet('事后请假'); leaves.addRow(['日期','员工编号','姓名','房间','班次','锁定','状态','说明'])
  for (const e of db.employees.filter(e => version.employeeIds.includes(e.id))) for (const date of dates) {
    const c = effectiveCell(db,version,e,date)
    if (c?.kind === 'leave') leaves.addRow([date,e.code,e.name,'','','是','事后请假',c.note || ''])
  }
  const pairs = workbook.addWorksheet('每日配对'); pairs.addRow(['日期', '房间', '班次', '应排', '实排', '缺口', '超额', '人员'])
  for (const r of coverage(db, version)) { const shift = db.shifts.find(s => s.id === r.shiftId)!; pairs.addRow([r.date, db.rooms.find(x => x.id === shift.roomId)?.name, shift.category, r.expected, r.actual, r.gap, r.excess, r.employeeIds.map(id => db.employees.find(e => e.id === id)?.name).join('、')]) }
  const meta = workbook.addWorksheet('说明与图例')
  meta.addRows([['项目', '内容'], ['月份', version.month], ['版本', version.name], ['状态', version.status === 'confirmed' ? '已确认' : version.status === 'imported' ? '历史导入' : '草稿'], ['版本编号', version.id], ['统计口径', '按实际日期计人天；完整段按开始月归属；不计算加班和工时'], ['使用说明', '重新导入月度排班页：表头行1、数据行2、编号列1、姓名列2、日期起始列3。请确认颜色映射。'], ...db.rooms.map(r => [r.name, r.color]), ['休息', '#555F65'], ['预定休假', '#FFF0A8'], ['事后请假', '#EDE4FF']])
  const employees = workbook.addWorksheet('员工资料'); employees.addRow(['编号', '姓名', '顺序', '生效日期', '停用日期', '备注'])
  for (const e of orderedEmployees(db)) employees.addRow([e.code, e.name, e.order + 1, e.from, e.to, e.note])
  for (const s of [statistics, details, plans, leaves, pairs, meta, employees]) { s.columns.forEach(c => c.width = 18); styleSheet(s) }
  meta.getColumn(2).width = 90
  return workbook
}
export function tableWorkbook(title: string, headers: string[], rows: (string | number | boolean | undefined)[][], month: string, versionName: string) {
  const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet(title.slice(0, 31))
  sheet.addRow(headers); rows.forEach(r => sheet.addRow(r)); sheet.columns.forEach(c => c.width = 18); styleSheet(sheet)
  wb.addWorksheet('说明').addRows([['月份', month], ['版本', versionName]])
  return wb
}
export function templateWorkbook(db: Database, month: string) {
  const version = newVersionForTemplate(db, month)
  return exportWorkbook(db, version)
}
function newVersionForTemplate(db: Database, month: string): Version {
  return { id: 'template', month, name: '导入模板', status: 'draft', vacationPlans: [], cells: {}, calendar: {}, requirements: {}, employeeIds: orderedEmployees(db).map(e => e.id), ruleSettings: db.rules, created: '', updated: '', inputHash: '' }
}

export interface EmployeeImportOptions { headerRow: number; startRow: number; codeColumn: number; nameColumn: number; orderColumn: number; fromColumn: number; toColumn: number; noteColumn: number }
export function previewEmployeeSheet(sheet: ExcelJS.Worksheet, db: Database, options: EmployeeImportOptions): EmployeeImportRow[] {
  if (!Number.isInteger(options.startRow) || options.startRow <= options.headerRow || options.nameColumn < 1 || [options.nameColumn,options.codeColumn,options.orderColumn,options.fromColumn,options.toColumn,options.noteColumn].some(c => !Number.isInteger(c) || c < 0 || c > 50)) throw new Error('请核对字段映射；姓名列从1开始，数据行应在表头行之后')
  if (sheet.rowCount > 1001) throw new Error('员工名单最多1000行，请拆分文件后导入')
  const rows: EmployeeImportRow[] = []
  const dateText = (cell: ExcelJS.Cell) => cell.value instanceof Date ? iso(cell.value) : cell.text.trim().replace(/\//g,'-').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/,(_,y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`)
  for (let r = options.startRow; r <= sheet.rowCount; r++) {
    const text = (column: number) => column ? sheet.getCell(r,column).text.trim() : ''
    const code = text(options.codeColumn), name = text(options.nameColumn), order = text(options.orderColumn), from = options.fromColumn ? dateText(sheet.getCell(r,options.fromColumn)) : '', to = options.toColumn ? dateText(sheet.getCell(r,options.toColumn)) : '', note = text(options.noteColumn)
    if (![code,name,order,from,to,note].some(Boolean)) continue
    const merged = [options.codeColumn,options.nameColumn].filter(Boolean).some(c => {const cell = sheet.getCell(r,c); return cell.isMerged && cell.master.address !== cell.address})
    rows.push({row:r,rawCode:code,code,name,order:order ? Number(order) : undefined,from,to,note,error:'',parseError:merged ? '员工数据含合并单元格，请先拆分' : ''})
  }
  return employeeImportPreview(db,rows)
}
export function employeeTemplateWorkbook() {
  const wb = new ExcelJS.Workbook(), sheet = wb.addWorksheet('员工名单')
  sheet.addRow(['员工编号','姓名','顺序','生效日期','停用日期','备注'])
  sheet.columns.forEach(c => c.width = 20); styleSheet(sheet)
  const help = wb.addWorksheet('填写说明'); help.addRows([
    ['字段','填写要求'],['员工编号','建议填写唯一编号；为空时按唯一姓名匹配，找不到则自动编号。同名员工必须编号。'],['姓名','必填；每人一行，最多1000行。此工作表不需要班次和日期列。'],['顺序','选填，从1开始；影响个人优先目标。为空则保留原顺序，新员工按文件顺序追加。'],['生效日期','选填，YYYY-MM-DD；留空的新员工不限制开始日期。'],['停用日期','选填，YYYY-MM-DD；此日期起不再排班。需晚于生效日期。'],['更新规则','相同编号先预览并确认更新；空白可选字段保留原资料；不删除未列出的员工。'],['下一步','仅有员工名单：配置休假后直接生成。有已有班表：另选历史排班用途导入，也可直接从班表创建员工。']
  ]); help.getColumn(1).width = 18; help.getColumn(2).width = 105; styleSheet(help)
  return wb
}
export function initializationWorkbook(month: string) {
  const wb = employeeTemplateWorkbook(), sheet = wb.addWorksheet('已有排班')
  sheet.addRow(['员工编号','姓名',...daysInMonth(month).map(d => Number(d.slice(8)))])
  sheet.columns.forEach((c,i) => c.width = i < 2 ? 15 : 9); styleSheet(sheet)
  const legend = wb.addWorksheet('排班填写说明')
  legend.addRows([['项目','内容'],['排班月份',month],['导入路径','导入与导出 → 上月历史排班 → 选择“已有排班”工作表，并选择正确年月。'],['人员','每人一行；无现有员工也可以导入，预览后确认创建新员工。'],['房间班次','可以填写红早、红中、红晚、橙早、橙中、橙晚、白、光子，避免颜色歧义。'],['不可用','休=个人休息；预定休假=排班前计划；事后请假=排班后请假。空格不写入。'],['填充色','红房间/橙房间/蓝色白班/无色光子；黄色休假、紫色请假、深灰休息。颜色在导入预览确认。'],['第一次使用','可先导员工名单再导已有排班，也可直接导班表并确认创建员工。没有上月班表时可跳过历史。']])
  legend.getColumn(1).width = 18; legend.getColumn(2).width = 105; styleSheet(legend)
  return wb
}
