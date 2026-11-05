import type { Database, DayCoverage, Issue, Version } from './types'
import { nextRotationCategory, rotationCategory } from './rotation'
import { monthlyRooms } from './room-diversity'
import { manualMixedSegment } from './manual-segments'
import { earlyLateStatus } from './monthly-goals'
import { daysInMonth } from './dates'
import { activeOn, sourceVersion, completedSegments, effectiveCell, getRawCell, isAbsence, isOvertimeVacation, key, oppositeRoom, priorPhoton, required, workSegments } from './model'

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
    if (cell.kind !== 'shift' && cell.kind!=='overtime' && cell.kind!=='custom') continue
    const [employeeId, date] = cellKey.split('|') as [string, string]
    const employee = db.employees.find(e => e.id === employeeId)
    if (!employee || !version.employeeIds.includes(employeeId) || !activeOn(employee, date)) add({ rule: 'H03', level: 'error', employeeId, date, message: '员工不在当前版本名单或任职有效日期内' })
    if(cell.kind==='custom' && (!cell.customName?.trim() || cell.customName.trim().length>30)) add({rule:'H03',level:'error',employeeId,date,message:'自定义班次名称无效'})
    if(cell.kind==='shift' && version.vacationPlans.some(p=>p.employeeId===employeeId && p.dates.includes(date)))add({rule:'H06',level:'error',employeeId,date,message:'预定休假日安排了普通班次；人工调整已保存，请核对计划与实际差异'})
    if (cell.kind==='shift' && !db.shifts.some(s => s.id === cell.shiftId)) add({ rule: 'H03', level: 'error', employeeId, date, message: '班次不存在，请重新选择班次' })
  }
  const previous = sourceVersion(db,version)
  if (!previous) add({ rule: 'HISTORY', level: 'warning', message: '首次排班：以本月首日为起点；跳过上月光子禁排、房间历史偏好和跨月续班，其余规则正常执行，可手工调整。' })
  for (const employee of db.employees.filter(e => version.employeeIds.includes(e.id))) {
    const employeeSegments = workSegments(db,version,employee)
    const banPhoton = priorPhoton(db, version.month, employee,version).length > 0 || employeeSegments.some(s => s.start < `${version.month}-01` && s.dates.some(d => d < `${version.month}-01` && getRawCell(db,version,employee.id,d)?.shiftId === 'photon'))
    for (const segment of employeeSegments) {
      if (!segment.bounded) add({ rule: 'H04', level: 'error', employeeId: employee.id, date: segment.start, message: '连续工作超过62天，无法确认休息边界；请补充日历' })
      const inside = segment.dates.filter(d => d.startsWith(version.month))
      const assignments = segment.dates.map(d => getRawCell(db, version, employee.id, d)).filter(c => c?.kind === 'shift')
      const shiftIds = new Set(assignments.map(c => c!.shiftId))
      const manualMix=manualMixedSegment(db,version,segment)
      if (shiftIds.size > 1) {
        const credit=completedSegments(db,version,employee).find(s=>s.id===segment.id && s.credited)
        add({ rule: manualMix?'P05':'H04', level: manualMix?'warning':'error', employeeId: employee.id, date: inside[0], message: manualMix ? `人工混班段${segment.start.slice(5)}—${segment.end.slice(5)}已保留，允许确认但仍须逐日每班2人。${credit?`仅一天调整，按原${credit.category}班段计达成，不额外计新类别。`:'多日混班未形成完整段，不计早晚达成。'}自动排班不会生成混班段。` : `工作段${segment.start.slice(5)}—${segment.end.slice(5)}内存在未经人工调整的不同房间或班次` })
      }
      const carry = segment.start < `${version.month}-01`
      if(!carry && !manualMix && version.ruleSettings.redYellowOrder){
        const expected=nextRotationCategory(db,version,employee.id,segment.start)
        const actual=[...new Set(assignments.map(c=>rotationCategory(db,c)).filter(Boolean))]
        if(expected && actual.some(category=>category!==expected)){
          const previousOrdinary=[...(previous?workSegments(db,previous,employee):[]),...employeeSegments].filter(s=>s.end<segment.start && s.dates.some(d=>rotationCategory(db,getRawCell(db,version,employee.id,d)))).sort((a,b)=>a.end.localeCompare(b.end)).at(-1)
          const followsManualMix=previousOrdinary && manualMixedSegment(db,version,previousOrdinary)
          add({rule:followsManualMix?'P05':'H07',level:followsManualMix?'warning':'error',employeeId:employee.id,date:inside[0],message:followsManualMix?`上个人工混班段改变了轮转参照，本段原安排保留。下次自动生成将从最近一次红黄普通班接续早→中→晚顺序。`:`红/黄房间应按早→中→晚循环；本工作段应排${expected}班，已有安排未按顺序。人工安排保留，请调整或解锁后重排。`})
        }
      }
      if(!carry)for(const shiftId of shiftIds){const shift=db.shifts.find(s=>s.id===shiftId),preferred=shift && oppositeRoom(db,previous,employee.id,shift.category)
        if(preferred && preferred!==shift?.roomId)add({rule:'P02',level:'warning',employeeId:employee.id,date:inside[0],shiftId,message:`${shift!.category}班尚未采用上月同类别相反房间偏好（累计天数优先，平票取最后一次）`})
      }
      const oldShift = segment.dates.filter(d => d < `${version.month}-01`).map(d => getRawCell(db, version, employee.id, d)).find(c => c?.kind === 'shift')?.shiftId
      if (carry && !oldShift && inside.some(d => {const c=effectiveCell(db,version,employee,d);return !isAbsence(c) && !isOvertimeVacation(c) && c?.kind!=='custom' && c?.kind!=='rest' && c?.kind!=='overtime'})) add({ rule: 'H04', level: 'error', employeeId: employee.id, date: inside[0], message: '工作段跨月，但上月续段班次缺失。请补录历史或修正员工生效日期。' })
      const photonInMonth = inside.some(d => version.cells[key(employee.id, d)]?.shiftId === 'photon' && version.cells[key(employee.id, d)]?.kind === 'shift')
      if (banPhoton && photonInMonth && !(carry && oldShift === 'photon')) add({ rule: 'H05', level: 'error', employeeId: employee.id, date: inside[0], message: '上月完成光子段，本月禁止新排光子，应优先安排白班' })
    }
    const complete = completedSegments(db, version, employee).filter(s => s.start.startsWith(version.month))
    const rooms = monthlyRooms(db,version,employee.id)
    if(version.ruleSettings.monthlyRoomDiversity && rooms.size===1){
      const roomId=[...rooms.keys()][0],room=db.rooms.find(r=>r.id===roomId)?.name || roomId
      add({rule:'P04',level:'warning',employeeId:employee.id,message:`本月普通班仅安排在${room}，尚未达成至少两个房间的目标。请核对可排工作段、休假、需求开关及保留班次；可解锁后重排。系统未放宽跨月续班、段内同班或早中晚顺序。`})
    }
    const goalStatus=earlyLateStatus(db,version,employee),missing=goalStatus.missing
    if (missing.length) {
      const finished=employeeSegments.filter(s=>s.start.startsWith(version.month) && s.end<=daysInMonth(version.month).at(-1)!).length
      const carrying=employeeSegments.filter(s=>s.end>daysInMonth(version.month).at(-1)!).length
      add({ rule: goalStatus.canDefer?'P06':'P01', level: 'warning', employeeId: employee.id, message: goalStatus.canDefer?`本月${missing.join('、')}段允许顺延到下月优先补达。依据：${goalStatus.reasons.join('；')}。当前实际达成仍为早${complete.filter(s=>s.category==='早').length}段、晚${complete.filter(s=>s.category==='晚').length}段。`:`本月未完成${missing.join('、')}班完整工作段；已完成早${complete.filter(s=>s.category==='早').length}段、晚${complete.filter(s=>s.category==='晚').length}段。当月可结束的新工作段${finished}段，月底跨月待续${carrying}段。请核对两人配对容量、休假、保留班次及早→中→晚顺序；跨月未结束段暂不计完成。` })
    }
    if (banPhoton && !complete.some(s => s.category === '白')) add({ rule: 'P03', level: 'warning', employeeId: employee.id, message: '上月完成光子段，本月白班目标尚未完成，可继续调整或递延' })
    const unassigned = daysInMonth(version.month).filter(d => activeOn(employee, d) && (!effectiveCell(db, version, employee, d) || effectiveCell(db, version, employee, d)?.kind === 'unassigned')).length
    if (unassigned) add({ rule: 'UNASSIGNED', level: 'warning', employeeId: employee.id, message: `有${unassigned}天未分配，不自动转成休息、休假或请假` })
  }
  return issues
}
