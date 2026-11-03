import type { Database } from '../domain/types'
import { validDate } from '../domain/dates'

let revision: string | undefined
const databaseName = 'banxu-local-v2'
function connect(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('state')
    request.onerror = () => reject(new Error('无法打开本地数据库，请允许浏览器存储或切换到普通窗口。'))
    request.onsuccess = () => resolve(request.result)
  })
}
export function assertDatabase(value: unknown): asserts value is Database {
  if (!value || typeof value !== 'object') throw new Error('备份内容不是有效对象')
  const db = value as Database
  if (db.schema !== 2 || !Array.isArray(db.vacationPlans) || !Array.isArray(db.employees) || !Array.isArray(db.rooms) || !Array.isArray(db.shifts) || !Array.isArray(db.versions) || !Array.isArray(db.debts) || !Array.isArray(db.logs)) throw new Error('不支持的备份格式或版本')
  if (!db.calendar || !db.demand || !db.activeVersions || !db.rules || !['conflict', 'continue'].includes(db.rules.photonCarry) || typeof db.rules.leaveSplits !== 'boolean') throw new Error('备份缺少有效日历或规则')
  if (db.employees.length > 1000 || db.versions.length > 500) throw new Error('备份超出本地应用支持的范围')
  const ids = new Set<string>(), codes = new Set<string>()
  for (const e of db.employees) {
    if (!e || typeof e.id !== 'string' || !/^[\w-]+$/.test(e.id) || ids.has(e.id) || typeof e.name !== 'string' || !e.name.trim() || typeof e.code !== 'string' || !e.code || codes.has(e.code) || !Number.isFinite(e.order)) throw new Error('员工编号、顺序或姓名无效')
    if (e.from && !validDate(e.from) || e.to && !validDate(e.to) || e.from && e.to && e.to <= e.from) throw new Error('员工生效日期无效')
    ids.add(e.id); codes.add(e.code)
  }
  function checkPlans(plans: Database['vacationPlans'], month?: string) {
    if (!Array.isArray(plans)) throw new Error('缺少有效休假计划快照')
    const planIds = new Set<string>(), plannedDates = new Set<string>()
    for (const p of plans) {
      if (!p || typeof p.id !== 'string' || planIds.has(p.id) || !ids.has(p.employeeId) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.month) || month && p.month !== month || !Array.isArray(p.dates) || !p.dates.length || typeof p.reason !== 'string' || !['manual','import'].includes(p.source)) throw new Error('休假计划结构无效')
      planIds.add(p.id)
      for (const date of p.dates) {
        const k = `${p.employeeId}|${date}`
        if (typeof date !== 'string' || !validDate(date) || date.slice(0,7) !== p.month || plannedDates.has(k)) throw new Error('休假计划包含无效或重复日期')
        plannedDates.add(k)
      }
    }
  }
  checkPlans(db.vacationPlans)
  const roomIds = new Set(db.rooms.map(r => r.id)), shiftIds = new Set(db.shifts.map(s => s.id))
  if (roomIds.size !== db.rooms.length || shiftIds.size !== db.shifts.length || db.shifts.length !== 8) throw new Error('房间或八班次配置无效')
  for (const r of db.rooms) if (typeof r.name !== 'string' || !/^#[0-9a-f]{6}$/i.test(r.color) || !/^#[0-9a-f]{6}$/i.test(r.ink)) throw new Error('房间颜色配置无效')
  for (const s of db.shifts) if (!roomIds.has(s.roomId) || !['早', '中', '晚', '白', '光子'].includes(s.category) || typeof s.enabled !== 'boolean') throw new Error('班次配置无效')
  const versionIds = new Set<string>()
  for (const v of db.versions) {
    if (!v || typeof v.id !== 'string' || versionIds.has(v.id) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v.month) || !v.cells || !v.calendar || !v.requirements || !Array.isArray(v.employeeIds) || !v.ruleSettings || !['draft', 'confirmed', 'imported'].includes(v.status)) throw new Error('排班版本结构无效')
    if (v.historyMode && !['initial','reference'].includes(v.historyMode)) throw new Error('版本历史参考模式无效')
    checkPlans(v.vacationPlans,v.month)
    versionIds.add(v.id)
    for (const [k, c] of Object.entries(v.cells)) {
      const [employeeId, date] = k.split('|')
      if (!ids.has(employeeId!) || !date || !validDate(date) || !date.startsWith(v.month) || !c || !['shift', 'rest', 'vacation', 'leave', 'unassigned'].includes(c.kind) || c.kind === 'shift' && !shiftIds.has(c.shiftId!)) throw new Error('排班明细包含未知员工、日期或班次')
    }
    if (v.employeeIds.some(id => !ids.has(id)) || new Set(v.employeeIds).size !== v.employeeIds.length) throw new Error('版本员工名单无效')
  }
  for (const [month, id] of Object.entries(db.activeVersions)) if (!db.versions.some(v => v.id === id && v.month === month)) throw new Error('当前版本引用不存在')
  for (const d of db.debts) if (!ids.has(d.employeeId) || !['早', '中', '晚', '白', '光子'].includes(d.category) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.due)) throw new Error('递延记录无效')
}
export function parseDatabase(value: unknown): Database {
  assertDatabase(value)
  return structuredClone(value)
}
export async function loadDatabase(): Promise<Database | undefined> {
  const connection = await connect()
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction('state', 'readonly'), request = transaction.objectStore('state').get('database')
    let data: Database | undefined
    request.onsuccess = () => {
      try {
        if (request.result) { data = parseDatabase(request.result.data); revision = request.result.revision }
      } catch (error) { transaction.abort(); reject(error) }
    }
    transaction.oncomplete = () => { connection.close(); resolve(data) }
    transaction.onerror = () => { connection.close(); reject(new Error('本地数据读取失败，原数据未被覆盖。')) }
  })
}
export async function saveDatabase(db: Database) {
  assertDatabase(db)
  const connection = await connect(), nextRevision = crypto.randomUUID()
  return new Promise<void>((resolve, reject) => {
    const tx = connection.transaction('state', 'readwrite'), store = tx.objectStore('state'), read = store.get('database')
    let conflict = false
    read.onsuccess = () => {
      if (read.result?.revision !== revision) { conflict = true; tx.abort(); return }
      store.put({ data: db, revision: nextRevision }, 'database')
    }
    tx.oncomplete = () => { revision = nextRevision; connection.close(); resolve() }
    tx.onabort = tx.onerror = () => { connection.close(); reject(new Error(conflict ? '另一个窗口已修改数据。请刷新本页后重试，本次没有覆盖其修改。' : '保存失败，可能是本地存储空间不足。本次修改未写入，请先导出备份。')) }
  })
}
