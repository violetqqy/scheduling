import { generate } from '../domain/scheduler'
import type { Database } from '../domain/types'
self.onmessage = (event: MessageEvent<{ db: Database; month: string; mode: 'fill' | 'rebuild' }>) => {
  try { self.postMessage({ result: generate(event.data.db, event.data.month, event.data.mode) }) }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : '生成失败，请检查数据后重试' }) }
}
