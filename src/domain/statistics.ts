import type { Database, Version } from './types'
import { daysInMonth } from './dates'
import { activeOn, completedSegments, effectiveCell, key, orderedEmployees } from './model'
import { coverage } from './validation'

export function employeeStatistics(db: Database, version: Version) {
  return orderedEmployees(db).filter(e => version.employeeIds.includes(e.id)).map(employee => {
    const dates = daysInMonth(version.month).filter(d => activeOn(employee, d))
    const cells = dates.map(d => effectiveCell(db, version, employee, d))
    const complete = completedSegments(db, version, employee).filter(s => s.start.startsWith(version.month))
    return {
      employee, work: cells.filter(c => c?.kind === 'shift').length,
      categories: Object.fromEntries(['早', '中', '晚', '白', '光子'].map(category => [category, cells.filter(c => c?.kind === 'shift' && db.shifts.find(s => s.id === c.shiftId)?.category === category).length])),
      rooms: Object.fromEntries(db.rooms.map(r => [r.id, cells.filter(c => c?.kind === 'shift' && db.shifts.find(s => s.id === c.shiftId)?.roomId === r.id).length])),
      vacation: cells.filter(c => c?.kind === 'vacation').length, rest: cells.filter(c => c?.kind === 'rest').length, leave: cells.filter(c => c?.kind === 'leave').length,
      empty: cells.filter(c => !c || c.kind === 'unassigned').length,
      early: complete.some(s => s.category === '早'), late: complete.some(s => s.category === '晚'),
    }
  })
}
export function summary(db: Database, version: Version) {
  const rows = coverage(db, version), expected = rows.reduce((n, r) => n + r.expected, 0), actual = rows.reduce((n, r) => n + r.actual, 0)
  const count = rows.filter(r => r.expected > 0).length, pairs = rows.filter(r => r.expected > 0 && r.expected === r.actual).length
  return { expected, actual, gap: rows.reduce((n, r) => n + r.gap, 0), excess: rows.reduce((n, r) => n + r.excess, 0), coverage: expected ? rows.reduce((n, r) => n + Math.min(r.expected, r.actual), 0) / expected : null, paired: count ? pairs / count : null, vacation: employeeStatistics(db, version).reduce((n,r) => n+r.vacation,0), leave: employeeStatistics(db, version).reduce((n, r) => n + r.leave, 0), openDays: daysInMonth(version.month).filter(d => version.calendar[d]).length }
}
export function debtFulfillment(db: Database, debt: Database['debts'][number]) {
  for (const [month, id] of Object.entries(db.activeVersions).sort(([a], [b]) => a.localeCompare(b))) {
    if (month < debt.due) continue
    const v = db.versions.find(v => v.id === id), employee = db.employees.find(e => e.id === debt.employeeId)
    if (!v || !employee || v.status !== 'confirmed') continue
    const match = completedSegments(db, v, employee).find(s => s.category === debt.category && s.start.slice(0, 7) >= debt.due)
    if (match) return { version: v, segment: match }
  }
  return undefined
}
export function assignmentDetails(db: Database, version: Version, employeeId?: string, category?: string) {
  return daysInMonth(version.month).flatMap(date => db.employees.filter(e => version.employeeIds.includes(e.id) && (!employeeId || e.id === employeeId)).flatMap(e => {
    const cell = version.cells[key(e.id, date)]; if (!cell || cell.kind !== 'shift') return []
    const shift = db.shifts.find(s => s.id === cell.shiftId), room = db.rooms.find(r => r.id === shift?.roomId)
    if (category && shift?.category !== category) return []
    return [{ date, employee: e.name, code: e.code, room: room?.name || '', category: shift?.category || '', locked: cell.locked }]
  }))
}
