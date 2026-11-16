// 崩溃报告：把"出错那一刻能拿到的全部信息"写成一个 JSON 文件。
//
// 内容：版本、平台、错误栈、当天日志的最后若干行。
// 目的：用户把 crash-*.json 发回来，就能定位到"哪个版本、什么平台、崩在哪一步"。
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { currentLogFile } from './logger'

export interface CrashReportInput {
  /** 错误对象或任意抛出值 */
  error: unknown
  /** 采集时已知的上下文（窗口状态、当前会话等） */
  context?: Record<string, unknown>
  /** 报告写到哪个目录（通常是 logs 目录） */
  dir: string
  /** 附带最近多少行日志 */
  tailLines?: number
}

export interface CrashReport {
  /** 报告生成时间（ISO 8601） */
  timestamp: string
  app: { electron: string; node: string; chrome: string; platform: string; arch: string }
  error: { name: string; message: string; stack: string | null }
  context: Record<string, unknown>
  recentLogs: string[]
}

/** 读当天日志的最后 N 行（文件不存在或读失败时返回空数组） */
function readRecentLogs(lines: number): string[] {
  const file = currentLogFile()
  if (!file) return []

  try {
    const all = readFileSync(file, 'utf8').trimEnd().split('\n')
    return all.slice(-lines)
  } catch {
    return []
  }
}

/**
 * 写一份崩溃报告，返回文件路径。
 * 文件名带时间戳，不会覆盖历史崩溃；写失败时返回 null（崩溃处理本身不能再崩）。
 */
export function writeCrashReport(input: CrashReportInput): string | null {
  const error = input.error
  const normalized =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack ?? null }
      : { name: 'NonError', message: String(error), stack: null }

  const report: CrashReport = {
    timestamp: new Date().toISOString(),
    app: {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
    },
    error: normalized,
    context: input.context ?? {},
    recentLogs: readRecentLogs(input.tailLines ?? 50),
  }

  const file = path.join(input.dir, `crash-${Date.now()}.json`)

  try {
    writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
    return file
  } catch {
    return null
  }
}
