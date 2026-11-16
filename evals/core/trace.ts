// 轨迹文件读写：一行一个 JSON 事件。
//
// 子进程边跑边追加，父进程超时杀掉子进程时，已写出的行仍然可用；
// 因此读取时跳过写了一半的行，而不是让整份轨迹解析失败。
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { TraceEvent } from './types'

export function appendTraceEvent(filePath: string, event: TraceEvent): void {
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8')
}

export function readTraceEvents(filePath: string): TraceEvent[] {
  if (!existsSync(filePath)) return []
  const events: TraceEvent[] = []
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line) as TraceEvent)
    } catch {
      // 进程被硬杀时最后一行可能只写了一半；前面的完整事件仍然有效
    }
  }
  return events
}
