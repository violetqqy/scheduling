import type { Database, Employee, GenerateResult, Shift, Version } from './types'
import { addMonths, daysInMonth, uid } from './dates'
import { activeOn, activeVersion, completedSegments, getRawCell, isAbsence, isOvertimeVacation, key, newVersion, oppositeRoom, orderedEmployees, required, workSegments } from './model'
import { coverage, validate } from './validation'
import { nextRotationCategory } from './rotation'
import type { RotationCategory } from './rotation'
import { monthlyRooms } from './room-diversity'
import { earlyLateCapacity, earlyLateStatus, stepsToCategories, stepsToEarlyLate } from './monthly-goals'
import { vacationDebts } from './vacation-deferrals'
import { earlyLateDebts } from './early-late-deferrals'
import { prepareMonth } from './prepare-month'

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
function lowerPenalty(candidate: number[], current?: number[]) {
  if (!current) return true
  const firstDifference = candidate.findIndex((value, index) => value !== current[index])
  return firstDifference >= 0 && candidate[firstDifference]! < current[firstDifference]!
}

export function generate(db: Database, month: string, mode: 'fill' | 'rebuild' = 'rebuild', attempts = 12): GenerateResult {
  const started = performance.now(), days = daysInMonth(month)
  if (!days.length) throw new Error('请选择有效月份')
  const base = activeVersion(db, month), previous = activeVersion(db, addMonths(month, -1)), employees = orderedEmployees(db).filter(e => days.some(d => activeOn(e, d)))
  if (!employees.length) throw new Error('目标月没有在职员工，请先导入员工名单或调整生效日期')
  const template = newVersion(db, month); template.sourceVersionId = previous?.id; template.parentId = base?.id
  template.vacationImpacts=structuredClone(base?.vacationImpacts || [])
  template.manualMixedSegments=[...(base?.manualMixedSegments || [])]
  template.segmentBaselines=structuredClone(base?.segmentBaselines || [])
  template.name = `自动排班 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  if (base) for (const [k, c] of Object.entries(base.cells)) {
    const [employeeId] = k.split('|')
    const unavailable=template.cells[k]?.kind==='vacation' || template.cells[k]?.kind==='rest'
    const preserve=c.kind==='custom' || c.kind==='overtime' || c.kind==='shift' && c.locked ||
      isAbsence(c) && c.source!=='plan' ||
      c.kind==='rest' && c.source!=='calendar' ||
      !unavailable && (mode==='fill' && c.kind==='shift' || c.kind==='unassigned' && c.source==='manual')
    if(preserve){template.cells[k]=structuredClone(c);if(!template.employeeIds.includes(employeeId))template.employeeIds.push(employeeId)}
  }
  // Historical rules are derived before assigning any target-month shift.
  const preparation=prepareMonth(db,template),bans=preparation.bans,pendingDebts=preparation.pending
  const segments = employees.flatMap(e => workSegments(db, template, e))
  const segmentOf = new Map<string, typeof segments[number]>()
  for (const segment of segments) for (const date of segment.dates) segmentOf.set(key(segment.employeeId, date), segment)
  const preferences=new Map(employees.map(e=>[e.id,Object.fromEntries(['早','中','晚'].map(category=>[category,oppositeRoom(db,previous,e.id,category)]))]))
  const completable = new Map(segments.map(segment=>{
    const workable=segment.dates.filter(date=>!isAbsence(template.cells[key(segment.employeeId,date)]) && !isOvertimeVacation(template.cells[key(segment.employeeId,date)]))
    const fixed=new Set(workable.map(date=>template.cells[key(segment.employeeId,date)]).filter(c=>c?.kind==='shift').map(c=>c!.shiftId))
    const possible=segment.start.startsWith(month) && segment.end<=days.at(-1)! && workable.length>0 &&
      workable.every(date=>!['custom','rest','overtime'].includes(template.cells[key(segment.employeeId,date)]?.kind || '')) &&
      db.shifts.some(shift=>(!fixed.size || fixed.size===1 && fixed.has(shift.id)) && workable.every(date=>required(db,date,shift.id,template)>0))
    return [segment.id,{possible,workable}] as const
  }))
  const goalCapacity=earlyLateCapacity(db,template,employees[0]!)
  const goalCandidates=employees.filter(e=>segments.filter(s=>s.employeeId===e.id && completable.get(s.id)?.possible).length>=2)
  const goalEmployees=new Set(goalCandidates.slice(0,goalCapacity).map(e=>e.id))
  let best: Version | undefined, bestPenalty: number[] | undefined, usedAttempts = 0
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    usedAttempts++
    const v = structuredClone(template), segmentShift = new Map<string, string>(), blockedSegments = new Set<string>()
    const rotationTargets=new Map<string,RotationCategory | undefined>()
    for (const segment of segments) {
      const fixed = segment.dates.map(date => date < `${month}-01` ? getRawCell(db, template, segment.employeeId, date) : template.cells[key(segment.employeeId, date)]).filter(c => c?.kind === 'shift')
      const ids = [...new Set(fixed.map(c => c!.shiftId!))]
      if (ids.length === 1) segmentShift.set(segment.id, ids[0]!)
      if (ids.length > 1 || segment.start < `${month}-01` && !ids.length) blockedSegments.add(segment.id)
    }
    for (const date of days) {
      const capacity = new Map(db.shifts.map(s => [s.id, required(db, date, s.id, v) - v.employeeIds.filter(id => v.cells[key(id,date)]?.kind==='shift' && v.cells[key(id,date)]?.shiftId===s.id).length]))
      const available = employees.filter(e => activeOn(e, date) && (!v.cells[key(e.id, date)] || v.cells[key(e.id, date)]?.kind === 'unassigned') && !v.cells[key(e.id, date)]?.locked)
      const achieved = new Map(employees.map(e => [e.id, new Set(completedSegments(db, v, e).filter(s => s.start.startsWith(month) && s.end < date).map(s => s.category))]))
      const statuses=new Map(employees.map(e=>[e.id,earlyLateStatus(db,v,e)]))
      const rooms = new Map(employees.map(e => [e.id, monthlyRooms(db,v,e.id)]))
      const remaining = new Map(employees.map(e=>[e.id,segments.filter(s=>s.employeeId===e.id && s.end>=date && completable.get(s.id)?.possible && !blockedSegments.has(s.id)).length]))
      const selected = match(available, db.shifts, capacity, (employee, shift) => {
        const segment = segmentOf.get(key(employee.id, date))
        if (!segment || blockedSegments.has(segment.id) || (capacity.get(shift.id) || 0) <= 0) return false
        const fixed = segmentShift.get(segment.id)
        if (fixed && fixed !== shift.id) return false
        if(['red','orange'].includes(shift.roomId) && ['早','中','晚'].includes(shift.category) && segment.start>=`${month}-01`){
          if(!rotationTargets.has(segment.id))rotationTargets.set(segment.id,nextRotationCategory(db,v,employee.id,segment.start))
          const expected=rotationTargets.get(segment.id)
          if(expected && shift.category!==expected)return false
        }
        if (shift.category === '光子' && bans.has(employee.id)) return segment.start < `${month}-01` && fixed === 'photon'
        return true
      }, (employee, shift) => {
        const order = employees.indexOf(employee), done = achieved.get(employee.id)!, segment = segmentOf.get(key(employee.id, date))!
        const priority = employees.length - order
        let score = 1000 + priority * 2
        // Diversify across whole work segments before pursuing historical room preferences.
        // Include locked future assignments so an earlier free segment can use another room.
        const usedRooms = rooms.get(employee.id)!
        if (usedRooms.size === 1 && !usedRooms.has(shift.roomId)) score += 300
        if (['red','orange'].includes(shift.roomId) && ['早','中','晚'].includes(shift.category) && completable.get(segment.id)?.possible &&
          completable.get(segment.id)!.workable.every(d=>required(db,d,shift.id,template)>0)) {
          const owed=new Set(pendingDebts.filter(d=>d.employeeId===employee.id && ['早','晚'].includes(d.category) && !statuses.get(employee.id)!.complete.some(s=>s.category===d.category)).map(d=>d.category))
          const owedSteps=stepsToCategories(shift.category as RotationCategory,owed)
          if(owedSteps){
            const slack=remaining.get(employee.id)!-owedSteps
            score+=500000+priority*200
            if(slack>=0)score+=Math.round(1000000/(slack+1))
          }
          const steps=stepsToEarlyLate(shift.category as RotationCategory,done)
          if(steps && goalEmployees.has(employee.id)){
            const slack=remaining.get(employee.id)!-steps
            score+=10000+priority*200
            if(slack>=0)score+=Math.round(100000/(slack+1))
          }
        }
        if (preferences.get(employee.id)?.[shift.category] === shift.roomId) score += 90
        if (bans.has(employee.id) && shift.category === '白' && !done.has('白')) score += 500
        if (pendingDebts.some(d => d.employeeId === employee.id && d.category === shift.category && !done.has(d.category))) score += 200
        // Prefer workers who can cover the remaining segment, preserving flexible substitutes.
        const futureAvailable = segment.dates.filter(d => d >= date && d.startsWith(month) && !isAbsence(template.cells[key(employee.id, d)]) && !['overtime','custom','rest'].includes(template.cells[key(employee.id,d)]?.kind || '')).length
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
    const goals:number[]=[],owed:number[]=[]
    const completed=new Map(employees.map(e=>[e.id,completedSegments(db,v,e).filter(s=>s.start.startsWith(month))]))
    for (const employee of employees) {
      const status=earlyLateStatus(db,v,employee)
      // A deferral is permission to carry a remaining goal, not a reason to avoid it.
      goals.push(status.missing.length)
      owed.push(pendingDebts.filter(d=>d.employeeId===employee.id && ['早','晚'].includes(d.category) && !status.complete.some(s=>s.category===d.category)).length)
    }
    const deferred = pendingDebts.filter(d=>!['早','晚'].includes(d.category) && employees.some(e=>e.id===d.employeeId) && !completed.get(d.employeeId)!.some(s=>s.category===d.category)).length +
      employees.filter(e=>bans.has(e.id) && !completed.get(e.id)!.some(s=>s.category==='白')).length
    const rotation=segments.filter(s=>s.start.startsWith(month)).reduce((n,s)=>{
      const cell=s.dates.map(d=>v.cells[key(s.employeeId,d)]).find(c=>c?.kind==='shift')
      const shift=db.shifts.find(sh=>sh.id===cell?.shiftId),preferred=shift && preferences.get(s.employeeId)?.[shift.category]
      return n+(preferred && shift?.roomId!==preferred?1:0)
    },0)
    // Lexicographic priorities cannot be overturned by a large employee count.
    // Zero assigned rooms also remains unmet, preventing an empty employee from hiding a failure.
    const diversity = employees.filter(e => monthlyRooms(db,v,e.id).size < 2).length
    const penalty = [hard, ...owed, ...goals, deferred, diversity, rotation]
    if (lowerPenalty(penalty,bestPenalty)) { bestPenalty = penalty; best = v }
    if (penalty.every(n => n === 0)) break
  }
  const version = best!
  const issues = validate(db, version)
  const fallbackId = employees.find(e => issues.some(i => i.rule === 'P01' && i.employeeId === e.id))?.id
  version.run = { attempts: usedAttempts, duration: Math.round(performance.now() - started), fallbackId,
    preparation:{sourceVersionId:previous?.id,carrySegments:preparation.carrySegments.length,pendingDebts:structuredClone(pendingDebts)},
    note: `${previous ? '先分析上月参考版本，生成跨月续段、早晚顺延、休假递延及光子转白任务，再生成本月班表。' : '首次排班：从本月首日开始，跳过缺失的上月条件，已登记的更早递延仍可补达。'}在覆盖与硬约束内，先补以前月份欠下的早晚段，再按名单优先满足本月早晚目标；完整白班、光子或整段预定休假允许未完成早晚顺延。随后补中/光子/白目标，优化房间分散与上月相反房间偏好。缺口或目标提醒不代表已经证明业务无解。` }
  const debts=[...new Map([...preparation.debts,...vacationDebts(db,version),...earlyLateDebts(db,version)].map(d=>[d.id,d])).values()]
  version.id = uid()
  return { version, issues, debts }
}
