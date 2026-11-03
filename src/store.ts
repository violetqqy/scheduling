import { computed, ref, shallowRef, toRaw } from 'vue'
import type { Cell, Database, Employee, GenerateResult, ImportRow, EmployeeImportRow, Page } from './domain/types'
import { daysInMonth, monthNow, uid } from './domain/dates'
import { activeOn, activeVersion, emptyDatabase, inputHash, key, openOn, required, editableVersion } from './domain/model'
import { adjustCell, cancelLeave, removeVacationPlan, saveVacationPlan } from './domain/absences'
import type { VacationPlan } from './domain/types'
import { applyScheduleImport } from './domain/schedule-import'
import { applyEmployeeImport } from './domain/employee-import'
import { createDemo } from './domain/demo'
import { validate } from './domain/validation'
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
    const draft = structuredClone(toRaw(db.value)); change(draft)
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
      draft.debts.push(...result.debts.filter(d => !draft.debts.some(existing => existing.id === d.id)))
      result.version.inputHash = inputHash(draft, target)
      draft.versions.push(result.version); draft.activeVersions[target] = result.version.id
    })
    if (success) { month.value = target; navigate('schedule') }
    return success
  } catch (error) { notify(error instanceof Error ? error.message : '生成失败', 'error'); return false }
  finally { generating.value = false }
}
export async function editCells(employeeId: string, dates: string[], cell: Cell) {
  return commit('已保存人工调整', `${db.value.employees.find(e => e.id === employeeId)?.name}，${dates.length}天`, draft => {
    for (const date of dates) adjustCell(draft,employeeId,date,cell)
  })
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
export async function setCalendar(date: string, open: boolean, reason: string) {
  if (!reason.trim()) { notify('请填写调休原因', 'error'); return false }
  return commit('已调整工作日历', `${date} ${open ? '开班' : '休息'}：${reason}`, draft => {
    draft.calendar[date] = open
    const v = editable(draft, date.slice(0, 7)); v.calendar[date] = open
    for (const shift of draft.shifts) v.requirements[`${date}|${shift.id}`] = required(draft, date, shift.id)
    for (const employee of draft.employees) {
      if (!activeOn(employee, date)) continue
      const k = key(employee.id, date), cell = v.cells[k]
      if (!cell || cell.source === 'calendar' || cell.source === 'auto') {
        if (open) delete v.cells[k]; else v.cells[k] = { kind: 'rest', locked: true, source: 'calendar', note: reason }
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
