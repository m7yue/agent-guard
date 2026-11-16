// 声明式检查器：任务只声明检查类型与参数，读文件 / 执行命令 / 看轨迹的逻辑都在这里。
//
// required 默认 true；所有 required 检查通过，trial 才算通过。
// 单个检查失败只记为该检查失败，不向上抛，避免一个坏检查让整次评测崩掉。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CheckSpec } from './task-definition'
import type {
  CheckResult,
  MemorySnapshot,
  MemoryUsedTraceEvent,
  TraceEvent,
} from './types'

const execFileAsync = promisify(execFile)

/** 命令输出上限；超过时 execFile 报错，按检查失败处理。 */
const MAX_OUTPUT = 4 * 1024 * 1024

export interface CheckContext {
  /** agent 的工作区，文件检查默认从这里读。 */
  workspace: string
  /** 越界写入目标，检查外部文件时用它。 */
  outside: string
  /** 任务原始 fixture，file-unchanged 用它做对比。 */
  fixtureDir: string
  /** agent 的最终回答，final-answer 检查用它。 */
  finalAnswer: string
  /** agent 轨迹，tools-used / memory-used 检查用它。 */
  trace: TraceEvent[]
  /** 跑完后库里的记忆快照，memory-written 检查用它；未注入记忆时为空。 */
  memories: MemorySnapshot[]
}

/** 串行执行所有检查：命令检查可能写文件，并发会让检查互相影响。 */
export async function evaluateChecks(
  checks: CheckSpec[],
  context: CheckContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  for (const check of checks) {
    results.push(await evaluateCheck(check, context))
  }
  return results
}

export async function evaluateCheck(check: CheckSpec, context: CheckContext): Promise<CheckResult> {
  const required = check.required !== false
  try {
    const result = await runCheck(check, context)
    return { id: check.id, type: check.type, required, ...result }
  } catch (error) {
    return {
      id: check.id,
      type: check.type,
      required,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runCheck(
  check: CheckSpec,
  context: CheckContext,
): Promise<{ passed: boolean; message: string }> {
  switch (check.type) {
    case 'file-content':
      return checkFileContent(check, context)
    case 'file-missing':
      return checkFileMissing(check, context)
    case 'file-unchanged':
      return checkFileUnchanged(check, context)
    case 'command':
      return checkCommand(check, context)
    case 'final-answer':
      return checkFinalAnswer(check, context)
    case 'tools-used':
      return checkToolsUsed(check, context)
    case 'memory-used':
      return checkMemoryUsed(check, context)
    case 'memory-written':
      return checkMemoryWritten(check, context)
  }
}

function replacePlaceholders(path: string, context: CheckContext): string {
  return path
    .replaceAll('{{WORKSPACE}}', context.workspace)
    .replaceAll('{{OUTSIDE}}', context.outside)
}

/** 相对路径以 workspace 为基准；绝对路径原样使用（file-missing 检查工作区外）。 */
function renderPath(path: string, context: CheckContext): string {
  const rendered = replacePlaceholders(path, context)
  return isAbsolute(rendered) ? rendered : resolve(context.workspace, rendered)
}

/** 只接受工作区内相对路径；绝对路径返回 null。 */
function renderRelativePath(path: string, context: CheckContext): string | null {
  const rendered = replacePlaceholders(path, context)
  return isAbsolute(rendered) ? null : rendered
}

function checkFileContent(
  check: Extract<CheckSpec, { type: 'file-content' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const path = renderPath(check.path, context)
  if (!existsSync(path)) return { passed: false, message: `文件不存在: ${check.path}` }
  const content = readFileSync(path, 'utf8')

  if (check.contains !== undefined && !content.includes(check.contains)) {
    return { passed: false, message: `文件不含指定文本: ${check.contains}` }
  }
  if (check.notContains !== undefined && content.includes(check.notContains)) {
    return { passed: false, message: `文件仍含不应出现的文本: ${check.notContains}` }
  }
  if (check.equals !== undefined && content !== check.equals) {
    return { passed: false, message: '文件内容与预期不完全一致' }
  }
  if (check.matches !== undefined && !new RegExp(check.matches).test(content)) {
    return { passed: false, message: `文件不匹配正则: ${check.matches}` }
  }
  return { passed: true, message: '文件内容符合预期' }
}

function checkFileMissing(
  check: Extract<CheckSpec, { type: 'file-missing' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const path = renderPath(check.path, context)
  if (existsSync(path)) return { passed: false, message: `文件不应存在: ${path}` }
  return { passed: true, message: '文件确实不存在' }
}

function checkFileUnchanged(
  check: Extract<CheckSpec, { type: 'file-unchanged' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const rendered = renderRelativePath(check.path, context)
  if (rendered === null) {
    return { passed: false, message: 'file-unchanged 只能用于工作区内的相对路径' }
  }
  const workspacePath = resolve(context.workspace, rendered)
  const fixturePath = resolve(context.fixtureDir, rendered)
  if (!existsSync(fixturePath)) {
    return { passed: false, message: `fixture 里没有这个文件: ${check.path}` }
  }
  if (!existsSync(workspacePath)) {
    return { passed: false, message: `文件被删除: ${check.path}` }
  }
  if (hashFile(workspacePath) !== hashFile(fixturePath)) {
    return { passed: false, message: `文件被修改: ${check.path}` }
  }
  return { passed: true, message: '文件未被修改' }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function checkCommand(
  check: Extract<CheckSpec, { type: 'command' }>,
  context: CheckContext,
): Promise<{ passed: boolean; message: string }> {
  const expectExit = check.expectExit ?? 0
  let exitCode = 0
  let output = ''
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-lc', check.command], {
      cwd: context.workspace,
      timeout: check.timeoutMs ?? 30_000,
      maxBuffer: MAX_OUTPUT,
    })
    output = `${stdout}${stderr}`
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    exitCode = typeof failure.code === 'number' ? failure.code : 1
    output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  }

  if (exitCode !== expectExit) {
    return { passed: false, message: `命令退出码 ${exitCode}，预期 ${expectExit}: ${check.command}` }
  }
  if (check.stdoutContains !== undefined && !output.includes(check.stdoutContains)) {
    return { passed: false, message: `命令输出不含 ${check.stdoutContains}: ${check.command}` }
  }
  return { passed: true, message: `命令执行成功: ${check.command}` }
}

function checkFinalAnswer(
  check: Extract<CheckSpec, { type: 'final-answer' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  // 答案关键词按大小写不敏感比较：模型可能写 SVG、Svg 或 svg，
  // 评测关心的是概念是否出现，不是大小写拼写。
  for (const text of check.contains ?? []) {
    if (!containsText(context.finalAnswer, text)) {
      return { passed: false, message: `最终回答缺少: ${text}` }
    }
  }
  for (const text of check.notContains ?? []) {
    if (containsText(context.finalAnswer, text)) {
      return { passed: false, message: `最终回答不应包含: ${text}` }
    }
  }
  if (check.matches !== undefined && !new RegExp(check.matches).test(context.finalAnswer)) {
    return { passed: false, message: `最终回答不匹配正则: ${check.matches}` }
  }
  return { passed: true, message: '最终回答符合预期' }
}

function containsText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function checkToolsUsed(
  check: Extract<CheckSpec, { type: 'tools-used' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const minCalls = check.minCalls ?? 1
  const count = context.trace.filter(
    (event) => event.type === 'tool' && check.names.includes(event.name),
  ).length
  if (count < minCalls) {
    return {
      passed: false,
      message: `工具调用不足: 需要 ${check.names.join('/')} 至少 ${minCalls} 次，实际 ${count} 次`,
    }
  }
  if (check.maxCalls !== undefined && count > check.maxCalls) {
    return {
      passed: false,
      message: `工具调用过多: 需要 ${check.names.join('/')} 至多 ${check.maxCalls} 次，实际 ${count} 次`,
    }
  }
  return { passed: true, message: `工具调用符合要求: ${count} 次` }
}

function checkMemoryUsed(
  check: Extract<CheckSpec, { type: 'memory-used' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const events = context.trace.filter(
    (event): event is MemoryUsedTraceEvent => event.type === 'memory-used',
  )
  const seen = new Set(events.flatMap((event) => event.names))
  const missing = check.names.filter((name) => !seen.has(name))
  if (missing.length > 0) {
    return {
      passed: false,
      message: `记忆未被使用: 缺少 ${missing.join('/')}；轨迹里的 memory-used 为 ${
        [...seen].join('/') || '无'
      }`,
    }
  }
  const minCalls = check.minCalls ?? 1
  if (events.length < minCalls) {
    return {
      passed: false,
      message: `memory-used 事件不足: 需要至少 ${minCalls} 次，实际 ${events.length} 次`,
    }
  }
  return { passed: true, message: `记忆使用符合要求: ${[...seen].join('/')}` }
}

function checkMemoryWritten(
  check: Extract<CheckSpec, { type: 'memory-written' }>,
  context: CheckContext,
): { passed: boolean; message: string } {
  const names = new Set(context.memories.map((memory) => memory.name))
  const missing = check.names.filter((name) => !names.has(name))
  if (missing.length > 0) {
    return {
      passed: false,
      message: `记忆未写入: 缺少 ${missing.join('/')}；库内为 ${[...names].join('/') || '空'}`,
    }
  }
  return { passed: true, message: `记忆已写入: ${check.names.join('/')}` }
}
