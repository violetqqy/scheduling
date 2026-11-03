<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { db, month, navigate, notify, saveDemandSettings, saving } from '../store'
import { addMonths, daysInMonth, prettyMonth, weekday } from '../domain/dates'
import { openOn, required } from '../domain/model'
import { planDemandChanges } from '../domain/demand'
import type { DemandAction } from '../domain/demand'
import Icon from './Icon.vue'

const days=computed(()=>daysInMonth(month.value))
const openDays=computed(()=>days.value.filter(date=>openOn(db.value,date)))
const offset=computed(()=>days.value.length?(new Date(`${month.value}-01T12:00:00`).getDay()+6)%7:0)
const bulk=ref(false), singleDate=ref(openDays.value[0] || days.value[0] || '')
const chosen=ref<string[]>([]), rangeFrom=ref(days.value[0] || ''), rangeTo=ref(days.value.at(-1) || '')
const actions=ref<Record<string,DemandAction>>({})
function resetActions(){actions.value=Object.fromEntries(db.value.shifts.map(s=>[s.id,'keep' as const]))}
resetActions()
const targets=computed(()=>bulk.value?chosen.value:singleDate.value?[singleDate.value]:[])
const preview=computed(()=>{
  try{return {plan:planDemandChanges(db.value,month.value,targets.value,actions.value),error:''}}
  catch(error){return {plan:undefined,error:error instanceof Error?error.message:'需求设置无效'}}
})
watch(month,()=>{
  singleDate.value=openDays.value[0] || days.value[0] || '';chosen.value=[]
  rangeFrom.value=days.value[0] || '';rangeTo.value=days.value.at(-1) || '';resetActions()
})
watch(singleDate,()=>{if(!bulk.value)resetActions()})
watch(()=>db.value.shifts.map(s=>`${s.id}:${s.enabled}`).join('|'),()=>{
  for(const s of db.value.shifts)if(!s.enabled && actions.value[s.id]!=='default')actions.value[s.id]='keep'
})
function toggleMode(){bulk.value=!bulk.value;chosen.value=bulk.value && openOn(db.value,singleDate.value)?[singleDate.value]:[];resetActions()}
function choose(date:string){
  if(!bulk.value){singleDate.value=date;return}
  if(!openOn(db.value,date))return
  chosen.value=chosen.value.includes(date)?chosen.value.filter(d=>d!==date):[...chosen.value,date].sort()
}
function selectRange(){
  if(!rangeFrom.value || !rangeTo.value || rangeFrom.value>rangeTo.value || rangeFrom.value.slice(0,7)!==month.value || rangeTo.value.slice(0,7)!==month.value){notify('请选择当月有效日期范围','error');return}
  chosen.value=openDays.value.filter(d=>d>=rangeFrom.value && d<=rangeTo.value)
}
function setAll(action:DemandAction){for(const s of db.value.shifts)actions.value[s.id]=s.enabled || action==='default'?action:'keep'}
function count(date:string){return db.value.shifts.filter(s=>required(db.value,date,s.id)>0).length}
function roomCount(date:string,roomId:string){return db.value.shifts.filter(s=>s.roomId===roomId && required(db.value,date,s.id)>0).length}
function custom(date:string){return db.value.shifts.some(s=>Object.hasOwn(db.value.demand,`${date}|${s.id}`))}
function state(shiftId:string){
  if(!db.value.shifts.find(s=>s.id===shiftId)?.enabled)return '全局停用'
  const selected=preview.value.plan?.eligible || []
  if(!selected.length)return '未选择开班日'
  const enabled=selected.filter(date=>required(db.value,date,shiftId)>0).length
  return enabled===selected.length?'全部启用':enabled===0?'全部关闭':'部分启用'
}
async function save(){if(await saveDemandSettings(month.value,[...targets.value],{...actions.value}))resetActions()}
</script>

<template>
<section class="panel top-gap demand-section" aria-label="按日期调整需求">
  <header class="panel-header demand-heading"><div><h2>按日期调整需求</h2><p>整月查看开班需求。点击一天设置，或切换多选后批量调整。</p></div><div class="month-control"><button class="icon-button" aria-label="需求日历上月" :disabled="saving" @click="month=addMonths(month,-1)"><Icon name="left" :size="17" /></button><input v-model="month" type="month" min="2000-01" max="2100-12" aria-label="需求月份" :disabled="saving" /><button class="icon-button" aria-label="需求日历下月" :disabled="saving" @click="month=addMonths(month,1)"><Icon name="right" :size="17" /></button></div></header>
  <div class="demand-toolbar"><div class="actions"><button class="button secondary small-button" :aria-pressed="bulk" :disabled="saving" @click="toggleMode">{{ bulk?'退出多选日期':'多选日期 / 批量设置' }}</button><template v-if="bulk"><button class="button secondary small-button" :disabled="!openDays.length || saving" @click="chosen=[...openDays]">全选开班日</button><button class="text-button" :disabled="!chosen.length || saving" @click="chosen=[]">清除日期选择</button></template></div><span aria-live="polite">{{ prettyMonth(month) }} · {{ openDays.length }}天开班<span v-if="bulk"> · 已选{{ chosen.length }}天</span></span></div>
  <div v-if="bulk" class="demand-range"><label>开始日期<input v-model="rangeFrom" type="date" :min="days[0]" :max="days.at(-1)" :disabled="saving" /></label><label>结束日期<input v-model="rangeTo" type="date" :min="rangeFrom || days[0]" :max="days.at(-1)" :disabled="saving" /></label><button class="button secondary small-button" :disabled="saving" @click="selectRange">选择范围内开班日</button><small>也可点击日历，选择不连续日期。</small></div>
  <div class="demand-layout">
    <div><div class="demand-calendar" role="group" aria-label="月度需求日历"><div v-for="w in ['一','二','三','四','五','六','日']" :key="w" class="calendar-weekday">周{{ w }}</div><div v-for="n in offset" :key="`blank-${n}`" class="demand-blank"></div><button v-for="date in days" :key="date" class="demand-day" :class="{off:!openOn(db,date),selected:bulk?chosen.includes(date):singleDate===date}" :disabled="saving || bulk && !openOn(db,date)" :aria-pressed="bulk?chosen.includes(date):singleDate===date" :aria-label="`${date} ${openOn(db,date)?`${count(date)}班 ${count(date)*2}人`:'休息日'}${bulk?' 选择需求日期':' 设置需求'}`" @click="choose(date)"><span class="demand-date"><strong>{{ Number(date.slice(8)) }}</strong><small>{{ !openOn(db,date)?'休息':custom(date)?'已调整':'开班' }}</small></span><span class="demand-total">{{ count(date) }}班 <small>· {{ count(date)*2 }}人</small></span><span v-if="openOn(db,date)" class="demand-room-counts"><span v-for="room in db.rooms" :key="room.id" :style="{background:room.color,color:room.ink}">{{ room.id==='red'?'红':room.id==='orange'?'橙':room.id==='blue'?'白':'光' }}{{ roomCount(date,room.id) }}</span></span><small v-else class="demand-off-note">工作日历调整</small></button></div><p class="demand-caption">每个启用班次固定2人。红、橙、白、光后的数字为当天各房间启用班次数。休息日不参与批量设置。</p></div>
    <aside class="demand-editor" aria-label="需求设置面板"><h3>{{ bulk?`批量设置 · 已选${targets.length}天`:`${singleDate} · 周${weekday(singleDate)}` }}</h3><p v-if="bulk" class="demand-selected-dates">{{ targets.length?targets.map(d=>d.slice(5)).join('、'):'先在左侧选择日期，再设置需要修改的班次。' }}</p><div v-if="preview.plan?.skipped.length" class="inline-alert"><Icon name="info" :size="16" /><span>所选包含{{ preview.plan.skipped.length }}个休息日。需求保持0；需先在工作日历设为开班。</span><button class="text-button" @click="navigate('calendar')">前往日历</button></div><div class="demand-editor-actions"><button class="text-button" :disabled="!preview.plan?.eligible.length || saving" @click="setAll('enable')">全部启用</button><button class="text-button" :disabled="!preview.plan?.eligible.length || saving" @click="setAll('disable')">全部关闭</button><button class="text-button" :disabled="!preview.plan?.eligible.length || saving" @click="setAll('default')">恢复默认需求</button></div>
      <div class="demand-settings"><label v-for="shift in db.shifts" :key="shift.id" class="demand-setting"><span><strong>{{ db.rooms.find(r=>r.id===shift.roomId)?.name }} · {{ shift.category }}班</strong><small>当前：{{ state(shift.id) }}</small></span><select v-model="actions[shift.id]" :disabled="!preview.plan?.eligible.length || saving" :aria-label="`${db.rooms.find(r=>r.id===shift.roomId)?.name}${shift.category}班需求设置`"><option value="keep">保持不变</option><option value="enable" :disabled="!shift.enabled">启用 · 2人</option><option value="disable" :disabled="!shift.enabled">关闭 · 0人</option><option value="default">恢复默认</option></select></label></div>
      <p v-if="preview.error" class="error-text" role="alert">{{ preview.error }}</p><p class="demand-save-preview" aria-live="polite">{{ preview.plan?.changes.length?`将更新${preview.plan.eligible.length}天、${preview.plan.changes.length}项需求配置`:'选择要修改的班次后统一保存，保持不变的班次不受影响。' }}</p><button class="button primary full-width" :disabled="!preview.plan?.changes.length || saving" @click="save">{{ saving?'正在保存…':bulk?'保存批量需求':'保存当日需求' }}</button><p class="fineprint">默认需求跟随全局班次开关。修改用于下一次生成，已有班表和历史需求快照会保留。</p>
    </aside>
  </div>
</section>
</template>

<style scoped>
.demand-heading{flex-wrap:wrap}.demand-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:0 24px 18px}.demand-toolbar>span{font-size:11px;color:var(--muted)}.demand-range{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;padding:15px 24px;background:#f4f8f5;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.demand-range label{display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:11px}.demand-range input{min-height:34px;font-size:12px}.demand-range small{font-size:11px;color:var(--muted);padding-bottom:8px}.demand-layout{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(280px,1fr);gap:24px;padding:0 24px 24px}.demand-calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.demand-day{display:flex;flex-direction:column;align-items:stretch;text-align:left;gap:7px;padding:8px;min-height:96px;line-height:1.3;border:1px solid var(--line);border-radius:6px;background:#fff}.demand-day:hover:not(:disabled){border-color:#9cbea9;background:#f6faf7}.demand-day.off{background:#f6f8f6;color:#98a69d}.demand-day.selected{box-shadow:inset 0 0 0 1px var(--primary);border-color:var(--primary);background:#f0f7f2}.demand-day:disabled{opacity:.65}.demand-date{display:flex;justify-content:space-between;align-items:center;gap:3px}.demand-date strong{font-size:15px}.demand-date>small{font-size:9px;color:var(--muted)}.demand-total{font-size:12px;font-weight:600}.demand-total small{font-size:9px;font-weight:400;color:var(--muted)}.demand-room-counts{display:grid;grid-template-columns:1fr 1fr;gap:3px;margin-top:auto}.demand-room-counts>span{border:1px solid #00000006;border-radius:3px;text-align:center;font-size:9px;padding:1px}.demand-off-note{font-size:9px;color:#a2aea6;margin-top:auto}.demand-caption{font-size:11px;color:var(--muted);line-height:1.8;margin-top:14px}.demand-editor{border:1px solid var(--line);border-radius:7px;padding:17px;background:#fbfdfb;align-self:start}.demand-editor h3{font-size:14px}.demand-selected-dates{font-size:11px;line-height:1.8;color:var(--muted);margin-top:8px;max-height:75px;overflow:auto}.demand-editor .inline-alert{padding:10px;margin-top:12px;align-items:flex-start;flex-wrap:wrap}.demand-editor-actions{display:flex;gap:15px;flex-wrap:wrap;padding:13px 0;border-bottom:1px solid var(--line)}.demand-setting{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}.demand-setting strong{font-size:11px;font-weight:500}.demand-setting small{display:block;font-size:10px;color:var(--muted);margin-top:3px}.demand-setting select{font-size:11px;min-height:34px;width:115px;padding:6px 8px;flex-shrink:0}.demand-save-preview{font-size:11px;color:var(--muted);line-height:1.8;margin:14px 0 12px}.demand-editor .fineprint{margin-top:11px;font-size:10px}
@media(max-width:1150px){.demand-layout{grid-template-columns:1fr}.demand-settings{display:grid;grid-template-columns:1fr 1fr;column-gap:24px}.demand-day{min-height:108px}}
@media(max-width:600px){.demand-layout{padding:0 12px 16px;gap:16px}.demand-toolbar{padding:0 12px 14px}.demand-range{padding:12px}.demand-calendar{gap:3px}.demand-day{padding:7px 3px;min-height:104px;gap:7px}.demand-date strong{font-size:13px}.demand-date>small{font-size:8px}.demand-total{font-size:10px}.demand-total small{font-size:8px}.demand-room-counts>span{font-size:8px;padding:1px 0}.demand-off-note{font-size:8px}.demand-settings{grid-template-columns:1fr}.demand-editor{padding:14px}.demand-heading{padding:18px 14px}}
</style>
