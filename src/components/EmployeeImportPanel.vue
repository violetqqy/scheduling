<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type ExcelJS from 'exceljs'
import type { EmployeeImportOptions } from '../services/excel'
import type { EmployeeImportRow } from '../domain/types'
import { employeeImportPreview } from '../domain/employee-import'
import { db, importEmployees, navigate, setupImport } from '../store'
import Modal from './Modal.vue'
const props = defineProps<{workbook:ExcelJS.Workbook;filename:string;excel:typeof import('../services/excel')}>()
const sheetName = ref(props.workbook.getWorksheet('员工名单')?.name || props.workbook.getWorksheet('员工资料')?.name || props.workbook.worksheets[0]?.name || '')
const options = reactive<EmployeeImportOptions>({headerRow:1,startRow:2,codeColumn:1,nameColumn:2,orderColumn:3,fromColumn:4,toColumn:5,noteColumn:6})
const skipped = ref(new Set<number>()), allowUpdates = ref(false), confirmOpen = ref(false), limit = ref(100)
const sheet = computed(() => props.workbook.getWorksheet(sheetName.value))
function detect() {
  if (!sheet.value) return
  const headers = Array.from({length:Math.min(sheet.value.columnCount,50)},(_,i) => sheet.value!.getCell(options.headerRow,i+1).text.trim())
  const at = (pattern:RegExp) => headers.findIndex(h => pattern.test(h))+1
  options.codeColumn = at(/^(员工编号|编号|工号)$/); options.nameColumn = at(/^(姓名|员工姓名|员工)$/) || 1
  options.orderColumn = at(/^(顺序|排序|序号)$/); options.fromColumn = at(/^(生效日期|入职日期)$/); options.toColumn = at(/^(停用日期|离职日期)$/); options.noteColumn = at(/^(备注|说明)$/)
  skipped.value = new Set(); allowUpdates.value = false; limit.value = 100
}
watch(sheetName,detect,{immediate:true})
const preview = computed(() => {
  if (!sheet.value) return {rows:[] as EmployeeImportRow[],error:''}
  try {
    const rows = props.excel.previewEmployeeSheet(sheet.value,db.value,options)
    return {rows:employeeImportPreview(db.value,rows.map(r => ({...r,skip:skipped.value.has(r.row)}))),error:''}
  } catch (e) {return {rows:[] as EmployeeImportRow[],error:e instanceof Error ? e.message : '无法解析员工名单'}}
})
const included = computed(() => preview.value.rows.filter(r => !r.skip)), errors = computed(() => included.value.filter(r => r.error)), updates = computed(() => included.value.filter(r => r.employeeId).length)
function skip(row:number) {const next = new Set(skipped.value); next.has(row) ? next.delete(row) : next.add(row); skipped.value = next}
async function confirm() {
  if (await importEmployees(preview.value.rows,props.filename,allowUpdates.value)) {confirmOpen.value=false; const setup=setupImport.value; setupImport.value=false; navigate(setup ? 'overview' : 'employees')}
}
</script>
<template>
<div class="mapping-title"><h3>员工名单字段映射</h3><button class="text-button" @click="detect">根据表头重新识别</button></div>
<p class="fineprint">每人一行，不需要班次。姓名必填；编号可留空，系统按唯一姓名匹配或自动编号。同名员工需提供编号。</p>
<div class="mapping-grid"><label class="field">员工工作表<select v-model="sheetName" aria-label="员工工作表"><option v-for="s in workbook.worksheets" :key="s.name" :value="s.name">{{ s.name }}</option></select></label><label class="field">表头行<input v-model.number="options.headerRow" type="number" min="1" max="1000" /></label><label class="field">员工数据起始行<input v-model.number="options.startRow" type="number" min="2" max="1001" /></label><label class="field">姓名列<input v-model.number="options.nameColumn" type="number" min="1" max="50" /></label><label class="field">编号列（0为无）<input v-model.number="options.codeColumn" type="number" min="0" max="50" /></label><label class="field">顺序列（0为无）<input v-model.number="options.orderColumn" type="number" min="0" max="50" /></label><label class="field">生效日期列（0为无）<input v-model.number="options.fromColumn" type="number" min="0" max="50" /></label><label class="field">停用日期列（0为无）<input v-model.number="options.toColumn" type="number" min="0" max="50" /></label><label class="field">备注列（0为无）<input v-model.number="options.noteColumn" type="number" min="0" max="50" /></label></div>
<div class="callout flat"><p>相同编号可预览后确认更新；可选字段留空时保留原资料。未列入文件的员工不会被删除或停用。</p></div><p v-if="preview.error" class="error-text" role="alert">{{ preview.error }}</p>
<div class="preview-summary"><strong>员工预览 {{ included.length }}人</strong><span>新增 {{ included.length-updates }}人</span><span>更新 {{ updates }}人</span><span :class="errors.length ? 'text-amber' : 'text-green'">{{ errors.length }}项待处理错误</span></div>
<div class="table-scroll import-preview"><table class="data-table"><thead><tr><th>原行</th><th>员工编号</th><th>姓名</th><th>顺序</th><th>生效日期</th><th>停用日期</th><th>操作</th><th>问题</th><th>跳过</th></tr></thead><tbody><tr v-for="r in preview.rows.slice(0,limit)" :key="r.row" :class="{'row-skipped':r.skip}"><td>{{ r.row }}</td><td>{{ r.code }}<small v-if="!r.rawCode" class="block-muted">按姓名匹配 / 自动编号</small></td><td>{{ r.name }}</td><td>{{ r.order || '保留 / 追加' }}</td><td>{{ r.from || '不限' }}</td><td>{{ r.to || '不限' }}</td><td>{{ r.employeeId ? '更新资料' : '新增员工' }}</td><td class="import-error">{{ r.error || '—' }}</td><td><input type="checkbox" :checked="r.skip" :aria-label="`跳过员工第${r.row}行`" @change="skip(r.row)" /></td></tr><tr v-if="!preview.rows.length"><td colspan="9" class="empty-table">尚无员工数据，请填写模板或检查工作表及姓名列。</td></tr></tbody></table></div>
<button v-if="preview.rows.length > limit" class="button secondary top-gap" @click="limit += 100">继续显示</button><label v-if="updates" class="checkbox-card"><input v-model="allowUpdates" type="checkbox" /><span><strong>确认更新{{ updates }}名已有员工</strong><small>按员工编号匹配，更新姓名及文件中填写的资料。历史排班引用继续保留。</small></span></label>
<div class="import-confirm-bar"><p class="muted">只写入员工资料，不生成或覆盖班表。导入完成后可继续初始化排班。</p><button class="button primary" :disabled="!included.length || !!errors.length || !!preview.error || !!updates && !allowUpdates" @click="confirmOpen=true">确认导入员工名单</button></div>
<Modal :open="confirmOpen" title="确认导入员工名单" @close="confirmOpen=false"><p>文件：{{ filename }}</p><p>新增{{ included.length-updates }}人，更新{{ updates }}人。不会生成或修改已有排班。</p><p class="fineprint">整批写入，出错时不保存部分结果。</p><template #footer><button class="button secondary" @click="confirmOpen=false">返回核对</button><button class="button primary" @click="confirm">确认写入员工</button></template></Modal>
</template>
