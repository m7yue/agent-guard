import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeCrashReport } from '../src/harness/logging/crash-report'
import { configureLogging, currentLogFile, getLogger } from '../src/harness/logging/logger'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentguard-log-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('日志', () => {
  it('按 JSONL 写入，字段完整', () => {
    const dir = tempDir()
    configureLogging(dir)

    const log = getLogger('test')
    log.info('hello', { a: 1 })
    log.error('boom')

    const lines = readFileSync(currentLogFile() as string, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ level: 'info', scope: 'test', message: 'hello', meta: { a: 1 } })
    expect(lines[1]).toMatchObject({ level: 'error', message: 'boom' })
    expect(typeof lines[0].timestamp).toBe('string')
  })

  it('清理超过保留天数的旧日志', () => {
    const dir = tempDir()
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const name = `app-${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}.log`
    writeFileSync(path.join(dir, name), 'old')

    configureLogging(dir, { keepDays: 7 })
    expect(readdirSync(dir)).not.toContain(name)
  })
})

describe('崩溃报告', () => {
  it('记录错误、版本与最近日志', () => {
    const dir = tempDir()
    configureLogging(dir)
    getLogger('test').error('before crash')

    const file = writeCrashReport({
      error: new Error('kaboom'),
      dir,
      context: { phase: 'startup' },
    }) as string

    const report = JSON.parse(readFileSync(file, 'utf8'))
    expect(report.error).toMatchObject({ name: 'Error', message: 'kaboom' })
    expect(report.context).toEqual({ phase: 'startup' })
    expect(report.recentLogs.some((line: string) => line.includes('before crash'))).toBe(true)
    expect(report.app.platform).toBe(process.platform)
  })
})
