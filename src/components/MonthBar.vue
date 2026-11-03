<script setup lang="ts">
import { computed } from 'vue'
import { current, db, month, commit } from '../store'
import { addMonths } from '../domain/dates'
import Icon from './Icon.vue'
const versions = computed(() => db.value.versions.filter(v => v.month === month.value).slice().reverse())
function selectVersion(event: Event) { const id = (event.target as HTMLSelectElement).value; void commit('已切换查看版本', month.value, d => { d.activeVersions[month.value] = id }, true) }
</script>
<template><div class="month-bar"><div class="month-control"><button class="icon-button" aria-label="上一个月" @click="month = addMonths(month, -1)"><Icon name="left" :size="18" /></button><input v-model="month" aria-label="选择排班月份" type="month" min="2000-01" max="2100-12" /><button class="icon-button" aria-label="下一个月" @click="month = addMonths(month, 1)"><Icon name="right" :size="18" /></button></div><span class="vertical-divider"></span><select v-if="versions.length" class="version-select" :value="current?.id" aria-label="选择排班版本" @change="selectVersion"><option v-for="v in versions" :key="v.id" :value="v.id">{{ v.name }} · {{ v.status === 'confirmed' ? '已确认' : v.status === 'imported' ? '历史导入' : '草稿' }}</option></select><span v-else class="muted">本月还没有排班版本</span><slot /></div></template>
