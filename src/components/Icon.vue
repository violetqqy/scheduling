<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2ZM7 14h2m4 0h2m-8 4h2m4 0h2',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm8 .13a4 4 0 0 1 0 7.75',
  rooms: 'M3 21h18M5 21V3h14v18M9 7h1m4 0h1m-6 4h1m4 0h1m-5 10v-5h4v5',
  chart: 'M4 3v18h18M8 16v-5m5 5V7m5 9V4',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  download: 'M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-5h4l.6 3 2.4 1.4 2.8-1 2 3.4-2.2 2v2.8l2.2 2-2 3.4-2.8-1-2.4 1.4-.6 3h-4l-.6-3-2.4-1.4-2.8 1-2-3.4 2.2-2v-2.8l-2.2-2 2-3.4 2.8 1 2.4-1.4Z',
  left: 'm15 18-6-6 6-6', right: 'm9 18 6-6-6-6', down: 'm6 9 6 6 6-6', arrow: 'M4 12h16m-6-6 6 6-6 6',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6',
  sparkle: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4',
  warning: 'm12 3 10 17H2L12 3Zm0 5v5m0 3v1', info: 'M12 11v6m0-10v1M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  lock: 'M6 10h12v11H6V10Zm2 0V6a4 4 0 0 1 8 0v4m-4 4v3', search: 'm21 21-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
  logout: 'M9 21H4V3h5m6 4 5 5-5 5M8 12h12', menu: 'M4 6h16M4 12h16M4 18h16',
  database: 'M3 6c0 5 18 5 18 0S3 1 3 6Zm0 0v12c0 5 18 5 18 0V6M3 12c0 5 18 5 18 0',
  clock: 'M12 7v5l3 2M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z',
  edit: 'm16 3 5 5L9 20l-6 1 1-6L16 3Zm-2 2 5 5', filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Zm-4 10 3 3 5-6',
  file: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 12h8m-8 4h8', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.calendar" /></svg></template>
