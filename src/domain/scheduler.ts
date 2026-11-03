import type { Database, Debt, Employee, GenerateResult, Shift, Version } from './types'
import { addMonths, daysInMonth, uid } from './dates'
import { activeOn, activeVersion, completedSegments, getRawCell, isAbsence, key, newVersion, orderedEmployees, priorPhoton, required, workSegments } from './model'
import { coverage, validate } from './validation'
import { vacationOn } from './absences'
import { debtFulfillment } from './statistics'

// Successive shortest augmenting paths: maximum daily coverage, then minimum cost.
// A chosen shift becomes a constraint for the rest of that employee's work segment.
interface Edge { to: number; reverse: number; capacity: number; cost: number; employee?: string; shift?: string }
function match(employees: Employee[], shifts: Shift[], capacity: Map<string, number>, eligible: (e: Employee, s: Shift) => boolean, score: (e: Employee, s: Shift) => number) {
  const count = 2 + employees.length + shifts.length, sink = count - 1, graph: Edge[][] = Array.from({ length: count }, () => [])
  const edge = (a: number, b: number, cap: number, cost: number, employee?: string, shift?: string) => {
    graph[a]!.push({ to: b, reverse: graph[b]!.length, capacity: cap, cost, employee, shift })
    graph[b]!.push({ to: a, reverse: graph[a]!.length - 1, capacity: 0, cost: -cost })
  }
  employees.forEach((employee, i) => {
    edge(0, i + 1, 1, 0)
    shifts.forEach((shift, j) => { if (eligible(employee, shift)) edge(i + 1, employees.length + 1 + j, 1, -score(employee, shift), employee.id, shift.id) })
  })
  shifts.forEach((shift, j) => edge(employees.length + 1 + j, sink, Math.max(0, capacity.get(shift.id) || 0), 0))
  while (true) {
    const distance = Array(count).fill(Infinity), previousNode = Array(count).fill(-1), previousEdge = Array(count).fill(-1)
    const queued = Array(count).fill(false), queue = [0]; distance[0] = 0; queued[0] = true
    for (let at = 0; at < queue.length; at++) {
      const node = queue[at]!; queued[node] = false
      graph[node]!.forEach((e, index) => {
        if (e.capacity > 0 && distance[e.to] > distance[node] + e.cost) {
          distance[e.to] = distance[node] + e.cost; previousNode[e.to] = node; previousEdge[e.to] = index
          if (!queued[e.to]) { queued[e.to] = true; queue.push(e.to) }
        }
      })
    }
    if (!Number.isFinite(distance[sink])) break
    for (let node = sink; node !== 0; node = previousNode[node]) {
      const e = graph[previousNode[node]]![previousEdge[node]]!; e.capacity--; graph[node]![e.reverse]!.capacity++
    }
  }
  return graph.flat().filter(e => e.employee && e.shift && e.capacity === 0).map(e => ({ employeeId: e.employee!, shiftId: e.shift! }))
}
function noise(id: string, attempt: number) { let h = attempt * 7919 + 17; for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 31); return (h >>> 0) % 97 }

export function generate(db: Database, month: string, mode: 'fill' | 'rebuild' = 'rebuild', attempts = 12): GenerateResult {
  const started = performance.now(), days = daysInMonth(month)
  if (!days.length) throw new Error('请选择有效月份')
  const base = activeVersion(db, month), previous = activeVersion(db, addMonths(month, -1)), employees = orderedEmployees(db).filter(e => days.some(d => activeOn(e, d)))
  if (!employees.length) throw new Error('目标月没有在职员工，请先导入员工名单或调整生效日期')
  const template = newVersion(db, month); template.sourceVersionId = previous?.id; template.parentId = base?.id
  template.name = `自动排班 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  if (base) for (const [k, c] of Object.entries(base.cells)) {
    const [employeeId,date] = k.split('|') as [string,string]
    if (template.cells[k]?.kind === 'vacation' && c.kind !== 'leave') continue
    if (c.kind === 'vacation' && c.planId && !vacationOn(db,employeeId,date)) continue
    if (isAbsence(c) || (c.kind === 'rest' && c.source !== 'calendar') || c.locked && c.source !== 'calendar' || mode === 'fill' && c.kind === 'shift' || c.kind === 'unassigned' && c.source === 'manual') template.cells[k] = { ...c }
  }
  const bans = new Set(employees.filter(e => priorPhoton(db, month, e).length).map(e => e.id))
  const segments = employees.flatMap(e => workSegments(db, template, e))
  for (const segment of segments) if (segment.start < `${month}-01` && db.rules.photonCarry === 'continue' && segment.dates.some(d => d < `${month}-01` && getRawCell(db,template,segment.employeeId,d)?.shiftId === 'photon')) bans.add(segment.employeeId)
  const pendingDebts = db.debts.filter(d => !debtFulfillment(db,d))
  const segmentOf = new Map<string, typeof segments[number]>()
  for (const segment of segments) for (const date of segment.dates) segmentOf.set(key(segment.employeeId, date), segment)
  const oldRoom = new Map(employees.map(e => {
    const cells = previous ? Object.entries(previous.cells).filter(([k, c]) => k.startsWith(`${e.id}|`) && c.kind === 'shift').map(([, c]) => db.shifts.find(s => s.id === c.shiftId)?.roomId) : []
    return [e.id, cells.filter(r => r === 'red').length > cells.filter(r => r === 'orange').length ? 'red' : 'other']
  }))
  let best: Version | undefined, bestPenalty = Infinity, usedAttempts = 0
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    usedAttempts++
    const v = structuredClone(template), segmentShift = new Map<string, string>(), blockedSegments = new Set<string>()
    for (const segment of segments) {
      const fixed = segment.dates.map(date => date < `${month}-01` ? getRawCell(db, template, segment.employeeId, date) : template.cells[key(segment.employeeId, date)]).filter(c => c?.kind === 'shift')
      const ids = [...new Set(fixed.map(c => c!.shiftId!))]
      if (ids.length === 1) segmentShift.set(segment.id, ids[0]!)
      if (ids.length > 1 || segment.start < `${month}-01` && !ids.length) blockedSegments.add(segment.id)
    }
    for (const date of days) {
      const capacity = new Map(db.shifts.map(s => [s.id, required(db, date, s.id, v) - employees.filter(e => v.cells[key(e.id, date)]?.kind === 'shift' && v.cells[key(e.id, date)]?.shiftId === s.id).length]))
      const available = employees.filter(e => activeOn(e, date) && (!v.cells[key(e.id, date)] || v.cells[key(e.id, date)]?.kind === 'unassigned') && !v.cells[key(e.id, date)]?.locked)
      const achieved = new Map(employees.map(e => [e.id, new Set(completedSegments(db, v, e).filter(s => s.start.startsWith(month) && s.end < date).map(s => s.category))]))
      const selected = match(available, db.shifts, capacity, (employee, shift) => {
        const segment = segmentOf.get(key(employee.id, date))
        if (!segment || blockedSegments.has(segment.id) || (capacity.get(shift.id) || 0) <= 0) return false
        const fixed = segmentShift.get(segment.id)
        if (fixed && fixed !== shift.id) return false
        if (shift.category === '光子' && bans.has(employee.id)) return segment.start < `${month}-01` && fixed === 'photon' && db.rules.photonCarry === 'continue'
        return true
      }, (employee, shift) => {
        const order = employees.indexOf(employee), done = achieved.get(employee.id)!, segment = segmentOf.get(key(employee.id, date))!
        const priority = employees.length - order
        let score = 1000 + priority * 2
        if ((shift.category === '早' || shift.category === '晚') && !done.has(shift.category)) score += 1000 + priority * 100
        if (oldRoom.get(employee.id) === 'red' && shift.roomId === 'orange') score += 90
        if (bans.has(employee.id) && shift.category === '白' && !done.has('白')) score += 500
        if (pendingDebts.some(d => d.employeeId === employee.id && d.category === shift.category && d.due <= month)) score += 200
        // Prefer workers who can cover the remaining segment, preserving flexible substitutes.
        const futureAvailable = segment.dates.filter(d => d >= date && d.startsWith(month) && !isAbsence(template.cells[key(employee.id, d)])).length
        score += futureAvailable * 5 + noise(`${employee.id}:${shift.id}`, attempt) * (attempt === 0 ? 0 : 2)
        return score
      })
      for (const assignment of selected) {
        v.cells[key(assignment.employeeId, date)] = { kind: 'shift', shiftId: assignment.shiftId, source: 'auto', locked: false }
        const segment = segmentOf.get(key(assignment.employeeId, date))
        if (segment) segmentShift.set(segment.id, assignment.shiftId)
      }
    }
    const cov = coverage(db, v), hard = cov.reduce((n, r) => n + r.gap + r.excess, 0)
    let goal = 0
    for (const [index, employee] of employees.entries()) {
      const done = completedSegments(db, v, employee).filter(s => s.start.startsWith(month))
      for (const category of ['早', '晚']) if (!done.some(s => s.category === category)) goal += employees.length - index
    }
    const penalty = hard * 1_000_000 + goal
    if (penalty < bestPenalty) { bestPenalty = penalty; best = v }
    if (hard === 0 && goal === 0) break
  }
  const version = best!
  const issues = validate(db, version)
  const fallbackId = employees.find(e => issues.some(i => i.rule === 'P01' && i.employeeId === e.id))?.id
  version.run = { attempts: usedAttempts, duration: Math.round(performance.now() - started), fallbackId, note: `${previous ? '依据上月参考版本排班。' : '首次排班：从本月首日开始，不使用上月光子禁排、房间轮转或跨月续班。'}使用工作段约束和逐日最小费用匹配，尝试多个候选。缺口表示本次候选未排满，不代表已经证明业务无解。` }
  const debts: Debt[] = []
  for (const employee of employees) for (const segment of priorPhoton(db, month, employee)) {
    const id = `photon-white:${segment.id}`
    if (!db.debts.some(d => d.id === id)) debts.push({ id, employeeId: employee.id, category: '白', origin: segment.start.slice(0, 7), due: month, note: `上月光子段 ${segment.start}—${segment.end} 转白班` })
  }
  version.id = uid()
  return { version, issues, debts }
}
