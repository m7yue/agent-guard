import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'search_conversations' as const
const effectType = 'SearchConversations' as const

export interface SearchConversationsEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    query: z.string().min(1).max(500),
    topK: z.number().int().min(1).max(10).optional(),
  })
  .strict()

const definition: ToolDefinition = {
  name,
  description:
    '按语义检索历史会话。凡"历史里可能有"的信息都用它找依据：之前讨论过的内容、用户的姓名/称呼/偏好、之前做过的决定（如"上次说的方案是什么""我叫什么""你还记得我吗"）。查不到再说没有，不要凭印象回答；引用时用 会话标题#块序号 标注来源。topK 通常不用传（默认 5 条足够）；只有确认返回被截断、相关信息可能在更后面时才调大。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const searchConversationsTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<SearchConversationsEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)
      const topK = args.topK ?? 5
      const outcome = await ctx.searchConversationHistory(args.query, topK)

      return JSON.stringify({
        query: args.query,
        topK,
        mode: outcome.mode,
        hits: outcome.hits.map((hit) => ({
          source: `${hit.title}#${hit.chunkIndex}`,
          conversationId: hit.conversationId,
          score: hit.score,
          text: hit.text,
        })),
      })
    }),
} as const
