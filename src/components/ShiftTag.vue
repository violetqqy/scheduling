<script setup lang="ts">
import { computed } from 'vue'
import type { Cell } from '../domain/types'
import { db } from '../store'
import Icon from './Icon.vue'
const props = defineProps<{ cell?: Cell; full?: boolean }>()
const shift = computed(() => db.value.shifts.find(s => s.id === props.cell?.shiftId))
const room = computed(() => db.value.rooms.find(r => r.id === shift.value?.roomId))
const label = computed(() => props.cell?.kind === 'custom' ? props.cell.customName : props.cell?.kind === 'overtime' ? '加班' : props.cell?.kind === 'rest' ? '休' : props.cell?.kind === 'vacation' ? '预' : props.cell?.kind === 'leave' ? '请' : props.cell?.kind === 'shift' ? shift.value?.category || '?' : '—')
</script>
<template><span class="shift-tag" :class="[cell?.kind || 'empty', { full }]" :style="cell?.kind === 'shift' ? { background: room?.color, color: room?.ink, borderColor: room?.id === 'photon' ? '#dce3e0' : 'transparent' } : {}"><span>{{ full && cell?.kind === 'shift' ? `${room?.name} · ` : '' }}{{ label }}{{ full && cell?.kind === 'vacation' ? ' 预定休假' : '' }}{{ full && cell?.kind === 'leave' ? ' 事后请假' : '' }}{{ full && cell?.kind === 'rest' ? ' 休息' : '' }}</span><Icon v-if="cell?.locked && (cell.kind === 'shift' || cell.kind === 'overtime' || cell.kind==='custom')" name="lock" :size="9" /></span></template>
