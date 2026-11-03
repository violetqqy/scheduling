import { addMonths, monthNow } from './dates'
import { emptyDatabase, inputHash } from './model'
import { generate } from './scheduler'

export function createDemo(month = monthNow()) {
  const db = emptyDatabase(), previous = addMonths(month, -1)
  const names = ['周予安', '林知夏', '陈明远', '许清和', '沈嘉宁', '陆景行', '江晚晴', '程亦舟', '苏念初', '顾承泽', '叶书瑶', '宋以宁', '温嘉言', '何思齐', '徐星澜', '唐若溪', '赵云帆', '韩沐阳']
  db.employees = names.map((name, i) => ({ id: `demo-${i + 1}`, code: `E${String(i + 1).padStart(3, '0')}`, name, order: i, from: `${previous}-01`, to: '', note: '演示员工，可编辑或在设置中切换为空白数据' }))
  const history = generate(db, previous, 'rebuild', 2).version
  history.demo = true; history.status = 'imported'; history.name = '上月演示记录'
  db.versions.push(history); db.activeVersions[previous] = history.id
  const result = generate(db, month, 'rebuild', 3)
  result.version.demo = true; result.version.name = '本月演示草稿'
  db.versions.push(result.version); db.activeVersions[month] = result.version.id; db.debts.push(...result.debts)
  result.version.inputHash = inputHash(db,month)
  history.inputHash = inputHash(db,previous)
  db.demo = true
  return db
}
