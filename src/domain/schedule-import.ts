import type { Database, ImportRow } from './types'
import { addMonths, uid } from './dates'
import { activeVersion, editableVersion, inputHash, key, newVersion } from './model'
import { makeOvertimeCell, saveVacationPlan, vacationOn } from './absences'

export function applyScheduleImport(draft: Database, rows: ImportRow[], target: string, purpose: string, filename: string, allowNew: boolean) {
    const included = rows.filter(r => !r.skip)
    if (included.some(r => r.error)) throw new Error('请先处理或跳过全部导入错误')
    const acceptedKind = ({vacation:'vacation',leave:'leave',availability:'rest'} as Record<string,string>)[purpose]
    const selectedRows = included.filter(r => r.cell && (!acceptedKind || r.cell.kind === acceptedKind))
    if (!selectedRows.length) throw new Error('没有符合所选用途的数据，请核对预览中的休假 / 请假类型与导入用途')
    const identities = new Map<string,string>()
    for (const r of selectedRows) {
      if (!r.date.startsWith(target)) throw new Error('导入日期与目标月份不一致')
      const identity=r.code || r.name
      if (identities.has(identity) && identities.get(identity) !== r.name) throw new Error('同一员工编号对应多个姓名，请先核对名单')
      identities.set(identity,r.name)
    }
    const mapping = new Map<string, string>()
    for (const row of selectedRows) {
      if (row.employeeId) continue
      if (!allowNew) throw new Error('存在新员工，请确认创建或先维护员工资料')
      const identity = row.code || row.name
      if (!mapping.has(identity)) {
        const id = uid(); let index = draft.employees.length + 1, code = row.code
        if (code && draft.employees.some(e => e.code === code)) throw new Error(`员工编号${code}重复`)
        while (!code || draft.employees.some(e => e.code === code)) code = `E${String(index++).padStart(3, '0')}`
        draft.employees.push({ id, code, name: row.name, order: draft.employees.length, from: '', to: '', note: `导入创建：${filename}，请核对生效日期` }); mapping.set(identity, id)
      }
    }
    const v = ['availability','vacation','leave'].includes(purpose) ? editableVersion(draft, target) : newVersion(draft, target)
    if (!['availability','vacation','leave'].includes(purpose)) { v.name = `${purpose === 'history' ? '历史导入' : '排班导入'} · ${filename}`; v.status = 'draft'; v.sourceVersionId = activeVersion(draft, addMonths(target, -1))?.id; draft.versions.push(v); draft.activeVersions[target] = v.id }
    for (const row of included) {
      const employeeId = row.employeeId || mapping.get(row.code || row.name)!
      if (!row.cell) continue
      if (purpose === 'vacation' && row.cell.kind !== 'vacation' || purpose === 'leave' && row.cell.kind !== 'leave' || purpose === 'availability' && row.cell.kind !== 'rest') continue
      if (row.cell.kind === 'vacation') {
        const existing = vacationOn(draft,employeeId,row.date)
        saveVacationPlan(draft,{id:existing?.id,employeeId,month:target,dates:existing?.dates || [row.date],reason:row.cell.note || `导入：${filename}`,source:'import'})
        if (v.cells[key(employeeId,row.date)]?.kind !== 'leave') v.cells[key(employeeId,row.date)] = {kind:'vacation',locked:true,source:'plan',planId:vacationOn(draft,employeeId,row.date)!.id,note:row.cell.note}
      } else if (row.cell.kind==='overtime') {
        if (row.cell.overtimeBase?.kind==='vacation' && !vacationOn(draft,employeeId,row.date)) saveVacationPlan(draft,{employeeId,month:target,dates:[row.date],reason:row.cell.overtimeBase.note || '导入加班前的预定休假',source:'import'})
        v.cells[key(employeeId,row.date)]=makeOvertimeCell(draft,employeeId,row.date,row.cell,v)
      } else {
        if (vacationOn(draft,employeeId,row.date) && row.cell.kind !== 'leave') {
          if (['history','schedule'].includes(purpose)) throw new Error(`${row.date}已有预定休假，与导入排班冲突；请先核对休假计划`)
          continue
        }
        v.cells[key(employeeId,row.date)] = structuredClone(row.cell)
      }
    }
    for (const row of rows.filter(r => r.skip && r.raw==='定位')) {
      const employeeId = row.employeeId || mapping.get(row.code || row.name)
      if (employeeId) { const k = key(employeeId,row.date), cell = v.cells[k]; if (cell) cell.note = [cell.note, row.raw].filter(Boolean).join('；'); else v.cells[k] = {kind:'unassigned',locked:false,source:'import',note:row.raw} }
    }
    if (purpose === 'history') v.status = 'imported'
    v.inputHash = inputHash(draft, target)
    return v
}
