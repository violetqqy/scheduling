export const pad = (n: number) => String(n).padStart(2, '0')
export function iso(date: Date) { return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` }
export function parse(date: string) { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d || 1, 12) }
export const today = () => iso(new Date())
export const monthNow = () => today().slice(0, 7)
export function addDays(date: string, n: number) { const d = parse(date); d.setDate(d.getDate() + n); return iso(d) }
export function addMonths(month: string, n: number) { const d = parse(`${month}-01`); d.setMonth(d.getMonth() + n); return iso(d).slice(0, 7) }
export function daysInMonth(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return []
  const next = `${addMonths(month, 1)}-01`; const days: string[] = []
  for (let date = `${month}-01`; date < next; date = addDays(date, 1)) days.push(date)
  return days
}
export function dateRange(from: string, to: string) {
  const dates: string[] = []
  for (let d = from; d <= to && dates.length < 740; d = addDays(d, 1)) dates.push(d)
  return dates
}
export function isWeekend(date: string) { return [0, 6].includes(parse(date).getDay()) }
export function weekday(date: string) { return ['日', '一', '二', '三', '四', '五', '六'][parse(date).getDay()] }
export function prettyMonth(month: string) { return `${month.slice(0, 4)}年${Number(month.slice(5))}月` }
export function validDate(date: string) { return /^\d{4}-\d{2}-\d{2}$/.test(date) && iso(parse(date)) === date }
export const uid = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
