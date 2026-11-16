// 审计事件的形状：type 决定 payload 的结构。
//
// 这是跨进程契约的一部分（执行器写、主进程读、渲染层展示），所以放 shared；
// 每个事件是一个 ADT 变体，而不是 `type: string + payload: unknown`。
import { z } from 'zod'
import { MEMORY_TYPES } from './memory'

const RunStartedPayload = z.object({ prompt: z.string() }).strict()
const ApprovalRequestedPayload = z
  .object({
    requestId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
  })
  .strict()
const ApprovalDecidedPayload = z
  .object({
    requestId: z.string().min(1),
    tool: z.string().min(1),
    decision: z.enum(['once', 'session', 'deny', 'timeout']),
  })
  .strict()
const ToolCallPayload = z.object({ name: z.string().min(1), input: z.string() }).strict()
const ToolResultPayload = z
  .object({
    name: z.string().min(1),
    result: z.string(),
    // 旧版本事件没有这个字段；缺省按成功读取（新写入仍必须显式提供）。
    isError: z.boolean().default(false),
  })
  .strict()
const ToolDeniedPayload = z
  .object({
    name: z.string().min(1),
    input: z.string(),
    stage: z.enum(['permission', 'approval', 'unknown']),
    reason: z.string(),
  })
  .strict()
const RetrievalHitPayload = z
  .object({
    conversationId: z.string().min(1),
    title: z.string(),
    chunkIndex: z.number().int().nonnegative(),
    score: z.number(),
    text: z.string(),
  })
  .strict()
/** 重排 起重排阶段的观测；旧 retrieval 事件没有这个字段 */
const RetrievalRerankPayload = z
  .object({
    model: z.string().min(1),
    candidateCount: z.number().int().positive(),
    durationMs: z.number().nonnegative(),
  })
  .strict()
const RetrievalPayload = z
  .object({
    query: z.string(),
    topK: z.number().int().positive(),
    mode: z.enum(['vector', 'lexical']),
    hits: z.array(RetrievalHitPayload),
    // 未配置重排 / 词法降级 / 候选不足 / 重排失败时缺省（hits 按余弦或词法排序）
    rerank: RetrievalRerankPayload.optional(),
  })
  .strict()
const MemoryUsedPayload = z.union([
  z.object({ reason: z.literal('read'), names: z.array(z.string().min(1)).length(1) }).strict(),
  z
    .object({
      reason: z.literal('selected'),
      names: z.array(z.string().min(1)),
      mode: z.literal('llm'),
    })
    .strict(),
  z
    .object({
      reason: z.literal('selected'),
      names: z.array(z.string().min(1)),
      mode: z.literal('vector-fallback'),
      scores: z.record(z.string(), z.number()),
    })
    .strict(),
  z
    .object({
      reason: z.literal('tool'),
      names: z.array(z.string().min(1)),
      mode: z.literal('llm'),
    })
    .strict(),
  z
    .object({
      reason: z.literal('tool'),
      names: z.array(z.string().min(1)),
      mode: z.literal('vector-fallback'),
      scores: z.record(z.string(), z.number()),
    })
    .strict(),
])
const MemoryWrittenPayload = z
  .object({
    name: z.string().min(1),
    memoryType: z.enum(MEMORY_TYPES),
    action: z.enum(['created', 'updated']),
  })
  .strict()
const MemoryDeletedPayload = z
  .object({ name: z.string().min(1), memoryType: z.enum(MEMORY_TYPES) })
  .strict()
const RunFinishedPayload = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done') }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('failed'), error: z.string() }).strict(),
])
const ConversationDeletedPayload = z
  .object({ conversationId: z.string().min(1), title: z.string() })
  .strict()

const payloadSchemas = {
  'run-started': RunStartedPayload,
  'approval-requested': ApprovalRequestedPayload,
  'approval-decided': ApprovalDecidedPayload,
  'tool-call': ToolCallPayload,
  'tool-result': ToolResultPayload,
  'tool-denied': ToolDeniedPayload,
  retrieval: RetrievalPayload,
  'memory-used': MemoryUsedPayload,
  'memory-written': MemoryWrittenPayload,
  'memory-deleted': MemoryDeletedPayload,
  'run-finished': RunFinishedPayload,
  'conversation-deleted': ConversationDeletedPayload,
} as const

export type AuditEventType = keyof typeof payloadSchemas
export type AuditEventPayloadMap = {
  [K in AuditEventType]: z.infer<(typeof payloadSchemas)[K]>
}
export type AuditEventPayload = AuditEventPayloadMap[AuditEventType]

/** 写入端的事件（id / createdAt 由 store 生成） */
export type NewAuditEvent = {
  [K in AuditEventType]: {
    type: K
    payload: AuditEventPayloadMap[K]
    runId?: string | null
    conversationId?: string | null
  }
}[AuditEventType]

function eventSchema<T extends AuditEventType>(type: T) {
  return z
    .object({
      id: z.number().int(),
      runId: z.string().nullable(),
      conversationId: z.string().nullable(),
      type: z.literal(type),
      payload: payloadSchemas[type],
      createdAt: z.number(),
    })
    .strict()
}

export const AuditEventSchema = z.discriminatedUnion('type', [
  eventSchema('run-started'),
  eventSchema('approval-requested'),
  eventSchema('approval-decided'),
  eventSchema('tool-call'),
  eventSchema('tool-result'),
  eventSchema('tool-denied'),
  eventSchema('retrieval'),
  eventSchema('memory-used'),
  eventSchema('memory-written'),
  eventSchema('memory-deleted'),
  eventSchema('run-finished'),
  eventSchema('conversation-deleted'),
])
export type AuditEvent = z.infer<typeof AuditEventSchema>
