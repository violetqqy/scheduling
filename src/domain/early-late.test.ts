import { describe, expect, it } from 'vitest'
import { completedSegments, emptyDatabase, key, newVersion, workSegments } from './model'
import { generate } from './scheduler'
import { validate, coverage } from './validation'
import { saveVacationPlan, adjustCell } from './absences'
import { earlyLateCapacity, stepsToEarlyLate } from './monthly-goals'

function fixture(count=18){const db=emptyDatabase();db.employees=Array.from({length:count},(_,i)=>({id:`e${i}`,code:`E${i}`,name:`员工${i}`,order:i,from:'2026-01-01',to:'',note:''}));return db}
describe('完整早晚段优先',()=>{
 it.each([[16,'2026-11'],[18,'2026-06'],[18,'2026-07']] as const)('%i人%s先满足名单靠前员工的完整早晚段',(count,month)=>{
  const db=fixture(count),v=generate(db,month,'rebuild',12).version
  const goalCount=month==='2026-07'?18:16
  for(const e of db.employees.slice(0,goalCount)){
   const done=completedSegments(db,v,e).filter(s=>s.start.startsWith(month))
   expect(done.some(s=>s.category==='早'),e.id+'早').toBe(true)
   expect(done.some(s=>s.category==='晚'),e.id+'晚').toBe(true)
  }
  expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
  expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
 })

 it('调休形成4天和6天段，仍保证完整早晚各一段，休假不切段',()=>{
  const db=fixture(18);db.calendar['2026-11-06']=false;db.calendar['2026-11-14']=true
  saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['2026-11-03'],reason:''})
  const v=generate(db,'2026-11').version,e=db.employees[0]!,segments=workSegments(db,v,e)
  expect(segments.map(s=>s.dates.length)).toEqual(expect.arrayContaining([4,6]))
  expect(v.cells[key(e.id,'2026-11-03')]?.kind).toBe('vacation')
  const done=completedSegments(db,v,e)
  expect(done.some(s=>s.category==='早')).toBe(true);expect(done.some(s=>s.category==='晚')).toBe(true)
  expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
 })

 it('整段休假不会把早晚目标挤掉，优先利用剩余完整工作段',()=>{
  const db=fixture();saveVacationPlan(db,{employeeId:'e0',month:'2026-11',dates:['02','03','04','05','06'].map(d=>`2026-11-${d}`),reason:''})
  const v=generate(db,'2026-11').version,done=completedSegments(db,v,db.employees[0]!)
  expect(done.some(s=>s.category==='早')).toBe(true);expect(done.some(s=>s.category==='晚')).toBe(true)
  expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
 })

 it('名单顺序决定容量不足时先满足谁，非名单数组顺序',()=>{
  const db=fixture();db.employees[17]!.order=-1
  const v=generate(db,'2026-06').version
  for(const employee of [...db.employees].sort((a,b)=>a.order-b.order).slice(0,16)){
   const done=completedSegments(db,v,employee)
   expect(done.some(s=>s.category==='早'),employee.id).toBe(true)
   expect(done.some(s=>s.category==='晚'),employee.id).toBe(true)
  }
  expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
 })

 it('人工锁定无法调整时保留并报告缺失，不把一天算作完整一周',()=>{
  const db=fixture(),v=newVersion(db,'2026-11');db.versions.push(v);db.activeVersions[v.month]=v.id
  for(const s of workSegments(db,v,db.employees[0]!))for(const date of s.dates.filter(d=>d.startsWith(v.month)))adjustCell(db,'e0',date,{kind:'shift',shiftId:'blue-day',source:'manual',locked:true})
  const result=generate(db,v.month)
  expect(Object.entries(result.version.cells).filter(([k,c])=>k.startsWith('e0|') && c.kind==='shift').every(([,c])=>c.shiftId==='blue-day' && c.locked)).toBe(true)
  expect(result.issues.find(i=>i.rule==='P06' && i.employeeId==='e0')?.message).toContain('早0段、晚0段')
 })

 it('容量和轮转路径按完整工作段计算，不按天数凑一周',()=>{
  const db=fixture(),v=newVersion(db,'2026-06')
  expect(earlyLateCapacity(db,v,db.employees[0]!)).toBe(16)
  expect(stepsToEarlyLate('早',new Set())).toBe(3)
  expect(stepsToEarlyLate('中',new Set(['早']))).toBe(2)
  expect(stepsToEarlyLate('晚',new Set(['早']))).toBe(1)
  expect(stepsToEarlyLate('早',new Set(['早','晚']))).toBe(0)
  v.cells[key('e0','2026-06-01')]={kind:'shift',shiftId:'red-early',source:'manual',locked:true}
  expect(completedSegments(db,v,db.employees[0]!).some(s=>s.category==='早')).toBe(false)
 })

 it('有真实生成的上月参考时，接续轮转并优先满足本月完整早晚段',()=>{
  const db=fixture(16),previous=generate(db,'2026-10').version
  db.versions.push(previous);db.activeVersions[previous.month]=previous.id
  const v=generate(db,'2026-11').version
  for(const e of db.employees){const done=completedSegments(db,v,e).filter(s=>s.start.startsWith(v.month));expect(done.some(s=>s.category==='早'),e.id+'早').toBe(true);expect(done.some(s=>s.category==='晚'),e.id+'晚').toBe(true)}
  expect(validate(db,v).filter(i=>i.level==='error')).toEqual([])
 })

 it('大量中光子白班待排任务不能覆盖完整早晚段的首要目标',()=>{
  const db=fixture(16)
  db.debts=db.employees.flatMap(e=>(['中','光子','白'] as const).map(category=>({id:`debt-${e.id}-${category}`,employeeId:e.id,category,origin:'2026-10',due:'2026-11',note:'上月因休假未完成的已登记目标'})))
  const v=generate(db,'2026-11').version
  for(const e of db.employees){const done=completedSegments(db,v,e).filter(s=>s.start.startsWith(v.month));expect(done.some(s=>s.category==='早'),e.id+'早').toBe(true);expect(done.some(s=>s.category==='晚'),e.id+'晚').toBe(true)}
  expect(coverage(db,v).every(r=>r.actual===r.expected)).toBe(true)
  expect(db.debts).toHaveLength(48)
 })
})
