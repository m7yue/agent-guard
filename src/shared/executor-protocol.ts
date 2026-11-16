// 主进程 ↔ 执行器之间的消息协议：两侧都用 zod 校验，不靠 `as` 断言。
import { z } from 'zod'
import { AgentEventEnvelopeSchema } from './agent-event'
import {
  MEMORY_TYPES,
  MemoryBody,
  MemoryDescription,
  MemoryItem,
  MemoryName,
} from './memory'

export const BusyRequest = z
  .object({
    type: z.literal('busy'),
    id: z.number().int(),
    ms: z.number().int().min(0).max(60_000),
  })
  .strict()

export const CrashRequest = z.object({ type: z.literal('crash') }).strict()

export const AskRequest = z
  .object({
    type: z.literal('ask'),
    runId: z.string().min(1),
    conversationId: z.string().min(1),
    prompt: z.string().min(1).max(500),
  })
  .strict()

// 主进程 → 执行器：新建会话并绑定工作区（写库只能在执行器）
export const CreateConversationRequest = z
  .object({
    type: z.literal('create-conversation'),
    id: z.number().int(),
    conversationId: z.string().min(1),
    title: z.string().max(100),
    workspaceRoot: z.string().min(1),
  })
  .strict()

// 主进程 → 执行器：取消某次运行
export const CancelRequest = z
  .object({ type: z.literal('cancel'), runId: z.string().min(1) })
  .strict()

// 主进程 → 执行器：审批结果（执行器阻塞等待的就是它）
export const ApprovalResult = z
  .object({
    type: z.literal('approval-result'),
    requestId: z.string().min(1),
    decision: z.enum(['once', 'session', 'deny']),
  })
  .strict()

// 主进程 → 执行器：删除会话（软删；写库只能在执行器——它是唯一写者）
export const DeleteConversationRequest = z
  .object({
    type: z.literal('delete-conversation'),
    id: z.number().int(),
    conversationId: z.string().min(1),
  })
  .strict()

// 主进程 → 执行器：编辑记忆（UI 操作；expectedUpdatedAt 做乐观锁）
// 注意：协议顶层 type 是 discriminator，记忆语义类型用 memoryType。
export const UpdateMemoryRequest = z
  .object({
    type: z.literal('update-memory'),
    id: z.number().int(),
    name: MemoryName,
    description: MemoryDescription,
    memoryType: z.enum(MEMORY_TYPES),
    body: MemoryBody,
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict()

// 主进程 → 执行器：删除记忆（UI-only；有运行中的任务时执行器拒绝）
export const DeleteMemoryRequest = z
  .object({
    type: z.literal('delete-memory'),
    id: z.number().int(),
    name: MemoryName,
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict()

// 执行器 → 主进程：审批请求（带上工具、参数与理由，供界面展示）
export const ApprovalRequestMessage = z
  .object({
    type: z.literal('approval-request'),
    requestId: z.string().min(1),
    runId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
  })
  .strict()
export type ApprovalRequestMessage = z.infer<typeof ApprovalRequestMessage>

export const ExecutorRequest = z.discriminatedUnion('type', [
  BusyRequest,
  CrashRequest,
  AskRequest,
  CancelRequest,
  ApprovalResult,
  CreateConversationRequest,
  DeleteConversationRequest,
  UpdateMemoryRequest,
  DeleteMemoryRequest,
])
export type ExecutorRequest = z.infer<typeof ExecutorRequest>

// 执行器对 busy 请求的回复
export const BusyReply = z.object({
  id: z.number().int(),
  pid: z.number().int(),
  elapsed: z.number(),
})
export type BusyReply = z.infer<typeof BusyReply>

// 执行器对 create-conversation 的回复
export const CreateConversationReply = z.discriminatedUnion('status', [
  z.object({ id: z.number().int(), status: z.literal('created') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('error'), message: z.string() }).strict(),
])
export type CreateConversationReply = z.infer<typeof CreateConversationReply>

// 执行器对 delete-conversation 请求的回复：幂等删除；唯一拒绝原因是运行中
export const DeleteConversationReply = z.discriminatedUnion('status', [
  z.object({ id: z.number().int(), status: z.literal('deleted') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('run-active') }).strict(),
])
export type DeleteConversationReply = z.infer<typeof DeleteConversationReply>

// 执行器对 update-memory / delete-memory 的回复。与 delete-conversation 共用 id 路由，
// 客户端按请求类型选择对应的 zod schema 解析（不靠字段形状猜）。
export const UpdateMemoryReply = z.discriminatedUnion('status', [
  z.object({ id: z.number().int(), status: z.literal('updated'), item: MemoryItem }).strict(),
  z.object({ id: z.number().int(), status: z.literal('not-found') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('conflict'), current: MemoryItem }).strict(),
  z.object({ id: z.number().int(), status: z.literal('internal') }).strict(),
])
export type UpdateMemoryReply = z.infer<typeof UpdateMemoryReply>

export const DeleteMemoryReply = z.discriminatedUnion('status', [
  z.object({ id: z.number().int(), status: z.literal('deleted') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('not-found') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('conflict'), current: MemoryItem }).strict(),
  z.object({ id: z.number().int(), status: z.literal('run-active') }).strict(),
  z.object({ id: z.number().int(), status: z.literal('internal') }).strict(),
])
export type DeleteMemoryReply = z.infer<typeof DeleteMemoryReply>

// 运行事件的外层信封：runId + 事件体；事件体是 AgentEvent 的 ADT，在跨进程边界做运行时校验
export const AgentEventEnvelope = AgentEventEnvelopeSchema
export type AgentEventEnvelope = z.infer<typeof AgentEventEnvelopeSchema>
