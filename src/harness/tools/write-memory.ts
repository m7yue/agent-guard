// write_memory：写入/更新一条跨会话记忆。
//
// 工具只负责校验与拼装；落库、索引、审计都在 MemoryRuntime 里。
import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import {
  MEMORY_TYPES,
  MemoryBody,
  MemoryDescription,
  MemoryName,
} from '../../shared/memory'
import type { ToolDefinition } from '../core/types'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'write_memory' as const
const effectType = 'WriteMemory' as const

export interface WriteMemoryEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    name: MemoryName,
    description: MemoryDescription,
    type: z.enum(MEMORY_TYPES),
    body: MemoryBody,
  })
  .strict()

const definition: ToolDefinition = {
  name,
  description:
    '保存一条跨会话记忆。只在用户明确要求记住，或陈述长期偏好、身份事实、项目约定时调用；不要记录一次性的任务细节、工具输出或文件内容。name 用 kebab-case（如 user-name）；type 四选一：user（用户身份/偏好）、feedback（工作方式指导）、project（项目事实）、reference（外部指针）；description 写一行摘要；body 写具体内容。同名写入会更新已有记忆，写入需要用户批准。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const writeMemoryTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<WriteMemoryEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)
      const result = await ctx.memory.remember(args)
      return JSON.stringify({
        saved: true,
        name: result.document.name,
        type: result.document.type,
        action: result.action,
      })
    }),
} as const
