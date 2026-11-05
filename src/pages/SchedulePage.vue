<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Cell, Employee } from '../domain/types'
import { clearCurrentSchedule, confirmVersion, createMonth, current as savedVersion, db, editCells, editSelectedCells, generating, month, notify, removeOvertime, saving, selectedEmployee } from '../store'
import { daysInMonth, weekday } from '../domain/dates'
import { activeOn, effectiveCell, newVersion, inputHash, key, orderedEmployees, workSegments } from '../domain/model'
import { employeeStatistics, summary } from '../domain/statistics'
import { coverage, validate } from '../domain/validation'
import { protectedScheduleCell, selectableScheduleTargets } from '../domain/schedule-edit'
import type { CellTarget } from '../domain/schedule-edit'
import { download } from '../services/download'
import Icon from '../components/Icon.vue'
import MonthBar from '../components/MonthBar.vue'
import ShiftTag from '../components/ShiftTag.vue'
import Modal from '../components/Modal.vue'
import GenerateDialog from '../components/GenerateDialog.vue'

const showGenerate = ref(false), search = ref(''), roomFilter = ref(''), view = ref<'grid' | 'calendar'>('grid'), reportOpen = ref(false), issueTab = ref<'error' | 'warning'>('error'), issueLimit = ref(30), busyExport = ref(false)
const current=computed(()=>savedVersion.value || (db.value.employees.length && daysInMonth(month.value).length?newVersion(db.value,month.value):undefined))
const planDifferences=computed(()=>current.value?Object.entries(current.value.cells).filter(([k,c])=>{
  const [id,date]=k.split('|');return current.value!.vacationPlans.some(p=>p.employeeId===id && p.dates.includes(date!))?c.kind!=='vacation':!current.value!.calendar[date!]?c.kind!=='rest':c.kind==='rest' || c.kind==='vacation'
}).length:0)
const customNames=computed(()=>[...new Set(db.value.versions.flatMap(v=>Object.values(v.cells).filter(c=>c.kind==='custom').map(c=>c.customName!)))].sort())
const days = computed(() => daysInMonth(month.value)), rows = computed(() => orderedEmployees(db.value).filter(e => (!selectedEmployee.value || e.id === selectedEmployee.value) && `${e.name}${e.code}`.includes(search.value) && (!roomFilter.value || days.value.some(d => { const cell = current.value!.cells[key(e.id, d)]; return cell?.kind === 'shift' && db.value.shifts.find(s => s.id === cell.shiftId)?.roomId === roomFilter.value }))))
const issues = computed(() => current.value ? validate(db.value, current.value) : []), errors = computed(() => issues.value.filter(i => i.level === 'error')), filteredIssues = computed(() => issues.value.filter(i => i.level === issueTab.value))
const stats = computed(() => current.value ? summary(db.value, current.value) : undefined), cov = computed(() => current.value ? coverage(db.value, current.value) : []), employeeStats = computed(() => current.value ? employeeStatistics(db.value, current.value) : [])
const goalStats = computed(() => {
  const staff=employeeStats.value.filter(row=>days.value.some(date=>activeOn(row.employee,date)))
  return {total:staff.length,early:staff.filter(r=>r.early).length,late:staff.filter(r=>r.late).length,both:staff.filter(r=>r.early && r.late).length,deferred:staff.filter(r=>r.deferred.length).length,unmet:staff.filter(r=>(!r.early || !r.late) && !r.deferred.length).length}
})
const stale = computed(() => savedVersion.value && current.value!.inputHash !== inputHash(db.value, month.value))
const bulkMode = ref(false), selection = ref(new Set<string>()), anchor = ref<CellTarget>(), bulkOpen = ref(false)
const bulkValue = ref(''), bulkLocked = ref(true), bulkName = ref('')
const clearRequest = ref<{month:string;versionId:string;name:string;count:number}>()
const working = computed(() => saving.value || generating.value)
const visibleTargets = computed(() => current.value ? selectableScheduleTargets(db.value,current.value,rows.value.flatMap(e => days.value.map(date=>({employeeId:e.id,date})))) : [])
const selectableKeys = computed(()=>new Set(visibleTargets.value.map(t=>key(t.employeeId,t.date))))
const selectedTargets = computed(() => [...selection.value].map(k=>{const [employeeId,date]=k.split('|') as [string,string];return {employeeId,date}}))
const selectedCells = computed(() => selectedTargets.value.map(target=>{
  const employee=db.value.employees.find(e=>e.id===target.employeeId)!
  const cell=current.value && employee ? effectiveCell(db.value,current.value,employee,target.date) : undefined
  return {target,cell,protected:protectedScheduleCell(db.value,target,cell)}
}))
const protectedCount = computed(() => selectedCells.value.filter(r=>r.protected).length)
const adjustableCount = computed(() => selectedCells.value.length-protectedCount.value)
const bulkAdjustCount = computed(()=>adjustableCount.value)
const lockableCount = computed(() => selectedCells.value.filter(r=>!r.protected && r.cell?.kind==='shift' && !r.cell.locked).length)
const unlockableCount = computed(() => selectedCells.value.filter(r=>!r.protected && r.cell?.kind==='shift' && r.cell.locked).length)
const allVisibleSelected = computed(() => !!visibleTargets.value.length && visibleTargets.value.every(t=>selection.value.has(key(t.employeeId,t.date))))
const assignmentCount = computed(() => Object.values(current.value?.cells || {}).filter(c=>c.kind==='shift' || c.kind==='overtime' || c.kind==='custom').length)
function clearSelection() { selection.value=new Set();anchor.value=undefined }
watch([month,()=>current.value?.id,()=>rows.value.map(e=>e.id).join('|')],()=>{clearSelection();bulkOpen.value=false;clearRequest.value=undefined;editing.value=undefined})
watch(view,v=>{if(v==='calendar'){bulkMode.value=false;clearSelection()}})
watch(selectableKeys,keys=>{
  const remaining=new Set([...selection.value].filter(k=>keys.has(k)))
  if (remaining.size!==selection.value.size) selection.value=remaining
  if (anchor.value && !keys.has(key(anchor.value.employeeId,anchor.value.date))) anchor.value=undefined
  if (!remaining.size) bulkOpen.value=false
})
function toggleBulk() {bulkMode.value=!bulkMode.value;if(bulkMode.value)view.value='grid';else clearSelection()}
function toggleTargets(targets:CellTarget[]) {
  const eligible=targets.filter(t=>selectableKeys.value.has(key(t.employeeId,t.date)))
  if (!eligible.length) return
  const next=new Set(selection.value), remove=eligible.every(t=>next.has(key(t.employeeId,t.date)))
  for(const t of eligible) {const k=key(t.employeeId,t.date);if(remove)next.delete(k);else next.add(k)}
  selection.value=next
  if (!next.size) anchor.value=undefined
}
function employeeTargets(employee:Employee) {return visibleTargets.value.filter(t=>t.employeeId===employee.id)}
function employeeSelected(employee:Employee) {const targets=employeeTargets(employee);return !!targets.length && targets.every(t=>selection.value.has(key(t.employeeId,t.date)))}
function selectEmployee(employee:Employee) {toggleTargets(employeeTargets(employee))}
function dateSelected(date:string) {const targets=visibleTargets.value.filter(t=>t.date===date);return !!targets.length && targets.every(t=>selection.value.has(key(t.employeeId,t.date)))}
function headerDate(date:string) {if(bulkMode.value)toggleTargets(visibleTargets.value.filter(t=>t.date===date));else dayDetail.value=date}
function clickCell(employee:Employee,date:string,event:MouseEvent) {
  if(!bulkMode.value){openCell(employee,date);return}
  const target={employeeId:employee.id,date}
  if (!selectableKeys.value.has(key(employee.id,date))) return
  if(event.shiftKey && anchor.value) {
    const a=rows.value.findIndex(e=>e.id===anchor.value!.employeeId),b=rows.value.findIndex(e=>e.id===employee.id)
    const from=days.value.indexOf(anchor.value.date),to=days.value.indexOf(date)
    const next=new Set(selection.value)
    for(const e of rows.value.slice(Math.min(a,b),Math.max(a,b)+1)) for(const d of days.value.slice(Math.min(from,to),Math.max(from,to)+1)) if(selectableKeys.value.has(key(e.id,d)))next.add(key(e.id,d))
    selection.value=next
  } else {toggleTargets([target]);anchor.value=target}
}
function openBulkAdjust() {bulkValue.value=db.value.shifts.find(s=>s.enabled)?.id || 'unassigned';bulkLocked.value=true;bulkName.value='';bulkOpen.value=true}
async function saveBulkAdjust() {
  const kind=['rest','vacation','leave','unassigned','overtime','custom'].includes(bulkValue.value) ? bulkValue.value as Cell['kind'] : 'shift'
  if(await editSelectedCells(selectedTargets.value,{type:'adjust',cell:{kind,shiftId:kind==='shift'?bulkValue.value:undefined,locked:bulkLocked.value,source:'manual',customName:kind==='custom'?bulkName.value:undefined}})) bulkOpen.value=false
}
function requestClear() {if(current.value)clearRequest.value={month:month.value,versionId:current.value.id,name:current.value.name,count:assignmentCount.value}}
async function clearSchedule() {const request=clearRequest.value;if(request && await clearCurrentSchedule(request.month,request.versionId))clearRequest.value=undefined}
const editing = ref<{ employee: Employee; date: string }>(), value = ref(''), locked = ref(true), customName = ref(''), scope = ref('day')
function openCell(employee: Employee, date: string) {
  if (!current.value) return
  const cell = effectiveCell(db.value, current.value, employee, date)
  value.value = cell?.kind === 'shift' ? cell.shiftId! : cell?.kind || 'unassigned'; locked.value = true; customName.value=cell?.customName || ''; scope.value = 'day'; editing.value = { employee, date }
}
const editDates = computed(() => !editing.value || !current.value ? [] : scope.value === 'day' || value.value==='overtime' ? [editing.value.date] : workSegments(db.value, current.value, editing.value.employee).find(s => s.dates.includes(editing.value!.date))?.dates || [editing.value.date])
const editingCell = computed(()=>editing.value && current.value ? effectiveCell(db.value,current.value,editing.value.employee,editing.value.date) : undefined)
async function undoOvertime() {if(editing.value && await removeOvertime(editing.value.employee.id,editing.value.date))editing.value=undefined}
async function saveCell() {
  if (!editing.value) return
  const kind = ['rest','vacation','leave','unassigned','overtime','custom'].includes(value.value) ? value.value as Cell['kind'] : 'shift'
  const cell: Cell = {kind,shiftId:kind==='shift'?value.value:undefined,customName:kind==='custom'?customName.value:undefined,locked:kind==='shift'?locked.value:kind!=='unassigned',source:'manual'}
  if (await editCells(editing.value.employee.id, editDates.value, cell)) editing.value = undefined
}
const dayDetail = ref(''), dayRows = computed(() => cov.value.filter(r => r.date === dayDetail.value))
const monthOffset = computed(() => (new Date(`${month.value}-01T12:00:00`).getDay() + 6) % 7)
async function exportExcel() {
  if (!current.value) return
  busyExport.value = true
  try { const { exportWorkbook } = await import('../services/excel'); const buffer = await exportWorkbook(db.value, current.value).xlsx.writeBuffer(); download(buffer, `班序-${month.value}-排班.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); notify('已导出排班、配对、员工统计与明细') }
  catch { notify('导出失败，请重试', 'error') } finally { busyExport.value = false }
}
</script>
<template><section class="page-heading"><div><h1>月度排班</h1><p>从整月看安排，在每一格里保留调整的余地。</p><span v-if="current?.historyMode === 'initial'" class="pill">首次排班 · 无上月参考</span></div><div class="actions"><button class="button danger-outline" :disabled="!current || !assignmentCount || working" @click="requestClear">清空当月排班</button><button class="button secondary" :disabled="!current || busyExport" @click="exportExcel"><Icon name="download" :size="17" />{{ busyExport ? '正在导出…' : '导出Excel' }}</button><button class="button primary" @click="showGenerate = true"><Icon name="sparkle" :size="17" />自动排班</button></div></section>
  <section class="panel schedule-panel"><MonthBar><div class="month-bar-end"><span v-if="current" class="pill" :class="{ success: current.status === 'confirmed' }">{{ current.status === 'confirmed' ? '已确认' : current.status === 'imported' ? '历史导入' : '编辑草稿' }}</span><div class="segmented"><button :class="{ active: view === 'grid' }" @click="view = 'grid'">员工总览</button><button :class="{ active: view === 'calendar' }" @click="view = 'calendar'">自然月</button></div></div></MonthBar>
  <div v-if="!savedVersion && current" class="inline-alert"><Icon name="info" :size="17" />本月尚无已保存班表，可直接编辑任意格，首次保存将建立草稿。</div>
  <div v-if="stale" class="inline-alert"><Icon name="info" :size="17" />资料、规则或上月记录已变化。旧版本仍可查看；请重新生成，或在规则与设置中重新校验输入。</div>
  <div v-if="planDifferences" class="inline-alert"><Icon name="info" :size="17" />计划与实际有{{ planDifferences }}格差异。月度表人工修改不会改变工作日历；自定义和加班可保留，普通班冲突请查看报告。</div>
  <template v-if="current"><div class="schedule-toolbar"><div class="search-field"><Icon name="search" :size="17" /><input v-model="search" placeholder="搜索员工姓名或编号" aria-label="搜索员工" /></div><select v-model="roomFilter" aria-label="按房间筛选"><option value="">全部房间</option><option v-for="r in db.rooms" :key="r.id" :value="r.id">{{ r.name }}</option></select><button class="button secondary small-button" :class="{ 'selection-active': bulkMode }" :aria-pressed="bulkMode" :disabled="working" @click="toggleBulk"><Icon name="edit" :size="15" />{{ bulkMode ? '退出多选' : '多选调整 / 锁定' }}</button><button v-if="selectedEmployee" class="pill text-button" @click="selectedEmployee = ''">清除员工筛选 ×</button><div class="legend toolbar-legend"><span v-for="r in db.rooms" :key="r.id"><i :style="{ background: r.color, border: '1px solid #0000000a' }"></i>{{ r.id === 'blue' ? '白班' : r.id === 'photon' ? '光子' : r.name }}</span><span><i class="rest-legend"></i>休</span><span><i class="vacation-legend"></i>预定休假</span><span><i class="leave-legend"></i>事后请假</span><span><i class="overtime-legend"></i>加班</span></div></div>
  <div v-if="bulkMode" class="selection-toolbar" aria-label="批量排班操作">
    <div class="selection-summary" aria-live="polite"><strong>已选 {{ selection.size }} 格</strong><span>可调整 {{ adjustableCount }} 格，所有日期和状态均可选择</span></div>
    <div class="actions"><button class="button secondary small-button" :disabled="!visibleTargets.length" @click="toggleTargets(visibleTargets)">{{ allVisibleSelected ? '取消全选' : '全选当前员工' }}</button><button class="text-button" :disabled="!selection.size" @click="clearSelection">清除选择</button><button class="button secondary small-button" :disabled="!lockableCount || working" @click="editSelectedCells(selectedTargets,{type:'lock',locked:true})"><Icon name="lock" :size="14" />锁定所选（{{ lockableCount }}）</button><button class="button secondary small-button" :disabled="!unlockableCount || working" @click="editSelectedCells(selectedTargets,{type:'lock',locked:false})">解锁所选（{{ unlockableCount }}）</button><button class="button primary small-button" :disabled="!adjustableCount || working" @click="openBulkAdjust">批量调整</button></div>
    <p>点击格子多选，Shift + 点击连选矩形；勾选员工可选整行，点击日期可选整列。所有日期和状态均可选择，不修改工作日历。筛选、切换月份或版本后清除选择。</p>
  </div>
  <div v-if="view === 'grid'" class="table-scroll schedule-scroll" :class="{ 'selecting-cells': bulkMode }"><table class="schedule-table"><thead><tr><th class="sticky-name"><input v-if="bulkMode" type="checkbox" :checked="allVisibleSelected" :indeterminate="!!selection.size && !allVisibleSelected" :disabled="!visibleTargets.length" aria-label="全选当前员工排班" @change="toggleTargets(visibleTargets)" />员工 <small>{{ rows.length }}人</small></th><th v-for="date in days" :key="date" :class="{ 'closed-day': !current.calendar[date] }"><button :disabled="bulkMode && !visibleTargets.some(t=>t.date===date)" :class="{ 'selected-date': bulkMode && dateSelected(date) }" :aria-label="bulkMode ? `选择${date}整列排班` : `查看${date}配对`" @click="headerDate(date)"><span>{{ Number(date.slice(8)) }}</span><small>周{{ weekday(date) }}</small></button></th><th class="summary-col">出勤</th></tr></thead><tbody><tr v-for="(employee, index) in rows" :key="employee.id"><th class="sticky-name"><input v-if="bulkMode" type="checkbox" :checked="employeeSelected(employee)" :disabled="!employeeTargets(employee).length" :aria-label="`选择${employee.name}整行排班`" @change="selectEmployee(employee)" /><small v-else class="row-index">{{ String(index + 1).padStart(2, '0') }}</small><span>{{ employee.name }}<small class="employee-code">{{ employee.code }}</small></span></th><td v-for="date in days" :key="date" :class="{ 'closed-cell': !current.calendar[date] }"><button class="cell-button" :class="{ 'cell-selected': bulkMode && selection.has(key(employee.id,date)) }" :disabled="working || bulkMode && !selectableKeys.has(key(employee.id,date))" :title="!activeOn(employee,date)?'任职期外仍可人工编辑；自动排班不使用该员工':undefined" :aria-pressed="bulkMode ? selection.has(key(employee.id,date)) : undefined" :aria-label="`${employee.name} ${date}，${bulkMode ? '选择排班' : '点击修改班次或休假'}`" @click="clickCell(employee, date, $event)"><ShiftTag :cell="effectiveCell(db, current, employee, date)" /></button></td><td class="summary-col">{{ employeeStats.find(r => r.employee.id === employee.id)?.work || 0 }}</td></tr><tr v-if="!rows.length"><td :colspan="days.length + 2" class="empty-table">没有符合筛选的员工。</td></tr></tbody><tfoot><tr><th class="sticky-name">每日人数</th><td v-for="date in days" :key="date"><button class="daily-count" :class="{ deficient: cov.filter(r => r.date === date).some(r => r.actual !== r.expected) }" :aria-label="`${date}查看配对`" @click="dayDetail = date">{{ cov.filter(r => r.date === date).reduce((n, r) => n + r.actual, 0) }}<small>/{{ cov.filter(r => r.date === date).reduce((n, r) => n + r.expected, 0) }}</small></button></td><td class="summary-col">{{ stats?.actual }}</td></tr></tfoot></table></div>
  <div v-else class="calendar-grid schedule-calendar"><div v-for="w in ['一','二','三','四','五','六','日']" :key="w" class="calendar-weekday">周{{ w }}</div><div v-for="n in monthOffset" :key="`blank-${n}`" class="calendar-blank"></div><button v-for="date in days" :key="date" class="calendar-day" :class="{ off: !current.calendar[date], 'has-gap': cov.filter(r => r.date === date).some(r => r.actual !== r.expected) }" @click="dayDetail = date"><strong>{{ Number(date.slice(8)) }}</strong><span>{{ current.calendar[date] ? '开班日' : '休息日' }}</span><small v-if="current.calendar[date]">已排 {{ cov.filter(r => r.date === date).reduce((n,r) => n+r.actual,0) }} / {{ cov.filter(r => r.date === date).reduce((n,r) => n+r.expected,0) }} 人</small></button></div>
  <footer class="schedule-footer"><div><span><Icon name="edit" :size="14" />点击班次可修改</span><span><Icon name="lock" :size="13" />人工锁定不被覆盖</span></div><strong>常规班次{{ stats?.actual || 0 }}人天<span v-if="stats?.overtime">，加班{{ stats.overtime }}人天</span><span v-if="stats?.custom">，自定义{{ stats.custom }}人天</span><span v-if="stats?.gap" class="text-amber">，缺{{ stats.gap }}人天</span></strong></footer></template><div v-else class="empty-state"><Icon name="calendar" :size="42" /><h3>为这个月建立第一份安排</h3><p>请先确定员工名单和当月休假计划；没有上月记录也可直接生成。</p><div class="actions"><button class="button secondary" @click="createMonth">建立空白草稿</button><button class="button primary" @click="showGenerate = true">自动生成</button></div></div></section>
  <div v-if="current" class="schedule-bottom"><div><span :class="errors.length ? 'issue-indicator' : 'valid-indicator'"><Icon :name="errors.length ? 'warning' : 'check'" :size="18" />{{ errors.length ? `${errors.length}项硬冲突待处理` : '当前校验：无硬冲突' }}</span><span class="goal-status" :class="{'text-amber':goalStats.unmet>0}">完整早晚段 {{ goalStats.both }}/{{ goalStats.total }}人达成 · {{ goalStats.deferred }}人允许顺延</span><button class="text-button" @click="reportOpen = true">查看报告与优先目标<Icon name="right" :size="15" /></button></div><button class="button primary" :disabled="!savedVersion || !!errors.length || current.status === 'confirmed' || !!stale" @click="confirmVersion">{{ current.status === 'confirmed' ? '此版本已确认' : '校验并确认版本' }}</button></div>
  <Modal :open="!!editing" :title="editing ? `${editing.employee.name} · ${editing.date}` : '修改班次'" drawer @close="editing=undefined"><template v-if="editing"><p class="muted">可修改任意日期和状态，仅改变实际班表，不修改工作日历或休假计划。人工班次默认锁定；允许段内混班，逐日每班仍须2人。仅一天手工调整，按原班段计达成；多日混班仍按完整段规则核对。</p><label class="field">班次或状态<select v-model="value"><optgroup label="状态"><option value="rest">休息</option><option value="vacation">预定休假（仅班表）</option><option value="leave">请假</option><option value="unassigned">未分配 / 恢复可用</option><option value="overtime">加班</option><option value="custom">自定义班次</option></optgroup><optgroup label="房间与班次"><option v-for="s in db.shifts" :key="s.id" :value="s.id">{{ db.rooms.find(r=>r.id===s.roomId)?.name }} · {{ s.category }}班{{ !s.enabled?'（全局停用）':'' }}</option></optgroup></select></label><label v-if="value==='custom'" class="field">自定义班次名称<input v-model="customName" list="custom-shift-names" maxlength="30" placeholder="例如：培训、外出" /></label><label class="field">修改范围<select v-model="scope" :disabled="value==='overtime'"><option value="day">仅本日</option><option value="segment">整个工作段（可跨月）</option></select></label><div v-if="scope==='segment'" class="callout amber"><Icon name="info" :size="18" /><p>将修改{{ editDates.length }}天：{{ editDates[0] }}至{{ editDates.at(-1) }}。工作段按工作日历确定，涉及已确认月份时建立修订草稿。</p></div><label v-if="!['rest','vacation','leave','unassigned','overtime','custom'].includes(value)" class="checkbox-line"><input v-model="locked" type="checkbox" />锁定此人工班次</label><p class="fineprint">自定义和加班始终由自动排班保留，不占八班配对名额。解锁普通班后，重排会按工作日历和预定休假恢复安排。手工修改不会自动修改搭档。</p></template><template #footer><button class="button secondary" @click="editing=undefined">取消</button><button v-if="editingCell?.kind==='overtime'" class="button danger-outline" :disabled="working" @click="undoOvertime">撤销加班并恢复原状态</button><button class="button primary" :disabled="working || value==='custom' && !customName.trim()" @click="saveCell">保存调整</button></template></Modal>
  <Modal :open="!!dayDetail" :title="`${dayDetail} · 八班配对`" drawer @close="dayDetail = ''"><div v-for="row in dayRows" :key="row.shiftId" class="pair-row"><ShiftTag :cell="{ kind: 'shift', shiftId: row.shiftId, source: 'auto', locked: false }" full /><span class="pill" :class="row.actual === row.expected ? 'success' : 'danger'">{{ row.actual }}/{{ row.expected }}人</span><p>{{ row.employeeIds.map(id => db.employees.find(e => e.id === id)?.name).join('、') || (row.expected ? '尚未安排' : '本班关闭') }}</p></div></Modal>
  <Modal :open="reportOpen" title="生成报告与规则检查" wide @close="reportOpen = false"><div class="callout" :class="goalStats.unmet>0?'amber':'green'"><div><strong>完整工作段目标：{{ goalStats.both }}/{{ goalStats.total }}人同时达成早段、晚段</strong><p>完整早段 {{ goalStats.early }}人 · 完整晚段 {{ goalStats.late }}人 · {{ goalStats.deferred }}人允许顺延 · {{ goalStats.unmet }}人仍未达标。按工作日历的连续开班段核对，可能为4、5或6天。跨月待续段尚未计入完成。</p><p>先分析上月生成任务，在硬约束内先补历史欠下的早晚段，再满足本月目标和其他递延。整段白班、光子或预定休假允许早晚顺延，不冒充已经达成。单日人工改动按原班段达成。</p></div></div><div v-if="current?.run" class="callout green"><Icon name="info" :size="19" /><div><strong>尝试{{ current.run.attempts }}个候选 · {{ current.run.duration }}毫秒</strong><p v-if="current.run.preparation">排班前分析：跨月续段 {{ current.run.preparation.carrySegments }}个 · 待补任务 {{ current.run.preparation.pendingDebts.length }}项（早晚 {{ current.run.preparation.pendingDebts.filter(d=>['早','晚'].includes(d.category)).length }}项）</p><p v-if="current.run.preparation">分析来源：{{ db.versions.find(v=>v.id===current?.run?.preparation?.sourceVersionId)?.name || '无紧邻上月参考' }}</p><details v-if="current.run.preparation?.pendingDebts.length"><summary>查看排班前待补清单（{{ current.run.preparation.pendingDebts.length }}项）</summary><p v-for="debt in current.run.preparation.pendingDebts" :key="debt.id">{{ db.employees.find(e=>e.id===debt.employeeId)?.name }} · {{ debt.category }}班 · 来源{{ debt.origin }}：{{ debt.note }}</p></details><p>生成时补班起点：{{ db.employees.find(e => e.id === current?.run?.fallbackId)?.name || '未发现早晚段目标缺失' }}</p><p>{{ current.run.note }}</p></div></div><div class="tab-list"><button :class="{ active: issueTab === 'error' }" @click="issueTab = 'error'">硬冲突 {{ errors.length }}</button><button :class="{ active: issueTab === 'warning' }" @click="issueTab = 'warning'">优先目标与提醒 {{ issues.length - errors.length }}</button></div><div v-if="!filteredIssues.length" class="empty-state compact"><Icon name="check" :size="32" /><p>该类别没有待处理问题。</p></div><div v-for="issue in filteredIssues.slice(0, issueLimit)" :key="issue.id" class="issue-row"><Icon :name="issue.level === 'error' ? 'warning' : 'info'" :size="17" /><div><strong>{{ issue.rule }} <span>{{ issue.date }} {{ db.employees.find(e => e.id === issue.employeeId)?.name }} {{ db.shifts.find(s => s.id === issue.shiftId)?.category }}</span></strong><p>{{ issue.message }}</p></div><button v-if="issue.date" class="text-button" @click="dayDetail = issue.date; reportOpen = false">查看当日</button></div><button v-if="filteredIssues.length > issueLimit" class="button secondary full-width" @click="issueLimit += 50">继续显示</button></Modal>
  <Modal :open="bulkOpen" title="批量调整所选排班" @close="bulkOpen=false"><p>已选{{ selection.size }}格，将统一调整所有选中日期，不修改工作日历和休假计划。</p><label class="field">统一设置为<select v-model="bulkValue"><optgroup label="房间与班次"><option v-for="s in db.shifts" :key="s.id" :value="s.id">{{ db.rooms.find(r=>r.id===s.roomId)?.name }} · {{ s.category }}班{{ !s.enabled?'（全局停用）':'' }}</option></optgroup><optgroup label="状态"><option value="unassigned">未分配 / 清除所选班次</option><option value="rest">休息</option><option value="vacation">预定休假（仅班表）</option><option value="leave">请假</option><option value="overtime">加班</option><option value="custom">自定义班次</option></optgroup></select></label><label v-if="bulkValue==='custom'" class="field">批量自定义班次名称<input v-model="bulkName" list="custom-shift-names" maxlength="30" placeholder="例如：培训、外出" /></label><label v-if="!['rest','vacation','leave','unassigned','overtime','custom'].includes(bulkValue)" class="checkbox-line"><input v-model="bulkLocked" type="checkbox" />锁定调整后的班次</label><p class="fineprint">休息、预定休假、请假、加班和自定义均可改。自定义始终跳过自动排班；普通班默认锁定。仅修改所选当月格，不自动调整搭档。保存允许存在冲突，确认版本前需解决硬冲突。</p><template #footer><button class="button secondary" :disabled="working" @click="bulkOpen=false">取消</button><button class="button primary" :disabled="!bulkAdjustCount || working || bulkValue==='custom' && !bulkName.trim()" @click="saveBulkAdjust">保存批量调整</button></template></Modal>
  <Modal :open="!!clearRequest" title="清空当月排班" @close="clearRequest = undefined"><template v-if="clearRequest"><p>将清空 <strong>{{ clearRequest.month }}</strong> 当前版本“{{ clearRequest.name }}”中的 <strong>{{ clearRequest.count }} 格班次</strong>，包含已锁定、导入的班次、自定义和加班。</p><p class="fineprint">操作覆盖当月全部员工，不受当前筛选影响。工作日历、个人休息、预定休假和事后请假会保留，加班恢复原状态，其他月份不变。</p><p class="fineprint">清空后建立新草稿，原版本保留。需要找回时，在月份旁的版本下拉框中选择原版本。随后可手工安排或重新自动排班。</p></template><template #footer><button class="button secondary" :disabled="working" @click="clearRequest=undefined">取消</button><button class="button danger" :disabled="!clearRequest || working" @click="clearSchedule">确认清空当月班次</button></template></Modal>
  <datalist id="custom-shift-names"><option v-for="name in customNames" :key="name" :value="name" /></datalist>
  <GenerateDialog :open="showGenerate" @close="showGenerate = false" />
</template>

<style scoped>
.goal-status{font-size:12px;white-space:nowrap}
</style>
