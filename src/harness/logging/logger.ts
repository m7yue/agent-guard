// 结构化日志：一行一条 JSON，按天分文件。
//
// 为什么要落盘：桌面应用没有服务端可查，出问题时用户只能描述"它闪退了"。
// 日志 + 崩溃报告是唯一能复盘的材料。
//
// 用法：
//   configureLogging(logDir)   // 每个进程启动时配置一次（主进程与执行器各配一次）
//   const log = getLogger('main')
//   log.info('窗口已创建', { pid: process.pid })
//
// 文件：<logDir>/app-YYYY-MM-DD.log；只保留最近若干天。
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}

let logDir: string | null = null
let keepDays = 7

/** 当天日期（本地时区），用于文件名 */
function today(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 清理超过保留天数的日志文件（按文件名里的日期判断） */
function cleanup(dir: string): void {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000

  for (const name of readdirSync(dir)) {
    const match = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name)
    if (!match) continue

    const fileTime = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00`).getTime()
    if (fileTime < cutoff) {
      try {
        unlinkSync(path.join(dir, name))
      } catch {
        // 清不掉就算了，不能因为日志清理影响主流程
      }
    }
  }
}

/** 每个进程启动时调用一次：建目录、清理过期文件 */
export function configureLogging(dir: string, options: { keepDays?: number } = {}): void {
  logDir = dir
  keepDays = options.keepDays ?? 7
  mkdirSync(dir, { recursive: true })
  cleanup(dir)
}

/** 当前日志文件路径（崩溃报告会读它取最近几行） */
export function currentLogFile(): string | null {
  return logDir ? path.join(logDir, `app-${today()}.log`) : null
}

/**
 * 取一个带 scope 的 logger。
 * 未配置目录时只打 console（单元测试、脚本里可以不用落盘）。
 */
export function getLogger(scope: string): Logger {
  const write = (level: LogLevel, message: string, meta?: unknown): void => {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...(meta === undefined ? {} : { meta }),
    })

    if (logDir) {
      try {
        // 同步追加：日志量小，换来"崩溃前最后几行一定在磁盘上"
        appendFileSync(path.join(logDir, `app-${today()}.log`), line + '\n', 'utf8')
      } catch {
        // 写日志失败不能反过来影响业务
      }
    }

    // 开发态仍然打 console，方便直接在终端看
    if (process.env.NODE_ENV !== 'production') {
      const printer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      printer(`[${scope}] ${message}`, meta ?? '')
    }
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  }
}
