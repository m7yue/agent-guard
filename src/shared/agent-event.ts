// Agent 运行事件（主进程 → 渲染进程推送）的形状。
// 单独放一个文件，是为了让 preload、main、executor 都能只引类型，不把整个 agent-loop 打进包里。
import { z } from 'zod'

// channel 常量的唯一定义在 channels.ts（那里零依赖，preload 可以直接引）
import { PUSH_CHANNELS } from './channels'
export const AGENT_EVENT_CHANNEL = PUSH_CHANNELS.agentEvent

const AgentEventSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('token'), runId: z.string().min(1), text: z.string() })
    .strict(),
  z
    .object({
      type: z.literal('tool-call'),
      runId: z.string().min(1),
      name: z.string().min(1),
      input: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-result'),
      runId: z.string().min(1),
      name: z.string().min(1),
      result: z.string(),
      isError: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool-denied'),
      runId: z.string().min(1),
      name: z.string().min(1),
      stage: z.enum(['permission', 'approval', 'unknown']),
      reason: z.string(),
    })
    .strict(),
  z
    .object({ type: z.literal('done'), runId: z.string().min(1), text: z.string() })
    .strict(),
  z
    .object({ type: z.literal('log'), runId: z.string().min(1), message: z.string() })
    .strict(),
  z.object({ type: z.literal('cancelled'), runId: z.string().min(1) }).strict(),
  z
    .object({ type: z.literal('error'), runId: z.string().min(1), message: z.string() })
    .strict(),
])

export type AgentEvent = z.infer<typeof AgentEventSchema>

export const AgentEventEnvelopeSchema = z
  .object({ runId: z.string().min(1), event: AgentEventSchema })
  .strict()
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>
