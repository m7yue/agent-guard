// 任务加载：把 tasks/index.ts 里的定义补成可执行任务（prompt 正文 + fixture 路径）。
//
// 校验分两层：task-definition 的 zod 管字段；这里管"目录名、id、prompt.md、fixture/"是否对得上。
//
// 这里用同步 fs：任务量小（当前 7 个，prompt 合计不到 1KB），读取发生在 CLI / 子进程启动期，
// 不在模型或工具的热路径上；本地实测 loadTasks() 约 0.2ms/次（7 个任务，200 次平均）。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EVALS_ROOT } from './paths'
import { TASKS } from '../tasks/index'
import { validateTaskDefinition } from './task-definition'
import type { LoadedTask } from './types'

const TASKS_ROOT = join(EVALS_ROOT, 'tasks')

export function loadTask(id: string): LoadedTask {
  const definition = TASKS[id]
  if (!definition) {
    throw new Error(`未知任务: ${id}（可选: ${Object.keys(TASKS).join(', ')}）`)
  }

  const task = validateTaskDefinition(definition, id)
  const taskDir = join(TASKS_ROOT, id)
  const promptPath = join(taskDir, 'prompt.md')
  if (!existsSync(promptPath)) {
    throw new Error(`任务 ${id} 缺少 prompt.md: ${promptPath}`)
  }

  const fixtureDir = join(taskDir, 'fixture')
  if (!existsSync(fixtureDir) || !statSync(fixtureDir).isDirectory()) {
    throw new Error(`任务 ${id} 缺少 fixture 目录: ${fixtureDir}`)
  }

  return {
    ...task,
    promptTemplate: readFileSync(promptPath, 'utf8'),
    fixtureDir,
  }
}

/** 加载全部任务，或只加载指定 id；顺序与 TASKS 登记顺序一致。 */
export function loadTasks(ids?: string[]): LoadedTask[] {
  const selected = ids ?? Object.keys(TASKS)
  return selected.map((id) => loadTask(id))
}
