import type { Database, DayCoverage, Issue, Version } from './types'
import { daysInMonth } from './dates'
import { activeOn, sourceVersion, completedSegments, effectiveCell, getRawCell, isAbsence, isOvertimeVacation, key, priorPhoton, required, workSegments } from './model'

export function coverage(db: Database, version: Version): DayCoverage[] {
  return daysInMonth(version.month).flatMap(date => db.shifts.map(shift => {
    const employeeIds = version.employeeIds.filter(id => version.cells[key(id, date)]?.kind === 'shift' && version.cells[key(id, date)]?.shiftId === shift.id)
    const expected = required(db, date, shift.id, version), actual = employeeIds.length
    return { date, shiftId: shift.id, expected, actual, employeeIds, gap: Math.max(0, expected - actual), excess: Math.max(0, actual - expected) }
  }))
}
export function validate(db: Database, version: Version): Issue[] {
  const issues: Issue[] = []
  const add = (issue: Omit<Issue, 'id'>) => issues.push({ ...issue, id: `${issue.rule}:${issue.employeeId || ''}:${issue.date || ''}:${issue.shiftId || ''}:${issues.length}` })
  for (const row of coverage(db, version)) {
    if (row.actual !== row.expected) add({ rule: 'H02', level: 'error', date: row.date, shiftId: row.shiftId, message: row.expected === 0 ? `关闭班次仍排了${row.actual}人，请调整日历或移除班次` : `应排2人，实排${row.actual}人${row.gap ? `，缺${row.gap}人` : `，超出${row.excess}人`}` })
  }
  for (const [cellKey, cell] of Object.entries(version.cells)) {
    if (cell.kind !== 'shift' && cell.kind!=='overtime') continue
    const [employeeId, date] = cellKey.split('|') as [string, string]
    const employee = db.employees.find(e => e.id === employeeId)
    if (!employee || !version.employeeIds.includes(employeeId) || !activeOn(employee, date)) add({ rule: 'H03', level: 'error', employeeId, date, message: '员工不在当前版本名单或任职有效日期内' })
    if (cell.kind==='shift' && !db.shifts.some(s => s.id === cell.shiftId)) add({ rule: 'H03', level: 'error', employeeId, date, message: '班次不存在，请重新选择班次' })
  }
  const previous = sourceVersion(db,version)
  if (!previous) add({ rule: 'HISTORY', level: 'warning', message: '首次排班：以本月首日为起点；跳过上月光子禁排、红橙轮转和跨月续班，其余规则正常执行，可手工调整。' })
  for (const employee of db.employees.filter(e => version.employeeIds.includes(e.id))) {
    const employeeSegments = workSegments(db,version,employee)
    const banPhoton = priorPhoton(db, version.month, employee,version).length > 0 || version.ruleSettings.photonCarry === 'continue' && employeeSegments.some(s => s.start < `${version.month}-01` && s.dates.some(d => d < `${version.month}-01` && getRawCell(db,version,employee.id,d)?.shiftId === 'photon'))
    for (const segment of employeeSegments) {
      if (!segment.bounded) add({ rule: 'H04', level: 'error', employeeId: employee.id, date: segment.start, message: '连续工作超过62天，无法确认休息边界；请补充日历' })
      const inside = segment.dates.filter(d => d.startsWith(version.month))
      const assignments = segment.dates.map(d => getRawCell(db, version, employee.id, d)).filter(c => c?.kind === 'shift')
      const shiftIds = new Set(assignments.map(c => c!.shiftId))
      if (shiftIds.size > 1) add({ rule: 'H04', level: 'error', employeeId: employee.id, date: inside[0], message: `工作段${segment.start.slice(5)}—${segment.end.slice(5)}内存在不同房间或班次` })
      const carry = segment.start < `${version.month}-01`
      const oldShift = segment.dates.filter(d => d < `${version.month}-01`).map(d => getRawCell(db, version, employee.id, d)).find(c => c?.kind === 'shift')?.shiftId
      if (carry && !oldShift && inside.some(d => {const c=effectiveCell(db,version,employee,d);return !isAbsence(c) && !isOvertimeVacation(c)})) add({ rule: 'H04', level: 'error', employeeId: employee.id, date: inside[0], message: '工作段跨月，但上月续段班次缺失。请补录历史或修正员工生效日期。' })
      const photonInMonth = inside.some(d => version.cells[key(employee.id, d)]?.shiftId === 'photon' && version.cells[key(employee.id, d)]?.kind === 'shift')
      if (photonInMonth && carry && oldShift === 'photon' && version.ruleSettings.photonCarry === 'conflict') add({ rule: 'D01', level: 'error', employeeId: employee.id, date: inside[0], message: '光子跨月续排与次月禁排口径待定。请在规则设置明确选择，当前不能确认。' })
      if (banPhoton && photonInMonth && !(carry && oldShift === 'photon' && version.ruleSettings.photonCarry === 'continue')) add({ rule: 'H05', level: 'error', employeeId: employee.id, date: inside[0], message: '上月完成光子段，本月禁止新排光子，应优先安排白班' })
    }
    const complete = completedSegments(db, version, employee).filter(s => s.start.startsWith(version.month))
    const missing = (['早', '晚'] as const).filter(c => !complete.some(s => s.category === c))
    if (missing.length) add({ rule: 'P01', level: 'warning', employeeId: employee.id, message: `本月未完成${missing.join('、')}班完整工作段；跨月未结束段暂不计完成` })
    if (banPhoton && !complete.some(s => s.category === '白')) add({ rule: 'P03', level: 'warning', employeeId: employee.id, message: '上月完成光子段，本月白班目标尚未完成，可继续调整或递延' })
    const unassigned = daysInMonth(version.month).filter(d => activeOn(employee, d) && (!effectiveCell(db, version, employee, d) || effectiveCell(db, version, employee, d)?.kind === 'unassigned')).length
    if (unassigned) add({ rule: 'UNASSIGNED', level: 'warning', employeeId: employee.id, message: `有${unassigned}天未分配，不自动转成休息、休假或请假` })
  }
  return issues
}
