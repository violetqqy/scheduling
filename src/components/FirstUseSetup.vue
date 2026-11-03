<script setup lang="ts">
import { computed } from 'vue'
import { db, month, navigate, openImport } from '../store'
import { addMonths, daysInMonth } from '../domain/dates'
import { activeOn, activeVersion } from '../domain/model'
import Icon from './Icon.vue'
const emit = defineEmits<{generate:[]}>()
const history = computed(() => activeVersion(db.value,addMonths(month.value,-1)))
const eligible = computed(() => db.value.employees.filter(e => daysInMonth(month.value).some(d => activeOn(e,d))).length)
</script>
<template>
<section class="panel first-use-setup"><header class="panel-header"><div><h2>{{ db.versions.some(v => Object.values(v.cells).some(c => c.kind === 'shift')) ? '准备这个月的班表' : '从这里准备第一份班表' }}</h2><p>已有员工和班表可导入。没有上月记录，也能按现有规则开始排班。</p></div><label class="field setup-month">目标排班月份<input v-model="month" type="month" aria-label="初始化排班月份" /></label></header>
<ol class="setup-steps"><li><span class="setup-number">1</span><div><h3>准备员工名单 <span v-if="db.employees.length" class="pill success">已有{{ db.employees.length }}人</span></h3><p>导入现有Excel名单，或在员工管理手工新增。员工顺序影响早晚班优先目标。</p><div class="actions"><button class="button primary" @click="openImport('employees',true)">导入员工名单</button><button class="text-button" @click="navigate('employees')">手工添加员工</button></div></div></li>
<li><span class="setup-number">2</span><div><h3>导入已有上月班表 <span class="pill">可跳过</span><span v-if="history" class="pill success">已有{{ history.month }}</span></h3><p>有{{ addMonths(month,-1) }}班表时导入，延续跨月班次和轮转。也可直接从班表创建员工，无需重复导入名单。</p><button class="button secondary" @click="openImport('history',true)">导入已有班表</button></div></li>
<li><span class="setup-number">3</span><div><h3>核对日历与休假，生成班表</h3><p>{{ history ? '将使用上月班表，按当前规则生成目标月草稿。' : '没有上月记录：从本月首日开始，只跳过上月光子禁排、房间轮转和跨月继承。' }} 每班两人、休假保护、早晚优先及手工调整均可用。</p><div class="actions"><button class="button secondary" @click="navigate('calendar')">配置工作日历与休假</button><button class="button primary" :disabled="!eligible" @click="emit('generate')"><Icon name="sparkle" :size="16" />生成{{ month }}排班</button></div><p v-if="!eligible && db.employees.length" class="error-text">目标月没有在职员工，请核对员工生效和停用日期。</p><p v-else-if="!db.employees.length" class="fineprint">先准备员工。八班全部开班每天需要16人，不足时会报告缺口。</p></div></li></ol>
</section>
</template>
