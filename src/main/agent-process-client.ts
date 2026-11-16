// Agent 执行器进程的客户端：主进程侧的"遥控器"。
//
// 负责：fork 执行器、给请求编号、把回复对回去、把执行器的消息分发给监听者、崩溃后惰性重启。
// 不关心 Agent 逻辑——那是执行器进程自己的事。
import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import {
  ApprovalRequestMessage,
  AgentEventEnvelope,
  CreateConversationReply,
  BusyReply,
  DeleteConversationReply,
  DeleteMemoryReply,
  UpdateMemoryReply,
} from '../shared/executor-protocol'
import type { AgentEvent } from '../shared/agent-event'
import type { Logger } from '../harness/logging/logger'
import type { ApprovalDecision, ApprovalRequestPayload } from '../shared/approval'
import type { MemoryType } from '../shared/memory'

import type {
  BusyReply as BusyReplyData,
  DeleteConversationReply as DeleteConversationReplyData,
  DeleteMemoryReply as DeleteMemoryReplyData,
  UpdateMemoryReply as UpdateMemoryReplyData,
} from '../shared/executor-protocol'

export interface CreateConversationParams {
  conversationId: string
  title: string
  workspaceRoot: string
}

export interface AskParams {
  runId: string
  conversationId: string
  prompt: string
}

export interface UpdateMemoryParams {
  name: string
  description: string
  type: MemoryType
  body: string
  expectedUpdatedAt: number
}

export interface DeleteMemoryParams {
  name: string
  expectedUpdatedAt: number
}

/** 一次 Agent 运行的流式事件（带 runId） */
export interface AgentEventPayload {
  runId: string
  event: AgentEvent
}

/** 执行器可能推上来的消息种类 → 载荷类型 */
export interface AgentProcessEventMap {
  'agent-event': AgentEventPayload
  'approval-request': ApprovalRequestPayload
}

export interface AgentProcessClient {
  runBusy(ms: number): Promise<BusyReplyData>
  createConversation(params: CreateConversationParams): Promise<CreateConversationReply>
  ask(params: AskParams): void
  cancel(runId: string): void
  crash(): void
  /** 软删会话（执行器是唯一写者，写库在它那边）；回执带 deleted/reason */
  deleteConversation(conversationId: string): Promise<DeleteConversationReplyData>
  /** 编辑记忆；回执带 updated/item/current/reason */
  updateMemory(params: UpdateMemoryParams): Promise<UpdateMemoryReplyData>
  /** 删除记忆；回执带 deleted/reason（run-active 表示有运行中的任务） */
  deleteMemory(params: DeleteMemoryParams): Promise<DeleteMemoryReplyData>

  /**
   * 监听执行器发来的消息。事件名即消息种类，符合 Node 的 on(name, listener) 习惯。
   * - 'agent-event'：运行过程中的 token / 工具调用 / 结束
   * - 'approval-request'：要用户点头的审批请求（执行器此时在等回执）
   */
  on<K extends keyof AgentProcessEventMap>(
    name: K,
    listener: (payload: AgentProcessEventMap[K]) => void,
  ): void

  respondApproval(requestId: string, decision: ApprovalDecision): void
  dispose(): void
}

export interface AgentProcessClientOptions {
  /** 会话与运行记录的存放目录（执行器写库用） */
  stateDir: string
  /** 结构化日志：启动/退出/异常消息进当天的 JSONL，而不是只打 console */
  logger?: Logger
}

export function createAgentProcessClient(options: AgentProcessClientOptions): AgentProcessClient {
  const logger: Logger =
    options.logger ?? {
      debug: (message) => console.debug(message),
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    }
  let child: UtilityProcess | null = null
  let seq = 0

  // 等回执的请求：按 id 路由；每个请求自带解析器，避免 delete-conversation
  // 与 delete-memory 这种同形状回执互相误判。
  type PendingReply =
    | CreateConversationReply
    | BusyReplyData
    | DeleteConversationReplyData
    | UpdateMemoryReplyData
    | DeleteMemoryReplyData

  const pending = new Map<
    number,
    {
      parse: (message: unknown) => PendingReply | null
      resolve: (reply: PendingReply) => void
      reject: (error: Error) => void
    }
  >()

  function request<T extends PendingReply>(
    build: (id: number) => unknown,
    parse: (message: unknown) => T | null,
  ): Promise<T> {
    const proc = ensure()
    const id = ++seq
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        parse,
        resolve: resolve as (reply: PendingReply) => void,
        reject,
      })
      proc.postMessage(build(id))
    })
  }

  function parseCreateConversation(message: unknown): CreateConversationReply | null {
    const parsed = CreateConversationReply.safeParse(message)
    return parsed.success ? parsed.data : null
  }

  function parseBusy(message: unknown): BusyReplyData | null {
    const parsed = BusyReply.safeParse(message)
    return parsed.success ? parsed.data : null
  }

  function parseDeleteConversation(message: unknown): DeleteConversationReplyData | null {
    const parsed = DeleteConversationReply.safeParse(message)
    return parsed.success ? parsed.data : null
  }

  function parseUpdateMemory(message: unknown): UpdateMemoryReplyData | null {
    const parsed = UpdateMemoryReply.safeParse(message)
    return parsed.success ? parsed.data : null
  }

  function parseDeleteMemory(message: unknown): DeleteMemoryReplyData | null {
    const parsed = DeleteMemoryReply.safeParse(message)
    return parsed.success ? parsed.data : null
  }

  const agentEventSubscribers = new Set<(payload: AgentEventPayload) => void>()
  const approvalSubscribers = new Set<(payload: ApprovalRequestPayload) => void>()
  // 已发起但尚未收到 done/cancelled/error 的 run；执行器退出时给它们补一条 error，
  // 否则渲染层的 runningRuns 永远不会清空（记忆删除等入口会被永久禁用）。
  const activeRuns = new Set<string>()

  // 惰性启动：第一次用到才 fork；崩了之后下一次调用会重新拉起来
  function ensure(): UtilityProcess {
    if (child) return child

    const proc = utilityProcess.fork(path.join(__dirname, 'executor.js'), [], {
      serviceName: 'agentguard-executor',
      // 工作区路径由主进程决定（用户数据目录下），执行器只负责用
      env: {
        ...process.env,
        AGENTGUARD_STATE_DIR: options.stateDir,
      },
    })

    // pid 在 spawn 之后才有值
    proc.on('spawn', () => logger.info('执行器已启动', { pid: proc.pid }))

    proc.on('message', (message: unknown) => {
      // 审批请求：执行器在等用户的选择
      const approval = ApprovalRequestMessage.safeParse(message)
      if (approval.success) {
        // 协议里的 type 只是路由标记，交给监听者时剥掉
        const payload: ApprovalRequestPayload = {
          requestId: approval.data.requestId,
          runId: approval.data.runId,
          tool: approval.data.tool,
          args: approval.data.args,
          reason: approval.data.reason,
        }
        for (const subscriber of approvalSubscribers) subscriber(payload)
        return
      }

      // 带 runId 的是 Agent 运行事件
      const envelope = AgentEventEnvelope.safeParse(message)
      if (envelope.success) {
        const payload = envelope.data
        if (
          payload.event.type === 'done' ||
          payload.event.type === 'cancelled' ||
          payload.event.type === 'error'
        ) {
          activeRuns.delete(payload.runId)
        }
        for (const subscriber of agentEventSubscribers) {
          subscriber(payload)
        }
        return
      }

      // 否则是对某次请求的回复：先按 id 找到等待者，再用该请求自己的 parser 校验。
      // 这样 delete-conversation 与 delete-memory 这种同形状回执不会互相误判。
      const id = (message as { id?: unknown } | null)?.id
      if (typeof id !== 'number') {
        logger.warn('执行器发来无法识别的消息', { message })
        return
      }
      const waiter = pending.get(id)
      if (!waiter) {
        logger.warn('执行器回复了未知请求 id', { id })
        return
      }
      const reply = waiter.parse(message)
      if (!reply) {
        pending.delete(id)
        waiter.reject(new Error(`执行器回复形状不匹配（id=${id}）`))
        logger.warn('执行器回复形状不匹配', { id, message })
        return
      }
      pending.delete(id)
      waiter.resolve(reply)
    })

    proc.on('exit', (code) => {
      // 非 0 退出（崩溃、被杀）用 warn，正常退出用 info
      if (code === 0) logger.info('执行器已退出', { code })
      else logger.warn('执行器异常退出，主进程仍在运行', { code })
      for (const waiter of pending.values()) waiter.reject(new Error('执行器已退出'))
      pending.clear()
      for (const runId of [...activeRuns]) {
        const payload: AgentEventPayload = {
          runId,
          event: { type: 'error', runId, message: '执行器已退出' },
        }
        for (const subscriber of agentEventSubscribers) subscriber(payload)
      }
      activeRuns.clear()
      child = null
    })

    child = proc
    return proc
  }

  return {
    runBusy(ms: number): Promise<BusyReplyData> {
      return request(
        (id) => ({ id, type: 'busy', ms }),
        parseBusy,
      )
    },

    deleteConversation(conversationId: string): Promise<DeleteConversationReplyData> {
      return request(
        (id) => ({ type: 'delete-conversation', id, conversationId }),
        parseDeleteConversation,
      )
    },

    updateMemory(params: UpdateMemoryParams): Promise<UpdateMemoryReplyData> {
      return request(
        (id) => ({
          type: 'update-memory',
          id,
          name: params.name,
          description: params.description,
          memoryType: params.type,
          body: params.body,
          expectedUpdatedAt: params.expectedUpdatedAt,
        }),
        parseUpdateMemory,
      )
    },

    deleteMemory(params: DeleteMemoryParams): Promise<DeleteMemoryReplyData> {
      return request(
        (id) => ({ type: 'delete-memory', id, ...params }),
        parseDeleteMemory,
      )
    },

    createConversation(params: CreateConversationParams): Promise<CreateConversationReply> {
      return request(
        (id) => ({ type: 'create-conversation', id, ...params }),
        parseCreateConversation,
      )
    },

    ask(params: AskParams): void {
      const proc = ensure()
      activeRuns.add(params.runId)
      proc.postMessage({ type: 'ask', ...params })
    },

    cancel(runId: string): void {
      ensure().postMessage({ type: 'cancel', runId })
    },

    crash(): void {
      ensure().postMessage({ type: 'crash' })
    },

    on(name: keyof AgentProcessEventMap, listener: (payload: never) => void): void {
      if (name === 'agent-event') {
        agentEventSubscribers.add(listener as (payload: AgentEventPayload) => void)
        return
      }
      approvalSubscribers.add(listener as (payload: ApprovalRequestPayload) => void)
    },

    respondApproval(requestId: string, decision: ApprovalDecision): void {
      ensure().postMessage({ type: 'approval-result', requestId, decision })
    },

    dispose(): void {
      child?.kill()
      child = null
    },
  }
}
