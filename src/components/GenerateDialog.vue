<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { current, db, generateMonth, generating, month, navigate, openImport } from '../store'
import { activeVersion, activeOn } from '../domain/model'
import { addMonths, daysInMonth } from '../domain/dates'
import Modal from './Modal.vue'
import Icon from './Icon.vue'
const props = defineProps<{ open: boolean; next?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const target = ref(month.value), mode = ref<'fill' | 'rebuild'>('rebuild')
watch(() => props.open, value => { if (value) target.value = props.next ? addMonths(month.value, 1) : month.value })
const plans = computed(() => db.value.vacationPlans.filter(p => p.month === target.value))
const eligible = computed(() => db.value.employees.filter(e => daysInMonth(target.value).some(d => activeOn(e,d))).length)
const source = computed(() => activeVersion(db.value, addMonths(target.value, -1)))
async function run() { if (await generateMonth(target.value, mode.value)) emit('close') }
</script>
<template><Modal :open="open" title="生成月度排班" @close="!generating && emit('close')"><div class="callout green"><Icon name="shield" /><div><strong>保护已有安排</strong><p>人工不可用、加班、自定义和已锁定普通班保留。解锁后重排按工作日历和休假计划恢复，结果保存为新草稿。</p></div></div><label class="field">目标月份<input v-model="target" type="month" min="2000-01" max="2100-12" /></label><div class="source-box"><span class="muted">上月参考版本</span><strong>{{ source?.name || '首次排班 · 无上月参考' }}</strong><small>{{ source ? `${source.month} · ${source.status === 'confirmed' ? '已确认' : '未确认/导入记录'}` : '从本月首日开始，跳过上月光子禁排、房间历史偏好和跨月续班，其余规则照常执行。' }}</small></div><div v-if="!eligible" class="callout amber"><div><strong>目标月尚无在职员工</strong><p>先导入员工名单或核对员工生效日期，再生成。</p><button class="text-button" @click="month = target; openImport('employees',true); emit('close')">导入员工名单</button></div></div><div class="source-box"><span class="muted">目标月预定休假</span><strong>{{ new Set(plans.map(p => p.employeeId)).size }}人 · {{ plans.reduce((n,p) => n+p.dates.length,0) }}人天</strong><small>生成前请核对计划；没有休假的月份可直接生成。</small><button class="text-button" @click="month = target; navigate('calendar'); emit('close')">查看 / 调整休假计划</button></div><label class="radio-card"><input v-model="mode" type="radio" value="rebuild" /><div><strong>重排未锁定格</strong><span>按最新规则重新计算，保留受保护格。</span></div></label><label class="radio-card"><input v-model="mode" type="radio" value="fill" /><div><strong>仅补空位</strong><span>保留可用日已有普通班，只补空位；解锁后落在休息或计划休假日的班次恢复计划。</span></div></label><p class="fineprint">先分析上月，自动推导跨月续段、早晚顺延、休假递延和光子转白任务，再生成本月班表。先补历史早晚目标，再按名单保证本月早晚段；完整白班、光子或整段预定休假允许早晚顺延。工作段长度随日历。完成早晚目标后再优化当月至少两个房间。红/黄房间按工作段早→中→晚循环，跨月原段先续完。搭档动态配对，每个启用班严格2人。手工混班允许，自动不新增混班；要保留混班整段，请锁定已有班次。无法排满时保留缺口报告，不自动放宽硬约束。{{ current?.status === 'confirmed' ? '当前确认版本会保留。' : '' }}</p><template #footer><button class="button secondary" :disabled="generating" @click="emit('close')">取消</button><button class="button primary" :disabled="generating || !target || !eligible" @click="run"><Icon :name="generating ? 'clock' : 'sparkle'" :size="17" />{{ generating ? '正在计算，请稍候…' : '开始生成' }}</button></template></Modal></template>
