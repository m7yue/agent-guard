// select_memory：按当前上下文重新选择相关记忆。
//
// 与每次运行开始自动选择同一条实现（LLM 优先，失败降级向量），区别只是由模型在循环里主动调用。
// 返回 name + description，不返回正文——正文由 read_memory 按需取，避免一次塞太多 token。
import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'select_memory' as const
const effectType = 'SelectMemory' as const

export interface SelectMemoryEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    context: z.string().min(1).max(2000),
    maxItems: z.number().int().min(1).max(10).optional(),
  })
  .strict()

const definition: ToolDefinition = {
  name,
  description:
    '按给定上下文从记忆目录里重新选择相关记忆，返回 name 与 description（不含正文）。当你不确定目录里哪条相关、或需要按新的问题重选时调用；拿到 name 后用 read_memory 取正文。maxItems 通常不用传（默认 5 条）。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const selectMemoryTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<SelectMemoryEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)
      const selection = await ctx.memory.select(args.context, 'tool', args.maxItems ?? 5)
      return JSON.stringify({
        mode: selection.mode,
        memories: selection.selected.map(({ document }) => ({
          name: document.name,
          type: document.type,
          description: document.description,
        })),
      })
    }),
} as const
