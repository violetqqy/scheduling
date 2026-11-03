<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import type { Component } from 'vue'
import type { Page } from './domain/types'
import { authenticated, db, initialize, loadError, login, LOGIN, logout, month, navigate, page, ready, saving, sidebarOpen, toast, settingsSection } from './store'
import { prettyMonth } from './domain/dates'
import Icon from './components/Icon.vue'

const menu: { id: Page; name: string; icon: string; group: string }[] = [
  { id: 'overview', name: '工作台', icon: 'home', group: '工作空间' },
  { id: 'schedule', name: '月度排班', icon: 'calendar', group: '' },
  { id: 'statistics', name: '统计分析', icon: 'chart', group: '' },
  { id: 'employees', name: '员工管理', icon: 'users', group: '基础管理' },
  { id: 'shifts', name: '房间与班次', icon: 'rooms', group: '' },
  { id: 'calendar', name: '工作日历', icon: 'clock', group: '' },
  { id: 'import', name: '导入与导出', icon: 'upload', group: '数据与设置' },
  { id: 'settings', name: '规则与设置', icon: 'settings', group: '' },
]
const pages: Record<Page, Component> = {
  overview: defineAsyncComponent(() => import('./pages/OverviewPage.vue')),
  schedule: defineAsyncComponent(() => import('./pages/SchedulePage.vue')),
  employees: defineAsyncComponent(() => import('./pages/EmployeesPage.vue')),
  shifts: defineAsyncComponent(() => import('./pages/ShiftsPage.vue')),
  calendar: defineAsyncComponent(() => import('./pages/CalendarPage.vue')),
  import: defineAsyncComponent(() => import('./pages/ImportPage.vue')),
  statistics: defineAsyncComponent(() => import('./pages/StatisticsPage.vue')),
  settings: defineAsyncComponent(() => import('./pages/SettingsPage.vue')),
}
const currentPage = computed(() => pages[page.value] || pages.overview)
const username = ref('admin'), password = ref(''), loginError = ref(''), showPassword = ref(false)
function submit() { if (!login(username.value, password.value)) loginError.value = '账号或密码不正确，请重新输入。' }
function reloadPage() { window.location.reload() }
function route() { const candidate = location.hash.slice(1) as Page; if (pages[candidate]) page.value = candidate; else page.value = 'overview' }
onMounted(() => { route(); window.addEventListener('hashchange', route); void initialize() })
onUnmounted(() => window.removeEventListener('hashchange', route))
</script>
<template>
  <main v-if="!authenticated" class="login-page">
    <section class="login-story"><div class="brand"><span class="brand-symbol"><Icon name="calendar" :size="26" /></span><span>班序<small>让安排更有序</small></span></div><div class="login-intro"><span class="pill light">月度排班管理</span><h1>把每一天，<br />安排妥当。</h1><p>有历史，延续有据；<br />第一次排班，也能从这里开始。</p><div class="login-planner" aria-hidden="true"><div class="planner-top"><strong>有序的一周</strong><span>每班两人，默契不必固定</span></div><div class="planner-days"><span v-for="day in ['一','二','三','四','五']" :key="day">周{{ day }}</span></div><div v-for="(room, i) in ['red','orange','blue','photon']" :key="room" class="planner-row"><span v-for="n in 5" :key="n" :class="room">{{ ['早班','晚班','白班','光子'][i] }}</span></div><div class="planner-note"><Icon name="check" :size="15" />休假被保护，轮转有依据。</div></div></div><span class="login-footer">班序 · 本地工作空间</span></section>
    <section class="login-form-wrap"><form class="login-form" @submit.prevent="submit"><div class="login-mobile-brand">班序</div><h2>欢迎回来</h2><p class="muted">登录工作空间，开始安排新的一个月。</p><label class="field">账号<input v-model="username" autocomplete="username" required placeholder="请输入账号" /></label><label class="field">密码<div class="password-field"><input v-model="password" :type="showPassword ? 'text' : 'password'" autocomplete="current-password" required placeholder="请输入密码" /><button type="button" class="icon-button" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><Icon name="eye" :size="18" /></button></div></label><p v-if="loginError" class="error-text" role="alert">{{ loginError }}</p><button type="submit" class="button primary login-submit">登录工作空间<Icon name="arrow" :size="18" /></button><div class="credential-note"><Icon name="info" :size="16" /><div>本地默认账号 <strong>{{ LOGIN.username }}</strong><br />密码 <strong>{{ LOGIN.password }}</strong></div><button type="button" class="text-button" @click="username = LOGIN.username; password = LOGIN.password; loginError = ''">填入</button></div><p class="login-local"><Icon name="database" :size="15" />数据保存在当前浏览器，不上传服务器。</p></form></section>
  </main>
  <div v-else-if="loadError" class="loading-page"><Icon name="warning" :size="40" /><h1>本地数据暂时无法打开</h1><p>{{ loadError }}</p><p class="muted">原数据不会被替换。检查浏览器存储权限后刷新重试。</p><button class="button primary" @click="reloadPage">刷新重试</button></div>
  <div v-else-if="!ready" class="loading-page"><div class="spinner"></div><h2>正在准备本地工作空间</h2><p class="muted">首次使用从空白工作区开始，可导入员工名单和已有班表。</p></div>
  <div v-else class="app-shell">
    <div v-if="sidebarOpen" class="sidebar-scrim" @click="sidebarOpen = false"></div>
    <aside class="sidebar" :class="{ open: sidebarOpen }"><a class="brand" href="#overview" @click.prevent="navigate('overview')"><span class="brand-symbol"><Icon name="calendar" :size="25" /></span><span>班序<small>月度排班管理</small></span></a><nav aria-label="管理系统菜单"><template v-for="item in menu" :key="item.id"><p v-if="item.group" class="nav-group">{{ item.group }}</p><a :href="`#${item.id}`" class="nav-item" :class="{ active: page === item.id }" :aria-current="page === item.id ? 'page' : undefined" @click.prevent="navigate(item.id)"><Icon :name="item.icon" :size="20" /><span>{{ item.name }}</span><span v-if="page === item.id" class="active-dot"></span></a></template></nav><div class="sidebar-bottom"><div class="local-note"><span class="local-dot"></span><div><strong>本地工作空间</strong><small>数据仅保存在此浏览器</small></div><Icon name="database" :size="18" /></div><button class="user-menu" @click="logout"><span class="avatar">管</span><span><strong>管理员</strong><small>admin</small></span><Icon name="logout" :size="18" /></button></div></aside>
    <div class="app-main"><header class="topbar"><div class="topbar-title"><button class="icon-button mobile-menu" aria-label="打开管理菜单" @click="sidebarOpen = !sidebarOpen"><Icon name="menu" /></button><span class="muted">工作空间</span><Icon name="right" :size="14" /><strong>{{ menu.find(x => x.id === page)?.name }}</strong></div><div class="topbar-right"><span class="save-indicator"><span :class="saving ? 'saving-dot' : 'local-dot'"></span>{{ saving ? '正在保存…' : '已保存在本地' }}</span><span class="topbar-date"><Icon name="calendar" :size="16" />{{ prettyMonth(month) }}</span><button class="avatar small" aria-label="退出登录" title="退出登录" @click="logout">管</button></div></header>
      <main class="page-content"><div v-if="db.demo" class="demo-banner"><span><span class="pill tiny">演示数据</span>当前展示18名虚拟员工的示例，所有功能均可操作。</span><button class="text-button" @click="settingsSection = '数据与备份'; navigate('settings')">切换为空白工作区<Icon name="right" :size="14" /></button></div><component :is="currentPage" /></main><footer class="app-footer">班序 · 安排有序，调整有据。<span>本地数据建议定期备份</span></footer>
    </div>
  </div>
  <Transition name="toast"><div v-if="toast" class="toast-message" :class="toast.type" role="status"><Icon :name="toast.type === 'success' ? 'check' : 'warning'" :size="19" />{{ toast.text }}<button class="icon-button" aria-label="关闭提示" @click="toast = undefined"><Icon name="close" :size="16" /></button></div></Transition>
</template>
