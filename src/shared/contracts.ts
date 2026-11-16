// 单一事实源：channel、方法名、入参/出参的 schema，都只在这里写一次。
// 类型不是手写的，而是从 schema 推导（z.infer）——这样"运行时校验"和"编译期类型"描述的是同一件事。
//
// 三个约定：
// - 命名：schema 以「方法名 + Input/Output」命名（listAuditEvents → ListAuditEventsInput），
//   这样 channel、方法、schema 三者能互相对上；
// - schema 与推导类型同名：`const X` 与 `type X` 分属值/类型命名空间，不冲突，
//   import 一次同时拿到 schema 与类型（zod 官方也是这样用的）；
// - 入参一律 `.strict()`：多传字段直接判为不合法；出参不写 `.strict()`，以主进程返回为准。
import { z } from 'zod'
import type { AgentEvent } from './agent-event'
import { AuditEventSchema } from './audit-event'
import {
  MEMORY_TYPES,
  MemoryBody,
  MemoryDescription,
  MemoryItem,
  MemoryName,
  MemorySummary,
} from './memory'
import type { UpdateStatus } from './update'
import { ApprovalRequestSchema, type ApprovalDecision, type ApprovalRequestPayload } from './approval'

// ── 探活 ──────────────────────────────────────────────────────────────
// 入参：无（空对象）
export const PingInput = z.object({}).strict()
export const PingOutput = z.object({
  /** 固定 true：能返回就说明主进程活着 */
  pong: z.literal(true),
  /** 主进程 pid，用来区分"哪个进程在回答" */
  pid: z.number().int(),
  /** 模型模式：mock = 脚本模型，real = 真实模型（由 .env 决定） */
  mode: z.enum(['mock', 'real']),
  /** Electron / Chromium / Node 版本，排障时看兼容性 */
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
})

// ── 忙等（对照实验）─────────────────────────────────────────────────
// 入参：ms 是需要忙等的毫秒数，上限 10 秒，避免误操作卡死界面
export const BusyInput = z.object({ ms: z.number().int().min(0).max(10_000) }).strict()
export const BusyOutput = z.object({
  /** 这次忙等发生在哪：执行器进程 or 主进程 */
  where: z.enum(['executor', 'main']),
  /** 实际干活那个进程的 pid */
  pid: z.number().int(),
  /** 实际耗时（毫秒），和入参对比能看出调度/阻塞的影响 */
  elapsed: z.number(),
})

// ── 让执行器崩溃（演示崩溃半径）──────────────────────────────────────
export const CrashExecutorOutput = z.object({
  /** 固定 true：表示"崩溃请求已发出"（不代表已经崩完） */
  requested: z.literal(true),
})

// ── 审批回执 ──────────────────────────────────────────────────────────
export const ApproveInput = z
  .object({
    /** 审批请求的 id（执行器生成，随 approval-request 推送下来） */
    requestId: z.string().min(1),
    /** once = 只允许这一次；session = 本会话内同名工具都放行；deny = 拒绝 */
    decision: z.enum(['once', 'session', 'deny']),
  })
  .strict()
export const ApproveOutput = z.object({
  /** 是否被接受：重复点击或请求已过期时返回 false（不报错） */
  accepted: z.boolean(),
})

// ── 取消运行 ──────────────────────────────────────────────────────────
export const CancelInput = z.object({
  /** 要取消哪一次运行（ask 返回的 runId） */
  runId: z.string().min(1),
}).strict()
export const CancelOutput = z.object({
  /** 是否已把取消请求发给执行器（不代表模型已经停下） */
  cancelled: z.boolean(),
})

// ── 审计事件 ──────────────────────────────────────────────────────────
// 执行器写入，主进程只读；一条事件描述"运行过程中的一个动作"。
// type 是 ADT 判别字段，payload 的形状由 type 决定（见 shared/audit-event.ts）。
export const AuditEvent = AuditEventSchema
export type AuditEvent = z.infer<typeof AuditEventSchema>
export const ListAuditEventsInput = z
  .object({
    /** 只看某个会话的事件；不传则看全部 */
    conversationId: z.string().optional(),
    /** 最多返回多少条，默认 100，上限 500（避免一次拉太多） */
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict()
export const ListAuditEventsOutput = z.object({
  /** 按 createdAt 倒序（最近的在前） */
  items: z.array(AuditEvent),
})

// ── 渲染层错误上报 ────────────────────────────────────────────────────
export const ReportErrorInput = z
  .object({
    /** 错误消息（必填） */
    message: z.string().min(1),
    /** 错误栈；不是 Error 对象时可能没有 */
    stack: z.string().optional(),
    /** 来源标记：window.error / unhandledrejection，便于过滤 */
    source: z.string().optional(),
  })
  .strict()
export const ReportErrorOutput = z.object({
  /** 是否已落进日志 */
  recorded: z.boolean(),
})

// ── 自动更新 ──────────────────────────────────────────────────────────
// 三个动作都只是"触发"，结果通过 update-status 推送
export const UpdateActionInput = z.object({}).strict()
export const UpdateActionOutput = z.object({
  /** 是否已转交给更新器（开发态或未配置更新源时为 false） */
  accepted: z.boolean(),
})

// ── 性能：渲染层首帧回报 ──────────────────────────────────────────────
export const ReportPerfInput = z
  .object({
    /** 页面自身的 requestAnimationFrame 时间（毫秒，相对页面加载） */
    firstPaintMs: z.number(),
  })
  .strict()
export const ReportPerfOutput = z.object({ recorded: z.boolean() })

// ── 会话列表与历史 ────────────────────────────────────────────────────
// 持久化后由主进程直接读库，渲染层只做展示。
// 列表按最近活动排序；历史只返回纯文本（工具块不参与回放）。
export const ConversationSummary = z.object({
  /** 会话 UUID */
  id: z.string().min(1),
  /** 侧栏标题：首条提问截断而成，可能为空串 */
  title: z.string(),
  /** 最近一次写入消息的时间（毫秒时间戳），列表按它倒序 */
  updatedAt: z.number(),
  /** 消息条数（会话摘要用，不含工具块细节） */
  messageCount: z.number(),
  /** 该会话绑定的工作区根目录 */
  workspaceRoot: z.string(),
})
export const ListConversationsInput = z.object({}).strict()
export const ListConversationsOutput = z.object({
  /** 按最近活动倒序的会话摘要 */
  items: z.array(ConversationSummary),
})

export const LoadConversationInput = z.object({
  /** 要回放哪个会话 */
  conversationId: z.string().min(1),
}).strict()
export const LoadConversationOutput = z.object({
  /** 该会话绑定的工作区根目录 */
  workspaceRoot: z.string(),
  /** 按时间正序的消息；只含角色与文本，用于气泡回放 */
  items: z.array(
    z.object({
      /** 谁说的 */
      role: z.enum(['user', 'assistant']),
      /** 该消息的纯文本（工具调用细节在运行时日志里，不在回放中） */
      text: z.string(),
    }),
  ),
})

// ── 会话工作区 ────────────────────────────────────────────────────────
// 每个会话绑定一个用户选择的目录；新建会话前先选目录（取消则不创建）。
export const CreateConversationInput = z
  .object({
    /** 渲染层生成的会话 UUID */
    conversationId: z.string().min(1),
    /** 用户选择的目录绝对路径 */
    workspaceRoot: z.string().min(1),
    /** 目录选择器一次性令牌；主进程用它确认路径确实由用户选择 */
    workspaceToken: z.string().min(1).optional(),
    /** 初始标题；新建时为空串，首条提问后补齐 */
    title: z.string().max(100).optional(),
  })
  .strict()
export const CreateConversationOutput = z.object({
  /** 是否创建成功（幂等；已存在也返回 true） */
  created: z.boolean(),
})

export const ChooseWorkspaceInput = z.object({}).strict()
export const ChooseWorkspaceOutput = z.object({
  /** 用户选择的目录；取消时为 null */
  path: z.string().nullable(),
  /** 一次性令牌，创建会话时回传；取消时为 null */
  token: z.string().nullable(),
})

// ── 待审批列表 ────────────────────────────────────────────────────────
// 窗口重新出现时用它恢复队列（主进程记账，渲染层只展示）
export const ListPendingApprovalsInput = z.object({}).strict()
export const ListPendingApprovalsOutput = z.object({
  /** 当前所有待处理审批；形状与 approval-request 推送一致 */
  items: z.array(ApprovalRequestSchema),
})

// ── 记忆管理 ──────────────────────────────────────────────────────────
// 主进程只读列表/详情；编辑/删除经执行器（唯一写者），带 expectedUpdatedAt 乐观锁。
export const ListMemoriesInput = z
  .object({
    /** 按 name 模糊搜索（服务端 LIKE） */
    name: z.string().max(200).optional(),
    /** 按 description 模糊搜索（服务端 LIKE） */
    description: z.string().max(200).optional(),
    /** 按语义类型筛选 */
    type: z.enum(MEMORY_TYPES).optional(),
    /** updatedAt 下限（含），epoch 毫秒 */
    updatedAtFrom: z.number().int().nonnegative().optional(),
    /** updatedAt 上限（含），epoch 毫秒 */
    updatedAtTo: z.number().int().nonnegative().optional(),
    /** 每页条数，默认 20，上限 100 */
    limit: z.number().int().min(1).max(100).optional(),
    /** 偏移，默认 0 */
    offset: z.number().int().nonnegative().optional(),
    /** 默认 updatedAt desc */
    sortBy: z.enum(['name', 'updatedAt']).optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
  })
  .strict()
export const ListMemoriesOutput = z.object({
  /** 当前页摘要，不含正文 */
  items: z.array(MemorySummary),
  /** 过滤后的总条数（分页前） */
  total: z.number().int().nonnegative(),
})

export const LoadMemoryInput = z
  .object({
    /** 记忆标识 */
    name: MemoryName,
  })
  .strict()
export const LoadMemoryOutput = z.object({
  /** 不存在时为 null（UI 显示空状态/已删除） */
  item: MemoryItem.nullable(),
})

export const UpdateMemoryInput = z
  .object({
    /** 身份标识，不可改 */
    name: MemoryName,
    description: MemoryDescription,
    type: z.enum(MEMORY_TYPES),
    body: MemoryBody,
    /** UI 打开详情时看到的 updatedAt；不匹配返回 conflict */
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict()
export const UpdateMemoryOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('updated'),
    /** 保存后的完整文档 */
    item: MemoryItem,
  }),
  z.object({
    /** 记忆已被删除 */
    status: z.literal('not-found'),
  }),
  z.object({
    status: z.literal('conflict'),
    /** UI 用它重新加载，避免静默覆盖 */
    current: MemoryItem,
  }),
  z.object({
    /** 执行器内部错误 */
    status: z.literal('internal'),
  }),
])

export const DeleteMemoryInput = z
  .object({
    name: MemoryName,
    /** 与更新相同的乐观锁；防止删掉别人刚改过的记忆 */
    expectedUpdatedAt: z.number().int().nonnegative(),
  })
  .strict()
export const DeleteMemoryOutput = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('deleted'),
  }),
  z.object({
    /** 记忆已被删除 */
    status: z.literal('not-found'),
  }),
  z.object({
    status: z.literal('conflict'),
    /** UI 用它重新加载 */
    current: MemoryItem,
  }),
  z.object({
    /** 有运行中的任务，拒绝删除 */
    status: z.literal('run-active'),
  }),
  z.object({
    /** 执行器内部错误 */
    status: z.literal('internal'),
  }),
])

// ── 删除会话（软删）──────────────────────────────────────────────────
// 源数据（消息/运行/审计事件）保留可查，检索语料（chunks/embeddings）物理清除。
// 写库在执行器（唯一写者），主进程转发并等回执。
export const ConversationDeleteInput = z
  .object({
    /** 要删除哪个会话 */
    conversationId: z.string().min(1),
  })
  .strict()
export const ConversationDeleteOutput = z.discriminatedUnion('status', [
  z.object({
    /** 已删除；已删除或不存在的会话也返回这个状态（幂等） */
    status: z.literal('deleted'),
  }),
  z.object({
    /** 唯一拒绝原因：会话有正在进行的运行 */
    status: z.literal('run-active'),
  }),
])

// ── 发起一次运行 ──────────────────────────────────────────────────────
// 立刻返回 runId，后续过程通过事件推送（token / tool-call / done …）
export const AskInput = z
  .object({
    /** 在哪个会话里提问（历史由执行器按它从库里取） */
    conversationId: z.string().min(1),
    /** 本次提问文本，上限 500 字 */
    prompt: z.string().min(1).max(500),
  })
  .strict()
export const AskOutput = z.object({
  /** 本次运行的唯一 id（跨重启唯一，用于取消与审计关联） */
  runId: z.string(),
})

// ── 回显（验证契约校验）──────────────────────────────────────────────
export const EchoInput = z.object({
  /** 要回显的文本，上限 200 字 */
  text: z.string().min(1).max(200),
}).strict()
export const EchoOutput = z.object({
  /** 原样返回 */
  text: z.string(),
  /** 长度，用来验证"服务端确实处理过" */
  length: z.number().int(),
})

// ── 通道表 ────────────────────────────────────────────────────────────
// key = IPC channel（主进程注册用），method = 页面上的方法名（preload 暴露用）
import { CHANNELS } from './channels'

export const CONTRACTS = {
  'app:ping': { ...CHANNELS['app:ping'], input: PingInput, output: PingOutput },
  'app:echo': { ...CHANNELS['app:echo'], input: EchoInput, output: EchoOutput },
  'app:busy': { ...CHANNELS['app:busy'], input: BusyInput, output: BusyOutput },
  'app:busy-main': { ...CHANNELS['app:busy-main'], input: BusyInput, output: BusyOutput },
  'app:crash-executor': { ...CHANNELS['app:crash-executor'], input: z.object({}).strict(), output: CrashExecutorOutput },
  'app:ask': { ...CHANNELS['app:ask'], input: AskInput, output: AskOutput },
  'app:approve': { ...CHANNELS['app:approve'], input: ApproveInput, output: ApproveOutput },
  'app:cancel': { ...CHANNELS['app:cancel'], input: CancelInput, output: CancelOutput },
  'app:audit-events': {
    ...CHANNELS['app:audit-events'],
    input: ListAuditEventsInput,
    output: ListAuditEventsOutput,
  },
  'app:check-update': {
    ...CHANNELS['app:check-update'],
    input: UpdateActionInput,
    output: UpdateActionOutput,
  },
  'app:download-update': {
    ...CHANNELS['app:download-update'],
    input: UpdateActionInput,
    output: UpdateActionOutput,
  },
  'app:install-update': {
    ...CHANNELS['app:install-update'],
    input: UpdateActionInput,
    output: UpdateActionOutput,
  },
  'app:report-perf': {
    ...CHANNELS['app:report-perf'],
    input: ReportPerfInput,
    output: ReportPerfOutput,
  },
  'app:report-error': {
    ...CHANNELS['app:report-error'],
    input: ReportErrorInput,
    output: ReportErrorOutput,
  },
  'app:conversation-list': {
    ...CHANNELS['app:conversation-list'],
    input: ListConversationsInput,
    output: ListConversationsOutput,
  },
  'app:conversation-create': {
    ...CHANNELS['app:conversation-create'],
    input: CreateConversationInput,
    output: CreateConversationOutput,
  },
  'app:workspace-choose': {
    ...CHANNELS['app:workspace-choose'],
    input: ChooseWorkspaceInput,
    output: ChooseWorkspaceOutput,
  },
  'app:conversation-load': {
    ...CHANNELS['app:conversation-load'],
    input: LoadConversationInput,
    output: LoadConversationOutput,
  },
  'app:pending-approvals': {
    ...CHANNELS['app:pending-approvals'],
    input: ListPendingApprovalsInput,
    output: ListPendingApprovalsOutput,
  },
  'app:memory-list': {
    ...CHANNELS['app:memory-list'],
    input: ListMemoriesInput,
    output: ListMemoriesOutput,
  },
  'app:memory-load': {
    ...CHANNELS['app:memory-load'],
    input: LoadMemoryInput,
    output: LoadMemoryOutput,
  },
  'app:memory-update': {
    ...CHANNELS['app:memory-update'],
    input: UpdateMemoryInput,
    output: UpdateMemoryOutput,
  },
  'app:memory-delete': {
    ...CHANNELS['app:memory-delete'],
    input: DeleteMemoryInput,
    output: DeleteMemoryOutput,
  },
  'app:conversation-delete': {
    ...CHANNELS['app:conversation-delete'],
    input: ConversationDeleteInput,
    output: ConversationDeleteOutput,
  },
} as const

/** 所有合法的 channel 名（`app:xxx`），主进程注册与启动对账都靠它 */
export type Channel = keyof typeof CONTRACTS

// ── schema 与推导类型同名（zod 惯例）────────────────────────────────
// `const X` 与 `type X` 分属值/类型两个命名空间，同名不冲突；
// 调用方 import 一次就同时拿到 schema 与类型。
export type PingInput = z.infer<typeof PingInput>
export type PingOutput = z.infer<typeof PingOutput>
export type EchoInput = z.infer<typeof EchoInput>
export type EchoOutput = z.infer<typeof EchoOutput>
export type BusyInput = z.infer<typeof BusyInput>
export type BusyOutput = z.infer<typeof BusyOutput>
export type CrashExecutorOutput = z.infer<typeof CrashExecutorOutput>
export type AskInput = z.infer<typeof AskInput>
export type AskOutput = z.infer<typeof AskOutput>
export type ApproveInput = z.infer<typeof ApproveInput>
export type ApproveOutput = z.infer<typeof ApproveOutput>
export type CancelInput = z.infer<typeof CancelInput>
export type CancelOutput = z.infer<typeof CancelOutput>
export type ListPendingApprovalsOutput = z.infer<typeof ListPendingApprovalsOutput>
export type ListMemoriesInput = z.infer<typeof ListMemoriesInput>
export type ListMemoriesOutput = z.infer<typeof ListMemoriesOutput>
export type LoadMemoryInput = z.infer<typeof LoadMemoryInput>
export type LoadMemoryOutput = z.infer<typeof LoadMemoryOutput>
export type UpdateMemoryInput = z.infer<typeof UpdateMemoryInput>
export type UpdateMemoryOutput = z.infer<typeof UpdateMemoryOutput>
export type DeleteMemoryInput = z.infer<typeof DeleteMemoryInput>
export type DeleteMemoryOutput = z.infer<typeof DeleteMemoryOutput>
export type ConversationDeleteInput = z.infer<typeof ConversationDeleteInput>
export type ConversationDeleteOutput = z.infer<typeof ConversationDeleteOutput>
export type ListAuditEventsInput = z.infer<typeof ListAuditEventsInput>
export type ListAuditEventsOutput = z.infer<typeof ListAuditEventsOutput>
export type UpdateActionInput = z.infer<typeof UpdateActionInput>
export type UpdateActionOutput = z.infer<typeof UpdateActionOutput>
export type ReportPerfInput = z.infer<typeof ReportPerfInput>
export type ReportPerfOutput = z.infer<typeof ReportPerfOutput>
export type ReportErrorInput = z.infer<typeof ReportErrorInput>
export type ReportErrorOutput = z.infer<typeof ReportErrorOutput>
export type ConversationSummary = z.infer<typeof ConversationSummary>
export type ListConversationsOutput = z.infer<typeof ListConversationsOutput>
export type CreateConversationInput = z.infer<typeof CreateConversationInput>
export type CreateConversationOutput = z.infer<typeof CreateConversationOutput>
export type ChooseWorkspaceInput = z.infer<typeof ChooseWorkspaceInput>
export type ChooseWorkspaceOutput = z.infer<typeof ChooseWorkspaceOutput>
export type LoadConversationInput = z.infer<typeof LoadConversationInput>
export type LoadConversationOutput = z.infer<typeof LoadConversationOutput>

// ── 统一错误码 ────────────────────────────────────────────────────────
export const ERROR = {
  /** 入参没通过 schema 校验（调用方传错了） */
  BAD_INPUT: 'BAD_INPUT',
  /** handler 内部抛错（业务/环境问题） */
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR)[keyof typeof ERROR]

// ── 统一返回信封 ──────────────────────────────────────────────────────
// 成功和失败是两种不同的数据，调用方用 ok 分流。
export type Envelope<T> =
  | {
      /** 成功标记 */
      ok: true
      /** 契约声明的出参 */
      data: T
    }
  | {
      /** 失败标记 */
      ok: false
      error: {
        /** 错误分类，见 ERROR */
        code: ErrorCode
        /** 给人看的错误描述（含 zod 校验细节） */
        message: string
      }
    }

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data }
}

export function fail(code: ErrorCode, message: string): Envelope<never> {
  return { ok: false, error: { code, message } }
}

// 页面能看到的 API 形状。入参/出参类型都指向 schema，改 schema 就自动改这里。
export type { ApprovalDecision, ApprovalRequestPayload }

export interface AgentGuardApi {
  /** 探活：返回主进程 pid 与运行时版本，页面启动时调一次 */
  ping: () => Promise<Envelope<PingOutput>>
  /** 原样回显，用来演示契约校验（类型错、多余字段都会被拒） */
  echo: (input: EchoInput) => Promise<Envelope<EchoOutput>>
  /** 让执行器忙等 ms 毫秒（对照实验） */
  busy: (input: BusyInput) => Promise<Envelope<BusyOutput>>
  /** 让主进程忙等 ms 毫秒（对照实验） */
  busyMain: (input: BusyInput) => Promise<Envelope<BusyOutput>>
  /** 让执行器进程直接退出，演示崩溃半径与惰性重启 */
  crashExecutor: () => Promise<Envelope<CrashExecutorOutput>>
  /** 发起一次 Agent 运行：立刻返回 runId，过程通过事件推送 */
  ask: (input: AskInput) => Promise<Envelope<AskOutput>>
  /** 把用户的选择回执给主进程，由它转交正在等待的执行器 */
  approve: (input: ApproveInput) => Promise<Envelope<ApproveOutput>>
  /** 取消一次正在进行的运行（对应 Web 的 AbortController） */
  cancel: (input: CancelInput) => Promise<Envelope<CancelOutput>>
  /** 拉取当前待审批列表（窗口刷新/重开后恢复队列） */
  listPendingApprovals: () => Promise<Envelope<ListPendingApprovalsOutput>>
  /** 新建会话并绑定工作区（先选目录，再创建） */
  createConversation: (
    input: CreateConversationInput,
  ) => Promise<Envelope<CreateConversationOutput>>
  /** 打开系统目录选择器；取消返回 null */
  chooseWorkspace: (input: ChooseWorkspaceInput) => Promise<Envelope<ChooseWorkspaceOutput>>
  /** 删除会话（软删：审计保留，检索语料清除）；运行中的会话会被拒绝 */
  deleteConversation: (input: ConversationDeleteInput) => Promise<Envelope<ConversationDeleteOutput>>
  /** 记忆列表：只返回摘要，不含正文；支持服务端搜索/筛选/分页/排序 */
  listMemories: (input: ListMemoriesInput) => Promise<Envelope<ListMemoriesOutput>>
  /** 读取一条记忆的完整正文 */
  loadMemory: (input: LoadMemoryInput) => Promise<Envelope<LoadMemoryOutput>>
  /** 编辑记忆（用户操作，不经过模型审批；带 expectedUpdatedAt 乐观锁） */
  updateMemory: (input: UpdateMemoryInput) => Promise<Envelope<UpdateMemoryOutput>>
  /** 删除记忆（UI-only；有运行中的任务时执行器拒绝） */
  deleteMemory: (input: DeleteMemoryInput) => Promise<Envelope<DeleteMemoryOutput>>
  /** 审计事件（按时间倒序，可按会话过滤） */
  listAuditEvents: (input: ListAuditEventsInput) => Promise<Envelope<ListAuditEventsOutput>>
  /** 检查更新（结果通过 onUpdateStatus 推送） */
  checkUpdate: (input: UpdateActionInput) => Promise<Envelope<UpdateActionOutput>>
  /** 下载已发现的新版本 */
  downloadUpdate: (input: UpdateActionInput) => Promise<Envelope<UpdateActionOutput>>
  /** 退出并安装已下载的版本 */
  installUpdate: (input: UpdateActionInput) => Promise<Envelope<UpdateActionOutput>>
  /** 订阅更新状态；返回取消订阅函数 */
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void
  /** 上报首帧时间，主进程用它在启动时间线上打点 */
  reportPerf: (input: ReportPerfInput) => Promise<Envelope<ReportPerfOutput>>
  /** 上报渲染层错误，由主进程写日志 */
  reportError: (input: ReportErrorInput) => Promise<Envelope<ReportErrorOutput>>
  /** 会话列表（按最近活动排序） */
  listConversations: () => Promise<Envelope<ListConversationsOutput>>
  /** 某个会话的历史消息（只含文本，用于界面回放） */
  loadConversation: (input: LoadConversationInput) => Promise<Envelope<LoadConversationOutput>>
  /** 订阅主进程推送的审批请求（执行器在等回执）；返回取消订阅函数 */
  onApprovalRequest: (listener: (payload: ApprovalRequestPayload) => void) => () => void
  /** 订阅主进程推送的运行事件；返回取消订阅函数，避免重复订阅泄漏 */
  onAgentEvent: (listener: (payload: { runId: string; event: AgentEvent }) => void) => () => void
}
