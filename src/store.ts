import { computed, ref, shallowRef, toRaw } from 'vue'
import type { Cell, Database, Employee, GenerateResult, ImportRow, EmployeeImportRow, Page } from './domain/types'
import { daysInMonth, monthNow, uid } from './domain/dates'
import { activeOn, activeVersion, emptyDatabase, inputHash, key, openOn, required, editableVersion } from './domain/model'
import { adjustCell, availableCell, cancelLeave, cancelOvertime, removeVacationPlan, saveVacationPlan } from './domain/absences'
import type { VacationPlan } from './domain/types'
import { applyScheduleImport } from './domain/schedule-import'
import { applyEmployeeImport } from './domain/employee-import'
import { applyDemandChanges } from './domain/demand'
import type { DemandAction } from './domain/demand'
import { applyScheduleSelection, clearMonthSchedule } from './domain/schedule-edit'
import type { CellTarget, SelectionAction } from './domain/schedule-edit'
import { createDemo } from './domain/demo'
import { validate } from './domain/validation'
import { syncVacationDebts } from './domain/vacation-deferrals'
import { parseDatabase, loadDatabase, saveDatabase } from './services/storage'

export const LOGIN = { username: 'admin', password: 'Admin@123456' }
export const db = shallowRef<Database>(emptyDatabase())
export const ready = ref(false), loadError = ref(''), saving = ref(false), generating = ref(false)
export const page = ref<Page>((location.hash.slice(1) as Page) || 'overview'), month = ref(monthNow())
export const selectedEmployee = ref(''), sidebarOpen = ref(false), toast = ref<{ text: string; type: 'success' | 'error' }>()
export const settingsSection = ref('规则配置')
export const importPurpose = ref('history'), setupImport = ref(false)
export function openImport(purpose = 'history', setup = false) { importPurpose.value = purpose; setupImport.value = setup; navigate('import') }
export const authenticated = ref(sessionStorage.getItem('banxu-session') === 'local-admin-v1')
export const current = computed(() => activeVersion(db.value, month.value))
let toastTimer: ReturnType<typeof setTimeout>
export function notify(text: string, type: 'success' | 'error' = 'success') {
  toast.value = { text, type }; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.value = undefined, type === 'error' ? 7000 : 3500)
}
export function navigate(target: Page) { page.value = target; location.hash = target; sidebarOpen.value = false }
export function login(username: string, password: string) {
  if (username !== LOGIN.username || password !== LOGIN.password) return false
  authenticated.value = true; sessionStorage.setItem('banxu-session', 'local-admin-v1'); return true
}
export function logout() { authenticated.value = false; sessionStorage.removeItem('banxu-session') }
export async function initialize() {
  try {
    const saved = await loadDatabase()
    if (saved) db.value = saved
    else { const seeded = emptyDatabase(); await saveDatabase(seeded); db.value = seeded }
    ready.value = true
  } catch (error) { loadError.value = error instanceof Error ? error.message : '本地数据读取失败' }
}
export async function commit(action: string, detail: string, change: (draft: Database) => void, quiet = false) {
  if (saving.value) { notify('上一项修改仍在保存，请稍后再试', 'error'); return false }
  saving.value = true
  try {
    const draft = structuredClone(toRaw(db.value)); change(draft); syncVacationDebts(draft)
    draft.logs.unshift({ id: uid(), time: new Date().toISOString(), action, detail }); draft.logs = draft.logs.slice(0, 300)
    await saveDatabase(draft); db.value = draft
    if (!quiet) notify(action)
    return true
  } catch (error) { notify(error instanceof Error ? error.message : '操作失败，本次没有写入数据', 'error'); return false }
  finally { saving.value = false }
}
export const editable = editableVersion
export async function savePlan(plan: Pick<VacationPlan,'employeeId'|'month'|'dates'|'reason'> & {id?:string}) {
  return commit('已保存预定休假', `${plan.month}，${plan.dates.length}天`, draft => { saveVacationPlan(draft,plan) })
}
export async function removePlan(id: string, date?: string) { return commit('已取消预定休假', date || '取消整条计划；原班次需重新补排', draft => { removeVacationPlan(draft,id,date) }) }
export async function saveLeaveAdjustment(employeeId: string, dates: string[], note: string, previousDate?: string) {
  return commit('已保存事后请假',`${dates.length}天`,draft => {
    if (previousDate && !dates.includes(previousDate)) cancelLeave(draft,employeeId,previousDate)
    for (const date of dates) adjustCell(draft,employeeId,date,{kind:'leave',locked:true,source:'manual',note})
  })
}
export async function removeLeave(employeeId: string, date: string) { return commit('已撤销事后请假',date,draft => { cancelLeave(draft,employeeId,date) }) }
export async function createMonth() { return commit('已建立月度草稿', month.value, draft => { editable(draft, month.value) }) }
export async function saveDemandSettings(target:string, dates:string[], actions:Record<string,DemandAction>) {
  let plan:ReturnType<typeof applyDemandChanges> | undefined
  const success=await commit('已更新按日期需求',`${target}；日期：${dates.join('、')}`,draft=>{plan=applyDemandChanges(draft,target,dates,actions)},true)
  if (success && plan) notify(`已保存${plan.eligible.length}天的${plan.changes.length}项需求配置${plan.skipped.length?`，跳过${plan.skipped.length}个休息日`:''}；重新生成后生效`)
  return success
}
export async function generateMonth(target: string, mode: 'fill' | 'rebuild') {
  if (generating.value || saving.value) return false
  if (!db.value.employees.length) { notify('请先新增或导入员工', 'error'); return false }
  generating.value = true
  const snapshot = structuredClone(toRaw(db.value)), hash = inputHash(snapshot, target)
  const baseStamp = JSON.stringify([activeVersion(snapshot,target)?.id, activeVersion(snapshot,target)?.updated])
  try {
    const result = await new Promise<GenerateResult>((resolve, reject) => {
      const worker = new Worker(new URL('./services/scheduler.worker.ts', import.meta.url), { type: 'module' })
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('本次计算超过60秒，未证明无解。请缩小数据范围或调整约束后重试。')) }, 60000)
      worker.onmessage = event => { clearTimeout(timeout); worker.terminate(); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result) }
      worker.onerror = () => { clearTimeout(timeout); worker.terminate(); reject(new Error('排班计算异常，请检查数据后重试')) }
      worker.postMessage({ db: snapshot, month: target, mode })
    })
    if (inputHash(db.value, target) !== hash) throw new Error('计算期间输入已变化，本次结果未写入，请重新生成')
    if (JSON.stringify([activeVersion(db.value,target)?.id, activeVersion(db.value,target)?.updated]) !== baseStamp) throw new Error('计算期间目标月份已被修改，本次结果未覆盖人工修改，请重新生成')
    const success = await commit('已生成排班草稿', `${target}，尝试${result.version.run?.attempts}个候选`, draft => {
      draft.debts=draft.debts.filter(d=>!(d.id.startsWith('photon-white:') && d.due===target && !result.debts.some(next=>next.id===d.id)))
      for(const debt of result.debts){const i=draft.debts.findIndex(d=>d.id===debt.id);if(i<0)draft.debts.push(debt);else draft.debts[i]=debt}
      draft.versions.push(result.version); draft.activeVersions[target] = result.version.id
      syncVacationDebts(draft)
      result.version.inputHash = inputHash(draft, target)
    })
    if (success) { month.value = target; navigate('schedule') }
    return success
  } catch (error) { notify(error instanceof Error ? error.message : '生成失败', 'error'); return false }
  finally { generating.value = false }
}
function cellDescription(cell:Cell){
  const shift=db.value.shifts.find(s=>s.id===cell.shiftId)
  return cell.kind==='custom'?`自定义：${cell.customName}`:cell.kind==='shift'?`${db.value.rooms.find(r=>r.id===shift?.roomId)?.name}·${shift?.category}班`:({rest:'休息',vacation:'预定休假',leave:'请假',overtime:'加班',unassigned:'未分配'} as Record<string,string>)[cell.kind]
}
export async function editCells(employeeId: string, dates: string[], cell: Cell) {
  return commit('已保存人工调整', `${db.value.employees.find(e=>e.id===employeeId)?.name}；${dates.join('、')}；${cellDescription(cell)}`, draft => {
    for (const date of dates) adjustCell(draft,employeeId,date,cell)
  })
}
export async function editCalendarCells(employeeId: string, dates: string[], cell: Cell) {
  return commit('已调整工作日历中的个人安排',`${dates.length}天`,draft=>{for(const date of dates)adjustCell(draft,employeeId,date,cell,'calendar')})
}
export async function removeOvertime(employeeId: string, date: string) {return commit('已撤销加班',date,draft=>{cancelOvertime(draft,employeeId,date)})}
export async function editSelectedCells(targets: CellTarget[], action: SelectionAction) {
  const target = month.value, versionId = current.value?.id
  if (generating.value) return false
  let result: ReturnType<typeof applyScheduleSelection> | undefined
  const success = await commit(action.type === 'adjust' ? '已保存批量调整' : action.locked ? '已批量锁定班次' : '已批量解锁班次', `${target}；${targets.map(t=>`${t.employeeId}:${t.date}`).join('、')}；${action.type==='adjust'?cellDescription(action.cell):action.locked?'锁定':'解锁'}`, draft => {
    result = applyScheduleSelection(draft,target,versionId || editable(draft,target).id,targets,action)
  },true)
  if (success && result) notify(`已${action.type === 'adjust' ? '调整' : action.locked ? '锁定' : '解锁'}${result.changed}格${result.skipped ? `，跳过${result.skipped}格（含${result.protected}格休息或假期）` : ''}`)
  return success
}
export async function clearCurrentSchedule(target: string, versionId: string) {
  if (generating.value) { notify('请等待自动排班完成后再清空', 'error'); return false }
  if (target !== month.value) { notify('当前月份已变化，请重新核对后操作','error'); return false }
  return commit('已清空当月排班',`${target}；原版本保留，休息和假期不变`,draft => {clearMonthSchedule(draft,target,versionId)})
}
export async function importEmployees(rows: EmployeeImportRow[], filename: string, allowUpdates: boolean) {
  return commit('已导入员工名单',filename,draft => { applyEmployeeImport(draft,rows,allowUpdates) })
}
export async function saveEmployee(employee: Employee) {
  return commit('已保存员工资料', `${employee.code} ${employee.name}`, draft => {
    if (!employee.name.trim() || !employee.code.trim()) throw new Error('请填写姓名和唯一员工编号')
    if (draft.employees.some(e => e.code === employee.code && e.id !== employee.id)) throw new Error('员工编号已存在')
    const index = draft.employees.findIndex(e => e.id === employee.id)
    if (index >= 0) draft.employees[index] = employee; else draft.employees.push(employee)
  })
}
export async function setCalendar(date: string, open: boolean) {
  return commit('已调整工作日历', `${date} ${open ? '开班' : '休息'}`, draft => {
    draft.calendar[date] = open
    const v = editable(draft, date.slice(0, 7)); v.calendar[date] = open
    for (const shift of draft.shifts) v.requirements[`${date}|${shift.id}`] = required(draft, date, shift.id)
    for (const employee of draft.employees) {
      if (!activeOn(employee, date)) continue
      const k = key(employee.id, date), cell = v.cells[k]
      if (cell?.kind==='overtime' && (cell.overtimeBase?.source==='calendar' || cell.overtimeBase?.kind==='unassigned')) cell.overtimeBase=availableCell(draft,employee.id,date) as NonNullable<Cell['overtimeBase']>
      else if (!cell || cell.source === 'calendar' || cell.source === 'auto') {
        if (open) delete v.cells[k]; else v.cells[k] = { kind: 'rest', locked: true, source: 'calendar' }
      }
    }
  })
}
export async function confirmVersion() {
  const version = current.value; if (!version) return false
  const errors = validate(db.value, version).filter(i => i.level === 'error')
  if (errors.length) { notify(`仍有${errors.length}项硬冲突，请处理后确认`, 'error'); return false }
  if (version.inputHash !== inputHash(db.value, version.month)) { notify('输入已变化，请重新生成或在版本设置中重新校验来源', 'error'); return false }
  return commit('已确认排班版本', `${version.month} ${version.name}`, draft => { const v = draft.versions.find(v => v.id === version.id)!; v.status = 'confirmed'; v.updated = new Date().toISOString() })
}
export async function importRows(rows: ImportRow[], target: string, purpose: string, filename: string, allowNew: boolean) {
  return commit('已导入Excel', `${filename} → ${target}`, draft => {
    applyScheduleImport(draft,rows,target,purpose,filename,allowNew)
  })
}
export async function restoreDatabase(data: unknown) {
  try {
    const restored = parseDatabase(toRaw(data))
    return await commit('已恢复本地备份', '以备份内容替换当前本地数据', draft => { Object.assign(draft, restored) })
  } catch (error) { notify(error instanceof Error ? error.message : '备份格式无效', 'error'); return false }
}
export async function resetDatabase(demo: boolean) {
  return commit(demo ? '已载入演示数据' : '已建立空白数据', '替换当前数据；请事先保留备份', draft => Object.assign(draft, demo ? createDemo(month.value) : emptyDatabase()))
}
export const currentOpenDays = computed(() => daysInMonth(month.value).filter(d => openOn(db.value, d, current.value)).length)
