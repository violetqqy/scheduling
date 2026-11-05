<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { current, db, month, notify } from '../store'
import { daysInMonth } from '../domain/dates'
import { activeOn, completedSegments, effectiveCell, isAbsence, isOvertimeVacation, oppositeRoom, orderedEmployees, priorPhoton, sourceVersion, workSegments } from '../domain/model'
import { earlyLateStatus, goalLabel } from '../domain/monthly-goals'
import { assignmentDetails, debtFulfillment } from '../domain/statistics'
import { coverage, validate } from '../domain/validation'
import { download } from '../services/download'
import MonthBar from '../components/MonthBar.vue'
import Modal from '../components/Modal.vue'
import Icon from '../components/Icon.vue'
const tabs = ['员工', '自定义班次', '工作段', '日期班次', '房间', '班次类别', '轮转', '递延', '异常']
const tab = ref('员工'), employee = ref(''), room = ref(''), category = ref(''), from = ref(`${month.value}-01`), to = ref(daysInMonth(month.value).at(-1)!), busy = ref(false), rowLimit = ref(100)
watch(month, m => { from.value = `${m}-01`; to.value = daysInMonth(m).at(-1)!; rowLimit.value = 100 })
watch(tab, () => {rowLimit.value=100;if(tab.value==='自定义班次'){room.value='';category.value=''}})
const dates = computed(() => daysInMonth(month.value).filter(d => d >= from.value && d <= to.value))
const percent = (n: number, total: number) => total ? `${Math.round(n/total*1000)/10}%` : '—'
const cov = computed(() => current.value ? coverage(db.value,current.value).filter(r => dates.value.includes(r.date) && (!room.value || db.value.shifts.find(s => s.id === r.shiftId)?.roomId === room.value) && (!category.value || db.value.shifts.find(s => s.id === r.shiftId)?.category === category.value)) : [])
const employees = computed(() => orderedEmployees(db.value).filter(e => current.value?.employeeIds.includes(e.id) && (!employee.value || e.id === employee.value)))
interface Row { id: string; cells: (string | number)[]; employeeId?: string; date?: string; shiftId?: string; roomId?: string; category?: string; from?: string; to?: string; detail?: string }
const headers = computed(() => ({
  员工: ['编号','姓名','房间数','房间分布','出勤（含加班及自定义）','早','中','晚','白','光子','加班','自定义','休息','预定休假','事后请假','未分配','本月早段','本月晚段'],
  自定义班次:['编号','员工','自定义名称','人天'],
  工作段: ['员工','段起始','段结束','归属月','本月可工作日','本月已排','房间班次','完整性'],
  日期班次: ['日期','房间','班次','应排','实排','缺口','超额','配对人员'],
  房间: ['房间','启用班次','应排人天','实排人天','缺口','超额','人数覆盖','成组达标'],
  班次类别: ['类别','应排人天','实排人天','实际占比','缺口','超额'],
  轮转: ['编号','员工','上月红人天','上月橙人天','早班优先房间','中班优先房间','晚班优先房间','上月完整光子段','本月橙人天','本月白人天','本月早段','本月晚段'],
  递延: ['员工','待排班次','来源月','计划月','来源说明','状态','完成段'],
  异常: ['级别','规则','日期','员工','房间班次','原因'],
} as Record<string,string[]>)[tab.value]!)
const tableRows = computed<Row[]>(() => {
  const v = current.value; if (!v) return []
  if (tab.value === '员工') return employees.value.map(e => {
    const cells = dates.value.filter(d => activeOn(e,d) || !!v.cells[`${e.id}|${d}`]).map(d => effectiveCell(db.value,v,e,d))
    const working = cells.filter(c => c?.kind === 'shift' && (!room.value || db.value.shifts.find(s => s.id === c.shiftId)?.roomId === room.value) && (!category.value || db.value.shifts.find(s => s.id === c.shiftId)?.category === category.value))
    const rooms = new Map<string,number>()
    for(const cell of working){const roomId=db.value.shifts.find(s=>s.id===cell?.shiftId)?.roomId;if(roomId)rooms.set(roomId,(rooms.get(roomId)||0)+1)}
    const count = (c: string) => working.filter(x => db.value.shifts.find(s => s.id === x?.shiftId)?.category === c).length
    const goals=earlyLateStatus(db.value,v,e)
    return { id:e.id, employeeId:e.id, cells:[e.code,e.name,rooms.size,[...rooms].map(([id,n])=>`${db.value.rooms.find(r=>r.id===id)?.name || id} ${n}天`).join('、') || '—',working.length+(!room.value && !category.value ? cells.filter(c=>c?.kind==='overtime' || c?.kind==='custom').length : 0),...['早','中','晚','白','光子'].map(count),cells.filter(c=>c?.kind==='overtime').length,cells.filter(c=>c?.kind==='custom').length,cells.filter(c => c?.kind === 'rest').length,cells.filter(c => c?.kind === 'vacation').length,cells.filter(c => c?.kind === 'leave').length,cells.filter(c => !c || c.kind === 'unassigned').length,goalLabel(goals,'早'),goalLabel(goals,'晚')] }
  })
  if(tab.value==='自定义班次')return employees.value.flatMap(e=>{
    const names=new Map<string,number>()
    for(const date of dates.value){const c=v.cells[`${e.id}|${date}`];if(c?.kind==='custom')names.set(c.customName!, (names.get(c.customName!) || 0)+1)}
    return [...names].map(([name,count])=>({id:`${e.id}:${name}`,employeeId:e.id,category:`[自定义]${name}`,cells:[e.code,e.name,name,count]}))
  })
  if (tab.value === '工作段') return employees.value.flatMap(e => workSegments(db.value,v,e).filter(s => s.dates.some(d => dates.value.includes(d))).map(s => {
    const complete = completedSegments(db.value,v,e).find(c => c.id === s.id), cells = s.dates.filter(d => dates.value.includes(d)).map(d => effectiveCell(db.value,v,e,d)), shift = db.value.shifts.find(sh => sh.id === (complete?.credited?complete.shiftId:cells.find(c => c?.kind === 'shift')?.shiftId))
    return { id:s.id,employeeId:e.id,from:s.start,to:s.end,cells:[e.name,s.start,s.end,s.start.slice(0,7),cells.filter(c => !isAbsence(c) && !isOvertimeVacation(c) && !['custom','rest','overtime'].includes(c?.kind || '')).length,cells.filter(c => c?.kind === 'shift').length,shift ? `${db.value.rooms.find(r => r.id === shift.roomId)?.name} ${shift.category}` : '—',complete?.credited ? '单日调整，按原段达成' : complete ? '完整段' : s.end.slice(0,7) > month.value ? '跨月，待完成' : '未完整'] }
  }))
  if (tab.value === '日期班次') return cov.value.filter(r => r.expected || r.actual).map(r => ({ id:`${r.date}:${r.shiftId}`,date:r.date,shiftId:r.shiftId,cells:[r.date,db.value.rooms.find(x => x.id === db.value.shifts.find(s => s.id === r.shiftId)?.roomId)?.name || '',db.value.shifts.find(s => s.id === r.shiftId)?.category || '',r.expected,r.actual,r.gap,r.excess,r.employeeIds.map(id => db.value.employees.find(e => e.id === id)?.name).join('、') || '—'] }))
  if (tab.value === '房间') return db.value.rooms.filter(r => !room.value || r.id === room.value).map(r => {
    const list = cov.value.filter(x => db.value.shifts.find(s => s.id === x.shiftId)?.roomId === r.id), expected = list.reduce((n,x) => n+x.expected,0), slots = list.filter(x => x.expected).length
    return { id:r.id,roomId:r.id,cells:[r.name,slots,expected,list.reduce((n,x) => n+x.actual,0),list.reduce((n,x) => n+x.gap,0),list.reduce((n,x) => n+x.excess,0),percent(list.reduce((n,x) => n+Math.min(x.expected,x.actual),0),expected),percent(list.filter(x => x.expected && x.expected === x.actual).length,slots)] }
  })
  if (tab.value === '班次类别') return ['早','中','晚','白','光子'].filter(c => !category.value || c === category.value).map(c => {
    const list = cov.value.filter(x => db.value.shifts.find(s => s.id === x.shiftId)?.category === c), actual = list.reduce((n,x) => n+x.actual,0)
    return { id:c,category:c,cells:[`${c}班`,list.reduce((n,x) => n+x.expected,0),actual,percent(actual,cov.value.reduce((n,x) => n+x.actual,0)),list.reduce((n,x) => n+x.gap,0),list.reduce((n,x) => n+x.excess,0)] }
  })
  if (tab.value === '轮转') {
    const previous = sourceVersion(db.value,v)
    return employees.value.map(e => {
      const old = previous ? Object.entries(previous.cells).filter(([k,c]) => k.startsWith(`${e.id}|`) && c.kind === 'shift').map(([,c]) => db.value.shifts.find(s => s.id === c.shiftId)) : []
      const now = dates.value.map(d => effectiveCell(db.value,v,e,d)).filter(c => c?.kind === 'shift').map(c => db.value.shifts.find(s => s.id === c?.shiftId))
      const goals=earlyLateStatus(db.value,v,e)
      return { id:e.id,employeeId:e.id,cells:[e.code,e.name,previous ? old.filter(s => s?.roomId === 'red').length : '无历史',previous ? old.filter(s => s?.roomId === 'orange').length : '无历史',...['早','中','晚'].map(c=>{const room=oppositeRoom(db.value,previous,e.id,c);return db.value.rooms.find(r=>r.id===room)?.name || '无历史偏好'}),previous ? priorPhoton(db.value,month.value,e,v).length : '无历史',now.filter(s => s?.roomId === 'orange').length,now.filter(s => s?.category === '白').length,goalLabel(goals,'早'),goalLabel(goals,'晚')] }
    })
  }
  if (tab.value === '递延') return db.value.debts.filter(d => (!employee.value || d.employeeId === employee.value) && d.origin <= month.value && (!category.value || d.category === category.value)).map(d => { const done = debtFulfillment(db.value,d); return { id:d.id,employeeId:d.employeeId,cells:[db.value.employees.find(e => e.id === d.employeeId)?.name || '',`${d.category}班`,d.origin,d.due,d.note,done ? '已确认完成' : '待完成',done ? `${done.segment.start}—${done.segment.end}` : '—'] } })
  return validate(db.value,v).filter(i => (!employee.value || !i.employeeId || i.employeeId === employee.value) && (!i.date || dates.value.includes(i.date)) && (!room.value || !i.shiftId || db.value.shifts.find(s => s.id === i.shiftId)?.roomId === room.value)).map(i => ({ id:i.id,employeeId:i.employeeId,date:i.date,shiftId:i.shiftId,detail:i.message,cells:[i.level === 'error' ? '硬冲突' : '提醒',i.rule,i.date || '整月',db.value.employees.find(e => e.id === i.employeeId)?.name || '—',i.shiftId ? `${db.value.rooms.find(r => r.id === db.value.shifts.find(s => s.id === i.shiftId)?.roomId)?.name} ${db.value.shifts.find(s => s.id === i.shiftId)?.category}` : '—',i.message] }))
})
const totals = computed(() => headers.value.map((header,i) => i === 0 ? '合计' : header==='房间数' ? '—' : tableRows.value.some(r => typeof r.cells[i] === 'number') && tableRows.value.every(r => typeof r.cells[i] === 'number') ? tableRows.value.reduce((n,r) => n+Number(r.cells[i]),0) : '—'))
const detailOpen = ref(false), detailTitle = ref(''), detailRows = ref<ReturnType<typeof assignmentDetails>>([]), detailMessage = ref('')
function details(row: Row, column?: number) {
  if (!current.value) return
  const categoryFilter = tab.value === '员工' && column !== undefined && ['早','中','晚','白','光子'].includes(headers.value[column]!) ? headers.value[column] : row.category || category.value
  const roomId = row.roomId || room.value
  detailRows.value = assignmentDetails(db.value,current.value,row.employeeId || employee.value,categoryFilter).filter(r => dates.value.includes(r.date) && (!row.date || r.date === row.date) && (!row.from || r.date >= row.from) && (!row.to || r.date <= row.to) && (!roomId || db.value.rooms.find(x => x.id === roomId)?.name === r.room) && (!row.shiftId || db.value.shifts.find(s => s.id === row.shiftId)?.category === r.category && db.value.rooms.find(x => x.id === db.value.shifts.find(s => s.id === row.shiftId)?.roomId)?.name === r.room))
  const stateColumns: Record<string,string> = {'加班':'overtime','自定义':'custom','休息':'rest','预定休假':'vacation','事后请假':'leave','未分配':'unassigned'}
  const stateLabel=column===undefined ? undefined : headers.value[column], wanted=stateLabel && stateColumns[stateLabel]
  if (tab.value === '员工' && wanted && row.employeeId) {
    const person = db.value.employees.find(e => e.id === row.employeeId)!
    detailRows.value = dates.value.filter(d => activeOn(person,d) || !!current.value!.cells[`${person.id}|${d}`]).flatMap(date => { const cell = effectiveCell(db.value,current.value!,person,date); return (cell?.kind || 'unassigned') === wanted ? [{date,code:person.code,employee:person.name,room:'—',category:wanted==='custom'?`[自定义]${cell?.customName}`:stateLabel!,locked:cell?.locked || false}] : [] })
  }
  detailTitle.value = `${tab.value} · 排班明细`; detailMessage.value = row.detail || ''; detailOpen.value = true
}
async function exportTable() {
  if (!current.value) return
  busy.value = true
  try { const { tableWorkbook } = await import('../services/excel'); const wb = tableWorkbook(`${tab.value}统计`,headers.value,tableRows.value.map(r => r.cells),month.value,`${current.value.name} (${current.value.status}) ${from.value}—${to.value}`); download(await wb.xlsx.writeBuffer(),`班序-${month.value}-${tab.value}统计.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); notify('已导出当前筛选统计表') }
  catch { notify('导出失败，请重试','error') } finally { busy.value = false }
}
</script>
<template><section class="page-heading"><div><h1>统计分析</h1><p>从人、房间、班次和跨月轮转，核对同一份安排。</p></div><button class="button secondary" :disabled="!current || busy" @click="exportTable"><Icon name="download" :size="17" />导出当前统计</button></section><section class="panel"><MonthBar /><div class="statistics-filters"><label>日期范围<input v-model="from" type="date" :min="`${month}-01`" :max="to" /><span>至</span><input v-model="to" type="date" :min="from" :max="daysInMonth(month).at(-1)" /></label><select v-model="employee" aria-label="统计员工筛选"><option value="">全部员工</option><option v-for="e in orderedEmployees(db)" :key="e.id" :value="e.id">{{ e.name }}</option></select><select v-model="room" :disabled="tab==='自定义班次'" aria-label="统计房间筛选"><option value="">全部房间</option><option v-for="r in db.rooms" :key="r.id" :value="r.id">{{ r.name }}</option></select><select v-model="category" :disabled="tab==='自定义班次'" aria-label="统计班次筛选"><option value="">全部班次</option><option v-for="c in ['早','中','晚','白','光子']" :key="c" :value="c">{{ c }}班</option></select></div><div class="tab-list statistics-tabs"><button v-for="t in tabs" :key="t" :class="{ active: tab === t }" @click="tab = t">{{ t }}</button></div><div class="table-context"><span>{{ tab }}统计<span class="muted"> · {{ tableRows.length }}条记录</span></span><small>点击数据行查看明细</small></div><div class="table-scroll"><table class="data-table statistics-table"><thead><tr><th v-for="h in headers" :key="h">{{ h }}</th><th>明细</th></tr></thead><tbody><tr v-for="row in tableRows.slice(0,rowLimit)" :key="row.id"><td v-for="(cell,i) in row.cells" :key="i" :class="{'room-distribution-cell':tab==='员工' && headers[i]==='房间分布'}"><button v-if="typeof cell === 'number' && row.employeeId" class="table-number-link" @click="details(row,i)">{{ cell }}</button><span v-else :class="{ 'text-amber': cell === '硬冲突' || cell === '未达成' || cell === '允许顺延', 'text-green': cell === '已达成' || cell === '完整段' }">{{ cell }}</span></td><td><button class="text-button" @click="details(row)">查看</button></td></tr><tr v-if="!tableRows.length"><td :colspan="headers.length + 1" class="empty-table">{{ current ? '当前筛选没有统计记录。' : '本月没有排班版本，请先创建或导入。' }}</td></tr></tbody><tfoot v-if="tableRows.length"><tr><th v-for="(total,i) in totals" :key="i">{{ total }}</th><td></td></tr></tfoot></table></div><button v-if="tableRows.length > rowLimit" class="button secondary load-more" @click="rowLimit += 150">显示更多（共{{ tableRows.length }}条）</button><footer class="panel-footer statistics-notes"><p><Icon name="info" :size="15" />覆盖统计始终按全部人员核算；员工筛选用于员工、工作段、轮转、递延与个人异常。房间和班次筛选用于人天、覆盖和班次结构。</p><p>房间数及分布只统计当前筛选内的普通班；核对月度分散目标时请选择整月、全部房间和班次。本月早晚段始终核对整月，不受日期、人天房间和班次筛选影响。完整段按开始月归属；单日人工改动按已记录的原班段计达成，不额外计新类别；人天仍按实际班表统计。整段白班、光子或预定休假允许早晚未完成目标顺延下月。跨月未结束不提前算完成；休息、预定休假与事后请假按所选日期分别计数，加班和自定义计入总出勤并单列，覆盖人数只算八班；自定义按名称提供独立统计。原计划与加班重叠时实际状态只计加班，不计算工时。缺口与超额分别统计，零分母显示“—”。</p></footer></section><Modal :open="detailOpen" :title="detailTitle" wide @close="detailOpen = false"><p v-if="detailMessage" class="inline-alert">{{ detailMessage }}</p><p class="muted">{{ current?.name }} · {{ from }}至{{ to }} · 共{{ detailRows.length }}条记录</p><div class="table-scroll detail-scroll"><table class="data-table"><thead><tr><th>日期</th><th>编号</th><th>员工</th><th>房间</th><th>班次/状态</th><th>锁定</th></tr></thead><tbody><tr v-for="(r,i) in detailRows" :key="i"><td>{{ r.date }}</td><td>{{ r.code }}</td><td>{{ r.employee }}</td><td>{{ r.room }}</td><td>{{ r.category }}</td><td>{{ r.locked ? '是' : '否' }}</td></tr><tr v-if="!detailRows.length"><td colspan="6" class="empty-table">没有已分配班次。休假、缺口和完整段问题请按对应统计口径核对。</td></tr></tbody></table></div></Modal></template>

<style scoped>
.room-distribution-cell{min-width:280px;max-width:400px}
</style>
