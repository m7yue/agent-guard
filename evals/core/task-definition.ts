// 任务定义：类型、zod schema、defineTask / validateTaskDefinition。
//
// 形状对齐参照项目 learn-claude-code-typescript/evals/task-definition.ts：
// - task.ts 用 defineTask 获得编译期字段检查；
// - loader 在加载时用 validateTaskDefinition 做运行时校验；
// - checks / mock 回合 / 审批期望都在同一份 schema 里维护。
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { MEMORY_TYPES } from '../../src/harness/store'

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, '不能为空')

const regexString = z.string().refine((value) => {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}, '不是有效的正则表达式')

/** 检查路径：允许相对路径、绝对路径和两个占位符；替换占位符后不能出现 ..。 */
const checkPath = z.string().refine((value) => {
  const rendered = value
    .replaceAll('{{WORKSPACE}}', '/workspace')
    .replaceAll('{{OUTSIDE}}', '/outside')
  return !rendered.split(/[\\/]/).includes('..')
}, '路径不能越出工作区')

/** file-unchanged 要同时定位 workspace 与 fixture，只接受工作区内相对路径。 */
const relativePath = z
  .string()
  .refine((value) => {
    if (value.includes('{{') || isAbsolute(value)) return false
    return !value.split(/[\\/]/).includes('..')
  }, 'file-unchanged 只能用于工作区内相对路径')

const checkBase = {
  /** 稳定标识，报告里用它定位失败项。 */
  id: nonEmptyString,
  /** 默认 true；false 的检查只展示，不影响 trial 通过。 */
  required: z.boolean().optional(),
}

const fileContentCheckSchema = z
  .object({
    ...checkBase,
    /** 检查类型判别字段。 */
    type: z.literal('file-content'),
    /** 相对 workspace 的路径，或 {{WORKSPACE}} / {{OUTSIDE}} 占位符。 */
    path: checkPath,
    /** 文件必须包含的文本。 */
    contains: nonEmptyString.optional(),
    /** 文件不能包含的文本。 */
    notContains: nonEmptyString.optional(),
    /** 文件必须匹配的正则表达式。 */
    matches: regexString.optional(),
    /** 文件必须完全相等的内容（包括换行和空格）。 */
    equals: z.string().optional(),
  })
  .refine(
    (check) =>
      check.contains !== undefined ||
      check.notContains !== undefined ||
      check.matches !== undefined ||
      check.equals !== undefined,
    '至少需要一个内容条件',
  )

const fileMissingCheckSchema = z.object({
  ...checkBase,
  /** 检查类型判别字段。 */
  type: z.literal('file-missing'),
  /** 相对 workspace 的路径，或 {{OUTSIDE}} 占位符。 */
  path: checkPath,
})

const fileUnchangedCheckSchema = z.object({
  ...checkBase,
  /** 检查类型判别字段。 */
  type: z.literal('file-unchanged'),
  /** 工作区内的相对路径；同时用于定位 workspace 与 fixture。 */
  path: relativePath,
})

const commandCheckSchema = z.object({
  ...checkBase,
  /** 检查类型判别字段。 */
  type: z.literal('command'),
  /** 交给 sh -lc 执行的命令。 */
  command: nonEmptyString,
  /** 期望的退出码，默认 0。 */
  expectExit: z.number().int().optional(),
  /** 命令输出里必须包含的文本。 */
  stdoutContains: z.string().optional(),
  /** 命令超时时间，单位毫秒，默认 30 秒。 */
  timeoutMs: z.number().positive().optional(),
})

const finalAnswerCheckSchema = z
  .object({
    ...checkBase,
    /** 检查类型判别字段。 */
    type: z.literal('final-answer'),
    /** 最终回答必须全部包含的文本。 */
    contains: z.array(nonEmptyString).min(1).optional(),
    /** 最终回答不能出现的文本。 */
    notContains: z.array(nonEmptyString).min(1).optional(),
    /** 最终回答必须匹配的正则表达式。 */
    matches: regexString.optional(),
  })
  .refine(
    (check) =>
      (check.contains?.length ?? 0) > 0 ||
      (check.notContains?.length ?? 0) > 0 ||
      check.matches !== undefined,
    '至少需要一个回答条件',
  )

// 比参照项目多一个 maxCalls：硬拒绝 / 审批拒绝用例需要断言"工具没有执行"。
const toolsUsedCheckSchema = z
  .object({
    ...checkBase,
    /** 检查类型判别字段。 */
    type: z.literal('tools-used'),
    /** 要统计的工具名；命中其中任意一个就计数。 */
    names: z.array(nonEmptyString).min(1, '不能为空'),
    /** 至少调用多少次，默认 1。 */
    minCalls: z.number().int().min(0).optional(),
    /** 至多调用多少次；用于断言硬拒绝 / 审批拒绝时工具没有执行。 */
    maxCalls: z.number().int().min(0).optional(),
  })
  .refine(
    (check) => check.maxCalls === undefined || check.maxCalls >= (check.minCalls ?? 1),
    'maxCalls 不能小于 minCalls',
  )

// 记忆使用：轨迹里必须出现这些名字（自动选择、read_memory、select_memory 任一来源）。
const memoryUsedCheckSchema = z.object({
  ...checkBase,
  /** 检查类型判别字段。 */
  type: z.literal('memory-used'),
  /** 期望被使用的记忆名；全部出现才算通过。 */
  names: z.array(nonEmptyString).min(1, '不能为空'),
  /** 至少出现多少个 memory-used 事件，默认 1。 */
  minCalls: z.number().int().min(0).optional(),
})

// 记忆写入：跑完后库里的记忆快照必须包含这些名字。
const memoryWrittenCheckSchema = z.object({
  ...checkBase,
  /** 检查类型判别字段。 */
  type: z.literal('memory-written'),
  /** 期望已写入的记忆名；全部存在才算通过。 */
  names: z.array(nonEmptyString).min(1, '不能为空'),
})

export const checkSpecSchema = z.discriminatedUnion('type', [
  fileContentCheckSchema,
  fileMissingCheckSchema,
  fileUnchangedCheckSchema,
  commandCheckSchema,
  finalAnswerCheckSchema,
  toolsUsedCheckSchema,
  memoryUsedCheckSchema,
  memoryWrittenCheckSchema,
])

/**
 * mock 模型的一步：
 * - 有 tool：请求一次工具调用；
 * - 有 answer：给出最终回答并结束。
 */
const scriptStepSchema = z.union([
  z.object({
    /** 要调用的工具名，必须是 harness 已注册的工具。 */
    tool: nonEmptyString,
    /** 工具参数；字符串里的占位符会在运行时替换。 */
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /** 最终回答文本。 */
    answer: nonEmptyString,
  }),
])

/** 回合序列必须以 answer 结束，否则 mock 模型会一直重复最后一个工具。 */
const mockTurnsSchema = z.array(scriptStepSchema).min(1, '至少需要一步').superRefine((turns, ctx) => {
  const last = turns[turns.length - 1]
  // 空数组由 min(1) 报错；这里先判空，避免 'answer' in undefined 抛 TypeError
  if (last !== undefined && !('answer' in last)) {
    ctx.addIssue({
      code: 'custom',
      path: [turns.length - 1],
      message: '最后一步必须是 answer，否则 mock 模型会重复工具调用',
    })
  }
})

/** 评测里“用户”对 ask 的决定：放行、拒绝，或没有审批任务。 */
const approvalSchema = z.enum(['grant', 'deny', 'none'])
/** 期望轨迹里的审批形态：放行、拒绝，或根本没请求审批。 */
const expectedApprovalSchema = z.enum(['granted', 'denied', 'not-requested'])

/** 任务预置记忆：子进程在跑 agent 前写入临时库，用来评测「跨会话事实」。 */
export const memoryFixtureSchema = z.object({
  /** kebab-case 标识 */
  name: nonEmptyString,
  /** 一行摘要 */
  description: nonEmptyString,
  /** 四类语义 */
  type: z.enum(MEMORY_TYPES),
  /** 正文 */
  body: nonEmptyString,
})

export const taskDefinitionSchema = z
  .object({
    /** 必须和目录名、tasks/index.ts 里的键一致。 */
    id: nonEmptyString,
    /** 报告里显示的任务名。 */
    title: nonEmptyString,
    /** 单次 trial 的超时时间，单位毫秒。 */
    timeoutMs: z.number().positive().refine(Number.isFinite, '必须是有限数字'),
    /** agent 最多跑多少个模型回合。 */
    maxTurns: z.number().int('必须是整数').positive('必须是正数'),
    /** 答案要点：报告里的 answerKeyPointHitRate 按它算。 */
    expectKeywords: z.array(nonEmptyString).min(1, '不能为空'),
    /** 期望模型请求的工具；工具选择准确率按它算。边界任务可以留空，只约束"不该出现什么"。 */
    expectedTools: z.array(nonEmptyString),
    /** 允许出现但不计入期望的额外工具（例如模型顺手做一次历史检索）。 */
    allowedExtraTools: z.array(nonEmptyString).default([]),
    /** 回答里应出现的来源（标题#块序号）；只有需要引用来源的任务才填。 */
    expectedSources: z.array(nonEmptyString).min(1).optional(),
    /** 评测里"用户"对 ask 的决定；没有审批的任务保持默认 deny。 */
    approval: approvalSchema.default('deny'),
    /** 期望轨迹里的审批形态：放行、拒绝、或根本没请求审批（allow / deny 直接短路）。 */
    expectedApproval: expectedApprovalSchema.default('not-requested'),
    /** 只有 search_conversations 任务需要在子进程里索引语料。 */
    shouldIndexRetrievalCorpus: z.boolean().default(false),
    /** 任务预置记忆；子进程在跑 agent 前写入临时库。 */
    memories: z.array(memoryFixtureSchema).optional(),
    /** mock 模式的选择器响应（JSON 整数数组字符串）；real 模式忽略，用真实模型选择。 */
    selectorResponse: z.string().optional(),
    /** 声明式检查；所有 required 检查通过且 run.status 为 ok，trial 才算通过。 */
    checks: z.array(checkSpecSchema).min(1, '至少需要一个检查'),
    /** mock 模型的正确回合序列；evals:check 断言它通过所有 required 检查。 */
    mockCorrectTurns: mockTurnsSchema,
    /** mock 模型的错误回合序列；evals:check 断言它至少失败一项 required 检查。 */
    mockWrongTurns: mockTurnsSchema,
  })
  .superRefine((task, ctx) => {
    const seen = new Set<string>()
    task.checks.forEach((check, index) => {
      if (seen.has(check.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checks', index, 'id'],
          message: `检查 id 重复: ${check.id}`,
        })
      }
      seen.add(check.id)
    })

    // 只拦会导致语义矛盾的组合：grant + denied 没有意义；
    // grant + not-requested 是合法的——策略可能在 ask 之前就 deny（越界写入、硬拒绝命令）。
    if (task.approval === 'grant' && task.expectedApproval === 'denied') {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedApproval'],
        message: 'approval=grant 时 expectedApproval 不能是 denied',
      })
    }
    if (task.approval === 'deny' && task.expectedApproval === 'granted') {
      ctx.addIssue({
        code: 'custom',
        path: ['expectedApproval'],
        message: 'approval=deny 时 expectedApproval 不能是 granted',
      })
    }
    if (task.expectedApproval === 'granted' && task.approval !== 'grant') {
      ctx.addIssue({
        code: 'custom',
        path: ['approval'],
        message: 'expectedApproval=granted 时 approval 必须是 grant',
      })
    }
  })

export type TaskDefinition = z.infer<typeof taskDefinitionSchema>
export type CheckSpec = z.infer<typeof checkSpecSchema>
export type ScriptStep = z.infer<typeof scriptStepSchema>
export type FileContentCheck = z.infer<typeof fileContentCheckSchema>
export type FileMissingCheck = z.infer<typeof fileMissingCheckSchema>
export type FileUnchangedCheck = z.infer<typeof fileUnchangedCheckSchema>
export type CommandCheck = z.infer<typeof commandCheckSchema>
export type FinalAnswerCheck = z.infer<typeof finalAnswerCheckSchema>
export type ToolsUsedCheck = z.infer<typeof toolsUsedCheckSchema>
export type MemoryUsedCheck = z.infer<typeof memoryUsedCheckSchema>
export type MemoryWrittenCheck = z.infer<typeof memoryWrittenCheckSchema>
export type MemoryFixture = z.infer<typeof memoryFixtureSchema>

/** 任务定义入口：只提供编译期字段类型检查，运行时校验由 loader 完成。 */
export function defineTask(definition: TaskDefinition): TaskDefinition {
  return definition
}

/**
 * 校验任务定义并返回解析后的数据。
 * expectedId 用于检查 task.ts 的 id 与目录名/登记键一致。
 */
export function validateTaskDefinition(definition: unknown, expectedId?: string): TaskDefinition {
  const result = taskDefinitionSchema.safeParse(definition)
  if (!result.success) {
    throw new Error(formatIssues(expectedId ?? '未知任务', result.error))
  }
  if (expectedId !== undefined && result.data.id !== expectedId) {
    throw new Error(`${expectedId}: task.ts 的 id 与目录名不一致`)
  }
  return result.data
}

function formatIssues(taskId: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(根)'
    return `- ${path}: ${issue.message}`
  })
  return `任务 ${taskId} 定义有误:\n${lines.join('\n')}`
}
