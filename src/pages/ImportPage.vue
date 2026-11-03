<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import type ExcelJS from 'exceljs'
import type { ImportOptions } from '../services/excel'
import type { ImportRow } from '../domain/types'
import { current, db, importRows, month, navigate, notify, settingsSection, importPurpose, setupImport } from '../store'
import { addMonths } from '../domain/dates'
import { activeVersion } from '../domain/model'
import { download } from '../services/download'
import Icon from '../components/Icon.vue'
import Modal from '../components/Modal.vue'
import EmployeeImportPanel from '../components/EmployeeImportPanel.vue'

const workbook = shallowRef<ExcelJS.Workbook>(), excel = shallowRef<typeof import('../services/excel')>(), filename = ref(''), reading = ref(false), busy = ref(false), sheetName = ref(''), allowNew = ref(false), onlyErrors = ref(false), pageIndex = ref(0), confirmOpen = ref(false), error = ref('')
const purpose = importPurpose
const skipped = ref(new Set<string>())
const options = reactive<ImportOptions>({ month: purpose.value === 'history' ? addMonths(month.value,-1) : month.value, headerRow: 1, startRow: 2, nameColumn: 2, codeColumn: 1, dateStartColumn: 3, colorMap: {},format:'matrix',dateColumn:1,roomColumn:4,shiftColumn:5,statusColumn:0,lockColumn:6 })
const sheet = computed(() => workbook.value?.getWorksheet(sheetName.value)), colors = computed(() => sheet.value && excel.value ? excel.value.discoverColors(sheet.value,options) : [])
function updateColors() {
  for (const entry of colors.value) if (!(entry.color in options.colorMap)) {
    const known = db.value.rooms.find(r => r.color.toUpperCase() === entry.color)
    options.colorMap[entry.color] = known?.id || (entry.color === '#FFF0A8' ? 'vacation' : entry.color === '#EDE4FF' ? 'leave' : entry.suggested)
  }
}
function sheetChanged() {
  const s = sheet.value; if (!s) return
  const headers = Array.from({length:Math.min(s.columnCount,40)},(_,i) => s.getCell(options.headerRow,i+1).text.trim())
  const at = (pattern: RegExp) => headers.findIndex(h => pattern.test(h)) + 1
  if (at(/^日期$/) && at(/^班次$/)) {
    options.format = 'detail'; options.dateColumn = at(/^日期$/); options.shiftColumn = at(/^班次$/); options.roomColumn = at(/^房间$/); options.nameColumn = at(/^(姓名|员工姓名)$/) || 3; options.codeColumn = at(/^(员工编号|编号)$/); options.statusColumn = at(/^状态$/); options.lockColumn = at(/^锁定$/); options.noteColumn = at(/^(说明|备注)$/)
  } else { options.format = 'matrix'; options.nameColumn = at(/^(姓名|员工姓名|员工)$/) || 1; options.codeColumn = at(/^(员工编号|编号)$/); options.dateStartColumn = Math.max(options.nameColumn,options.codeColumn)+1 }
  updateColors(); pageIndex.value = 0
}
const parsed = computed<ImportRow[]>(() => {
  if (!sheet.value || !excel.value) return []
  try { const rows = excel.value.previewSheet(sheet.value,db.value,options); return rows.map(r => ({ ...r, skip: r.skip || skipped.value.has(`${r.row}|${r.date}`) })) }
  catch { return [] }
})
const errors = computed(() => parsed.value.filter(r => r.error && !r.skip))
const newEmployees = computed(() => [...new Map(parsed.value.filter(r => !r.employeeId && !r.skip).map(r => [r.code || r.name, r])).values()])
const visibleRows = computed(() => (onlyErrors.value ? parsed.value.filter(r => r.error) : parsed.value).slice(pageIndex.value*40,(pageIndex.value+1)*40))
const totalVisible = computed(() => (onlyErrors.value ? parsed.value.filter(r => r.error) : parsed.value).length)
async function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return
  error.value = ''; workbook.value = undefined; reading.value = true
  try {
    if (!file.name.toLowerCase().endsWith('.xlsx')) throw new Error('请选择.xlsx文件；旧.xls请先在Excel中另存为.xlsx')
    if (file.size > 10*1024*1024) throw new Error('文件超过10MB，请仅保留需要导入的工作表后重试')
    excel.value = await import('../services/excel'); workbook.value = await excel.value.readWorkbook(await file.arrayBuffer()); filename.value = file.name
    sheetName.value = (purpose.value === 'employees' ? workbook.value.getWorksheet('员工名单') || workbook.value.getWorksheet('员工资料') : workbook.value.getWorksheet('月度排班') || workbook.value.getWorksheet('已有排班'))?.name || workbook.value.worksheets[0]?.name || ''
    const first = sheet.value?.getCell(1,1).text || ''
    options.headerRow = 1; options.startRow = 2; options.nameColumn = /编号/.test(first) ? 2 : 1; options.codeColumn = /编号/.test(first) ? 1 : 0; options.dateStartColumn = /编号/.test(first) ? 3 : 2
    const metadata = workbook.value.getWorksheet('说明与图例')?.getCell(2,2).text || workbook.value.getWorksheet('排班填写说明')?.getCell(2,2).text
    if (metadata && /^\d{4}-\d{2}$/.test(metadata)) options.month = metadata
    options.colorMap = {}; skipped.value = new Set(); pageIndex.value = 0; sheetChanged()
  } catch (e) { error.value = e instanceof Error ? e.message : '文件读取失败，请确认文件未损坏或加密' }
  finally { reading.value = false }
}
function skip(row: ImportRow) { const next = new Set(skipped.value), key = `${row.row}|${row.date}`; next.has(key) ? next.delete(key) : next.add(key); skipped.value = next }
watch(purpose,() => { changePurpose(); allowNew.value=false; confirmOpen.value=false })
function changePurpose() {
  options.month = purpose.value === 'history' ? addMonths(month.value,-1) : month.value
  if (workbook.value && purpose.value !== 'employees') {sheetName.value=(workbook.value.getWorksheet('月度排班') || workbook.value.getWorksheet('已有排班') || workbook.value.worksheets[0])?.name || ''; sheetChanged()}
}
async function confirm() {
  if (!parsed.value.length) return
  if (await importRows(parsed.value,options.month,purpose.value,filename.value,allowNew.value)) { confirmOpen.value = false; if (setupImport.value) { setupImport.value=false; navigate('overview') } else {month.value = options.month; navigate(['vacation','leave','availability'].includes(purpose.value) ? 'calendar' : 'schedule')} }
}
async function exportFile(template: boolean | 'employees' | 'initialization' = false) {
  busy.value = true
  try {
    const lib = await import('../services/excel'); const wb = template === 'employees' ? lib.employeeTemplateWorkbook() : template === 'initialization' ? lib.initializationWorkbook(options.month) : template ? lib.templateWorkbook(db.value,month.value) : current.value ? lib.exportWorkbook(db.value,current.value) : undefined
    if (!wb) throw new Error('当前月份没有排班版本')
    download(await wb.xlsx.writeBuffer(),`班序-${month.value}-${template === 'employees' ? '员工名单模板' : template === 'initialization' ? '初始化导入模板' : template ? '导入模板' : '排班及统计'}.xlsx`,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); notify('已生成Excel文件')
  } catch (e) { notify(e instanceof Error ? e.message : '导出失败','error') } finally { busy.value = false }
}
</script>
<template><section class="page-heading"><div><h1>导入与导出</h1><p>从熟悉的Excel开始，确认每一种颜色，再写入本地工作区。</p></div><div class="actions import-template-actions"><button class="button secondary" :disabled="busy" @click="exportFile('employees')">员工名单模板</button><button class="button secondary" :disabled="busy" @click="exportFile('initialization')">初始化导入模板</button><button class="button secondary" :disabled="busy" @click="exportFile(true)"><Icon name="download" :size="17" />排班填写模板</button></div></section><div v-if="!db.employees.length" class="callout green"><Icon name="info" :size="19" /><div><strong>第一次使用，有两种准备方式</strong><p>只有员工名单：先导入员工，再配置休假并直接生成。已有班表：选择历史排班用途，导入时可一并确认创建员工；没有上月班表可跳过。</p><button class="text-button" @click="navigate('overview')">查看初始化步骤</button></div></div><div v-if="db.demo" class="callout amber"><Icon name="info" :size="19" /><div><strong>准备导入真实数据？</strong><p>当前含演示员工。建议先在规则与设置中备份，再切换为空白工作区，避免与真实名单混合。</p><button class="text-button" @click="settingsSection = '数据与备份'; navigate('settings')">前往数据设置<Icon name="right" :size="14" /></button></div></div><section class="panel import-panel"><header class="panel-header"><div><h2>{{ purpose === 'employees' ? '导入员工名单' : '导入已有排班与个人安排' }}</h2><p>选择文件、映射字段、预览结果，最后确认写入。</p></div><span class="pill">文件仅在本地处理</span></header><div class="import-body"><label class="file-drop"><span class="soft-icon large"><Icon name="upload" :size="25" /></span><strong>{{ reading ? '正在读取工作簿…' : filename || '选择Excel文件' }}</strong><span>支持.xlsx，最大10MB。保留单元格底色和班次文字。</span><input type="file" accept=".xlsx" aria-label="选择Excel排班文件" :disabled="reading" @change="chooseFile" /><span class="button secondary small-button">{{ filename ? '重新选择文件' : '浏览本地文件' }}</span></label><p v-if="error" class="error-text" role="alert">{{ error }}</p><div class="form-grid import-basics"><label class="field">导入用途<select v-model="purpose" @change="changePurpose"><option value="employees">首次准备：员工名单</option><option value="history">上月历史排班（可同时创建员工）</option><option value="vacation">排班前：员工休假计划</option><option value="leave">排班后：事后请假</option><option value="availability">仅导入个人休息</option><option value="schedule">目标月人工排班</option></select></label><label v-if="purpose !== 'employees'" class="field">数据所属月份<input v-model="options.month" type="month" /></label></div><template v-if="workbook"><EmployeeImportPanel v-if="purpose === 'employees' && excel" :key="filename" :workbook="workbook" :filename="filename" :excel="excel" /><template v-else><div class="mapping-title"><h3>字段映射</h3><button class="text-button" @click="updateColors(); pageIndex = 0">重新识别颜色</button></div><div class="mapping-grid"><label class="field">表格形式<select v-model="options.format"><option value="matrix">员工 × 日期矩阵</option><option value="detail">结构化排班明细</option></select></label><label class="field">工作表<select v-model="sheetName" @change="sheetChanged"><option v-for="s in workbook.worksheets" :key="s.name" :value="s.name">{{ s.name }}</option></select></label><label class="field">日期表头行<input v-model.number="options.headerRow" type="number" min="1" max="1000" /></label><label class="field">数据起始行<input v-model.number="options.startRow" type="number" min="2" max="1000" /></label><label class="field">员工姓名列<input v-model.number="options.nameColumn" type="number" min="1" max="50" /></label><label class="field">员工编号列（0为无）<input v-model.number="options.codeColumn" type="number" min="0" max="50" /></label><label v-if="options.format === 'matrix'" class="field">日期起始列<input v-model.number="options.dateStartColumn" type="number" min="1" max="50" /></label><template v-else><label class="field">完整日期列<input v-model.number="options.dateColumn" type="number" min="1" max="50" /></label><label class="field">房间列（0为无）<input v-model.number="options.roomColumn" type="number" min="0" max="50" /></label><label class="field">班次列<input v-model.number="options.shiftColumn" type="number" min="1" max="50" /></label><label class="field">状态列（0为无）<input v-model.number="options.statusColumn" type="number" min="0" max="50" /></label><label class="field">说明列（0为无）<input v-model.number="options.noteColumn" type="number" min="0" max="50" /></label><label class="field">锁定列（0为无）<input v-model.number="options.lockColumn" type="number" min="0" max="50" /></label></template></div><p class="fineprint">列按1=A、2=B、3=C填写。尾部U忽略；定位、加班保留附注，不进入排班统计。</p><h3 class="mapping-title">颜色含义确认</h3><div v-if="!colors.length && options.format === 'matrix'" class="inline-alert">没有读取到填充底色。早中晚需在文字中明确红/橙房间，或修正原表颜色。</div><div class="color-mapping-grid"><label v-for="entry in colors" :key="entry.color" class="color-mapping"><span class="color-swatch" :style="{ background: entry.color.startsWith('#') ? entry.color : '#eee' }"></span><span><strong>{{ entry.color }}</strong><small>{{ entry.count }}格</small></span><select v-model="options.colorMap[entry.color]" :aria-label="`${entry.color}颜色映射`"><option value="">待确认</option><option v-for="r in db.rooms" :key="r.id" :value="r.id">{{ r.name }}</option><option value="rest">休息</option><option value="vacation">预定休假（黄色）</option><option value="leave">事后请假</option></select></label></div><div class="preview-summary"><strong>预览 {{ parsed.length }}格</strong><span :class="errors.length ? 'text-amber' : 'text-green'">{{ errors.length }}项待处理错误</span><span>新员工 {{ newEmployees.length }}人</span><label class="checkbox-line"><input v-model="onlyErrors" type="checkbox" @change="pageIndex = 0" />仅看问题</label></div><div class="table-scroll import-preview"><table class="data-table"><thead><tr><th>原行</th><th>员工</th><th>日期</th><th>原文 / 底色</th><th>解析结果</th><th>问题</th><th>跳过</th></tr></thead><tbody><tr v-for="row in visibleRows" :key="`${row.row}|${row.date}`" :class="{ 'row-skipped': row.skip }"><td>{{ row.row }}</td><td>{{ row.name }}<small class="block-muted">{{ row.code || (row.employeeId ? '已匹配' : '新员工') }}</small></td><td>{{ row.date }}</td><td><span class="raw-cell" :style="{ background: row.color.startsWith('#') ? row.color : '#f7f8f7' }">{{ row.raw || '(空)' }}</span></td><td>{{ row.cell?.kind === 'shift' ? `${db.rooms.find(r => r.id === db.shifts.find(s => s.id === row.cell?.shiftId)?.roomId)?.name} ${db.shifts.find(s => s.id === row.cell?.shiftId)?.category}` : row.cell?.kind === 'rest' ? '休息' : row.cell?.kind === 'vacation' ? '预定休假' : row.cell?.kind === 'leave' ? '事后请假' : row.skip ? '仅附注/跳过' : '不写入' }}</td><td class="import-error">{{ row.error || '—' }}</td><td><input type="checkbox" :checked="row.skip" :aria-label="`跳过${row.name}${row.date}`" @change="skip(row)" /></td></tr><tr v-if="!visibleRows.length"><td colspan="7" class="empty-table">{{ parsed.length ? '当前筛选无问题。' : '尚未识别到数据，请检查姓名列和日期表头设置。' }}</td></tr></tbody></table></div><div class="pagination"><span>共{{ totalVisible }}格，每页40格</span><button class="icon-button" :disabled="pageIndex === 0" aria-label="上一页导入预览" @click="pageIndex--"><Icon name="left" :size="16" /></button><span>{{ pageIndex+1 }} / {{ Math.max(1,Math.ceil(totalVisible/40)) }}</span><button class="icon-button" :disabled="(pageIndex+1)*40 >= totalVisible" aria-label="下一页导入预览" @click="pageIndex++"><Icon name="right" :size="16" /></button></div><label v-if="newEmployees.length" class="checkbox-card"><input v-model="allowNew" type="checkbox" /><span><strong>确认创建{{ newEmployees.length }}名新员工</strong><small>{{ newEmployees.map(r => r.name).join('、') }}。导入后请核对生效日期与名单顺序。</small></span></label><div class="import-confirm-bar"><p class="muted">{{ purpose === 'vacation' ? '仅写入预定休假计划；空格不会取消已有计划。' : purpose === 'leave' ? '仅写入事后请假；空格不会撤销已有请假。' : purpose === 'availability' ? '仅写入个人休息，其余班次保持。' : '建立独立导入版本，旧版本仍可回看。' }}</p><button class="button primary" :disabled="!parsed.length || !!errors.length || !!newEmployees.length && !allowNew" @click="confirmOpen = true"><Icon name="check" :size="17" />确认导入</button></div></template></template></div></section><section class="panel top-gap"><header class="panel-header"><div><h2>导出当前排班</h2><p>包含月度表、独立休假计划、事后请假、员工统计、每日配对、排班明细和图例。</p></div><button class="button secondary" :disabled="!current || busy" @click="exportFile(false)"><Icon name="download" :size="17" />导出{{ month }}排班</button></header></section><Modal :open="confirmOpen" title="确认导入本地工作区" @close="confirmOpen = false"><p>文件：<strong>{{ filename }}</strong></p><p>目标：<strong>{{ options.month }}</strong> · {{ purpose === 'history' ? '历史排班' : purpose === 'vacation' ? '预定休假计划' : purpose === 'leave' ? '事后请假' : purpose === 'availability' ? '个人休息' : '人工排班' }}</p><p>将创建{{ newEmployees.length }}名员工，处理{{ parsed.filter(r => !r.skip && r.cell).length }}格有效数据。</p><p v-if="activeVersion(db,options.month)" class="fineprint">已有版本仍会保留；个人休假导入会更新当前草稿。导入操作会一次完成，失败不部分写入。</p><template #footer><button class="button secondary" @click="confirmOpen = false">返回核对</button><button class="button primary" @click="confirm">确认写入</button></template></Modal></template>
