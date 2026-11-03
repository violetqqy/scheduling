<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from './Icon.vue'
const props = withDefaults(defineProps<{ open: boolean; title: string; wide?: boolean; drawer?: boolean }>(), { wide: false, drawer: false })
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement>(), previous = ref<HTMLElement>()
watch(() => props.open, async value => {
  if (value) { previous.value = document.activeElement as HTMLElement; await nextTick(); panel.value?.focus() }
  else previous.value?.focus()
})
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
  if (event.key !== 'Tab') return
  const elements = panel.value?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, [tabindex="0"]')
  if (!elements?.length) { event.preventDefault(); return }
  const first = elements[0]!, last = elements[elements.length - 1]!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) { event.preventDefault(); first.focus() }
}
</script>
<template>
  <Teleport to="body"><div v-if="open" class="modal-backdrop" :class="{ 'drawer-backdrop': drawer }" @mousedown.self="emit('close')">
    <section ref="panel" class="modal" :class="{ wide, drawer }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown="onKey">
      <header class="modal-header"><h2>{{ title }}</h2><button class="icon-button" aria-label="关闭弹窗" @click="emit('close')"><Icon name="close" /></button></header>
      <div class="modal-body"><slot /></div><footer v-if="$slots.footer" class="modal-footer"><slot name="footer" /></footer>
    </section>
  </div></Teleport>
</template>
