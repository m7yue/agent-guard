// 执行器进程入口：只做"收消息 → 分发"，具体工作交给 executor/run-ask。
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCrashReport } from '../harness/logging/crash-report'
import { configureLogging, getLogger } from '../harness/logging/logger'
import { indexCompletedRun } from '../harness/knowledge/conversation-documents'
import { createEmbeddingProvider } from '../harness/knowledge/embedding-provider'
import { createRerankStage } from '../harness/knowledge/rerank-provider'
import { searchConversationHistory } from '../harness/knowledge/searcher'
import { createMemorySelectorModel } from '../harness/memory/memory-text-model'
import { createMemoryRuntime } from '../harness/memory/runtime'
import { createMemoryManagement } from '../harness/memory/management'
import { reconcileMemoryIndex } from '../harness/memory/memory-writer'
import { HookManager } from '../harness/hooks'
import { databaseFile, openStore } from '../harness/store'

import {
  runAgentTask,
  type ApprovalOutcome,
  type ApprovalRequest,
} from '../harness/run-agent'
import { ExecutorRequest } from '../shared/executor-protocol'
import type { AgentEvent } from '../shared/agent-event'
import type { ApprovalDecision } from '../shared/approval'

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort: ParentPortLike }).parentPort

// 状态目录（会话与运行记录）：由主进程注入；
// 单独跑执行器时落到当前目录下的 .state，避免写进用户主目录
const STATE_DIR = process.env.AGENTGUARD_STATE_DIR ?? path.join(process.cwd(), '.state')

const store = openStore(databaseFile(STATE_DIR))

// 检索语料的 embedding 提供方：按 .env 选 zhipu / fake（配了 zhipu 缺 key 时自动回退 fake）
const embeddingProvider = createEmbeddingProvider()

// 重排阶段：AGENTGUARD_RERANK_PROVIDER 未配置（默认 off）时为 null，
// 检索行为与 会话检索 一致；配置后向量 top-N → 重排 → top-k（重排）。
const rerankStage = createRerankStage()

// 记忆选择器：只有真实模型配置存在时才有；零配置/演示模式返回 null，
// 选择直接走向量降级（目录仍然常驻，不会把演示脚本当成选择器）。
const memorySelectorModel = createMemorySelectorModel()

// 记忆管理（UI 编辑/删除）：入口只分发协议，检查/写入/审计在 harness 服务里。
const memoryManagement = createMemoryManagement({
  store,
  provider: embeddingProvider,
  onWritten: (payload) => store.appendEvent({ type: 'memory-written', payload }),
  onDeleted: (payload) => store.appendEvent({ type: 'memory-deleted', payload }),
})

// 日志与崩溃报告落在状态目录下；执行器的崩溃不应该只留一个 exit code
const LOG_DIR = path.join(STATE_DIR, 'logs')
configureLogging(LOG_DIR)
const log = getLogger('executor')

// 记忆索引对账：只在缺块 / 正文变 / 向量模型变时重建，正常启动零 embedding 调用。
// 后台执行且失败只记日志——记忆是回答质量的增强，不应阻塞执行器起跑。
void reconcileMemoryIndex({ store, provider: embeddingProvider })
  .then((reindexed) => {
    if (reindexed > 0) log.info('记忆索引对账完成', { reindexed })
  })
  .catch((error: unknown) => {
    log.warn('记忆索引对账失败', {
      message: error instanceof Error ? error.message : String(error),
    })
  })

process.on('uncaughtException', (error) => {
  log.error('uncaughtException', { message: error.message, stack: error.stack })
  writeCrashReport({ error, dir: LOG_DIR, context: {} })
  process.exit(1)
})

// 正在进行的运行：runId → 取消控制器。页面点"停止"时用它中断模型请求。
const runs = new Map<string, AbortController>()

// runId → 会话：审计事件需要带上会话归属
const runConversations = new Map<string, string>()

// 审批的挂起表：requestId → 所属运行与唤醒函数。
// 主进程把用户的选择以 approval-result 送回时，用这里找回被挂起的工具调用。
const pendingApprovalWaiters = new Map<
  string,
  { runId: string; resolve: (decision: ApprovalDecision, reason?: string) => void }
>()

// 本会话已授权的工具名：用户选过"本会话允许"之后，同类调用不再重复询问。
// 注意硬拒绝规则由策略层在更早的位置判定，这里只减少重复打扰。
const sessionGrants = new Set<string>()

const APPROVAL_TIMEOUT_MS = 120_000
let approvalSeq = 0

/**
 * 向主进程申请一次审批，并挂起等待回执。
 *
 * 执行器不直接接触界面：它只把 approval-request 发给主进程，由主进程决定怎么呈现
 * （有窗口就转给界面，没有窗口就直接回 deny）。回执由主进程签发，执行器只是等待方。
 *
 * 挂起在两处结束：
 * - 收到 approval-result：按 once / session / deny 决定是否放行；
 * - 120s 没有回执：按拒绝处理，没人确认就不执行。
 *
 * 另外，本会话已授权过同名工具时直接放行——这只是减少重复打扰，硬拒绝仍由策略层先判定。
 */
function requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
  // 本会话已授权过同类工具，不再重复询问（硬拒绝仍由策略层优先判定）
  if (sessionGrants.has(request.tool)) return Promise.resolve({ decision: 'approved' })

  const requestId = `ap-${++approvalSeq}`

  return new Promise<ApprovalOutcome>((resolve) => {
    // 超时按拒绝处理：没人确认就不执行，默认值必须站在安全一侧
    const timer = setTimeout(() => {
      pendingApprovalWaiters.delete(requestId)
      store.appendEvent({
        runId: request.runId,
        conversationId: runConversations.get(request.runId),
        type: 'approval-decided',
        payload: { requestId, tool: request.tool, decision: 'timeout' },
      })
      resolve({ decision: 'denied', reason: '审批超时' })
    }, APPROVAL_TIMEOUT_MS)

    pendingApprovalWaiters.set(requestId, {
      runId: request.runId,
      resolve: (decision, reason) => {
        clearTimeout(timer)
        // write_memory 不参与「本会话允许」：一次授权会让后续所有记忆写入静默通过。
        // 界面已隐藏该按钮；这里仍按一次处理（防御旧客户端或手工回执）。
        if (decision === 'session' && request.tool !== 'write_memory') {
          sessionGrants.add(request.tool)
        }

        // 审计：用户到底选了什么（deny / once / session）
        store.appendEvent({
          runId: request.runId,
          conversationId: runConversations.get(request.runId),
          type: 'approval-decided',
          payload: { requestId, tool: request.tool, decision },
        })

        resolve(
          decision === 'deny'
            ? { decision: 'denied', reason: reason ?? '用户拒绝' }
            : { decision: 'approved' },
        )
      },
    })

    log.info('等待审批', { requestId, tool: request.tool, runId: request.runId })
    store.appendEvent({
      runId: request.runId,
      conversationId: runConversations.get(request.runId),
      type: 'approval-requested',
      payload: { requestId, tool: request.tool, args: request.args, reason: request.reason },
    })
    parentPort.postMessage({
      type: 'approval-request',
      requestId,
      runId: request.runId,
      tool: request.tool,
      args: request.args,
      reason: request.reason,
    })
  })
}

// 纯 CPU 忙等：用来对照"在主进程里做重活"会发生什么
function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 空转
  }
}

parentPort.on('message', async (event) => {
  // 跨边界的数据一律先校验，不假设对面送来的形状
  const parsed = ExecutorRequest.safeParse(event.data)
  if (!parsed.success) {
    console.error('[executor] 无法识别的消息:', parsed.error.issues)
    return
  }
  const message = parsed.data

  switch (message.type) {
    case 'crash':
      // 故意抛未捕获异常：走的是真实崩溃路径，日志与 crash-*.json 才会被写出。
      // （直接 process.exit(1) 不会触发 uncaughtException，就绕过了崩溃报告）
      throw new Error('执行器被要求崩溃（演示）')

    case 'busy': {
      const started = Date.now()
      busyWait(message.ms)
      parentPort.postMessage({ id: message.id, pid: process.pid, elapsed: Date.now() - started })
      break
    }

    // 主进程把用户的选择送回来了，唤醒对应的等待者
    case 'approval-result': {
      const pending = pendingApprovalWaiters.get(message.requestId)
      if (!pending) break
      pendingApprovalWaiters.delete(message.requestId)
      pending.resolve(message.decision)
      break
    }

    // 取消：中断该运行的模型请求，并把它的待审批请求按拒绝唤醒
    case 'cancel': {
      const controller = runs.get(message.runId)
      if (!controller) break
      controller.abort()

      for (const [requestId, pending] of pendingApprovalWaiters) {
        if (pending.runId !== message.runId) continue
        pendingApprovalWaiters.delete(requestId)
        pending.resolve('deny', '运行已取消')
      }
      break
    }

    // 软删会话：写库只在这里（唯一写者）。运行中的会话删不得——
    // run 收尾的落库与索引会把行"复活"。除此之外总是执行删除：
    // deleteConversation 幂等，重复请求顺带清掉旧版本删除残留的业务事件
    // （已删除的会话在侧栏点不到，残留只能靠幂等重删来收尾）
    case 'create-conversation': {
      try {
        mkdirSync(message.workspaceRoot, { recursive: true })
        // 默认标题取目录名：新建后侧栏不是"未命名会话"，而是用户刚选的目录
        const title = message.title.trim() || path.basename(message.workspaceRoot) || '未命名会话'
        store.ensureConversation(message.conversationId, title, message.workspaceRoot)
        parentPort.postMessage({ id: message.id, status: 'created' })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        log.error('新建会话失败', { conversationId: message.conversationId, detail })
        parentPort.postMessage({ id: message.id, status: 'error', message: detail })
      }
      break
    }

    case 'delete-conversation': {
      const isRunning = [...runConversations.values()].includes(message.conversationId)
      if (isRunning) {
        parentPort.postMessage({ id: message.id, status: 'run-active' })
        break
      }

      // 标题读得到 = 这次真的删掉了一个活会话 → 写墓碑；
      // 已删除/不存在的会话不写（旧墓碑也不会被 store 层的删除抹掉）
      const title = store.loadConversationTitle(message.conversationId)
      store.deleteConversation(message.conversationId)
      if (title !== null) {
        store.appendEvent({
          conversationId: message.conversationId,
          type: 'conversation-deleted',
          payload: { conversationId: message.conversationId, title },
        })
      }
      log.info('会话删除已执行（幂等）', { conversationId: message.conversationId })
      parentPort.postMessage({ id: message.id, status: 'deleted' })
      break
    }

    // 记忆管理：编辑允许在运行中进行（当前 run 使用旧快照，下一次选择用新正文）；
    // 删除在任意 run 进行中拒绝——已选中的记忆可能还在当前 run 的 system prompt 里，
    // 删掉后继续引用会造成"已删除但仍被使用"的语义混乱。
    case 'update-memory': {
      try {
        const result = await memoryManagement.update({
          name: message.name,
          description: message.description,
          type: message.memoryType,
          body: message.body,
          expectedUpdatedAt: message.expectedUpdatedAt,
        })
        parentPort.postMessage(
          result.status === 'updated'
            ? { id: message.id, status: 'updated', item: result.document }
            : result.status === 'conflict'
              ? { id: message.id, status: 'conflict', current: result.current }
              : { id: message.id, status: 'not-found' },
        )
      } catch (error) {
        log.error('记忆更新失败', {
          name: message.name,
          message: error instanceof Error ? error.message : String(error),
        })
        parentPort.postMessage({ id: message.id, status: 'internal' })
      }
      break
    }

    case 'delete-memory': {
      if (runs.size > 0) {
        parentPort.postMessage({ id: message.id, status: 'run-active' })
        break
      }
      try {
        const result = await memoryManagement.delete(message.name, message.expectedUpdatedAt)
        parentPort.postMessage(
          result.status === 'deleted'
            ? { id: message.id, status: 'deleted' }
            : result.status === 'conflict'
              ? { id: message.id, status: 'conflict', current: result.current }
              : { id: message.id, status: 'not-found' },
        )
      } catch (error) {
        log.error('记忆删除失败', {
          name: message.name,
          message: error instanceof Error ? error.message : String(error),
        })
        parentPort.postMessage({ id: message.id, status: 'internal' })
      }
      break
    }

    case 'ask': {
      const controller = new AbortController()
      runs.set(message.runId, controller)

      // 从库里取历史与工作区：工作区在"新建会话"时由用户选择并落库
      runConversations.set(message.runId, message.conversationId)
      const workspaceRoot = store.loadConversationWorkspace(message.conversationId)
      if (!workspaceRoot) {
        log.error('会话缺少工作区', { conversationId: message.conversationId })
        parentPort.postMessage({
          runId: message.runId,
          event: { type: 'error', runId: message.runId, message: '会话缺少工作区，请重新新建会话' },
        })
        store.finishRun(message.runId, { status: 'failed', error: '会话缺少工作区' })
        runs.delete(message.runId)
        break
      }
      const history = store.loadMessages(message.conversationId)
      store.updateConversationTitleIfEmpty(message.conversationId, message.prompt.slice(0, 40))
      store.startRun({
        id: message.runId,
        conversationId: message.conversationId,
        prompt: message.prompt,
      })
      store.appendEvent({
        runId: message.runId,
        conversationId: message.conversationId,
        type: 'run-started',
        payload: { prompt: message.prompt },
      })

      void Promise.resolve()
        .then(() => {
          const emit = (event: AgentEvent): void => {
            parentPort.postMessage({ runId: message.runId, event })
          }

          // 工具生命周期 hooks：审计与界面事件都在这里，run-agent 不再手写工具装饰。
          const hooks = new HookManager()
          hooks.registerPreToolUse(({ toolName, args }) => {
            const input = JSON.stringify(args)
            store.appendEvent({
              runId: message.runId,
              conversationId: message.conversationId,
              type: 'tool-call',
              payload: { name: toolName, input },
            })
            emit({ type: 'tool-call', runId: message.runId, name: toolName, input })
          })
          hooks.registerPostToolUse(({ toolName, result, isError }) => {
            store.appendEvent({
              runId: message.runId,
              conversationId: message.conversationId,
              type: 'tool-result',
              payload: { name: toolName, result, isError },
            })
            emit({ type: 'tool-result', runId: message.runId, name: toolName, result, isError })
          })
          hooks.registerToolDenied(({ toolName, args, stage, reason }) => {
            store.appendEvent({
              runId: message.runId,
              conversationId: message.conversationId,
              type: 'tool-denied',
              payload: {
                name: toolName,
                input: JSON.stringify(args),
                stage,
                reason,
              },
            })
            emit({ type: 'tool-denied', runId: message.runId, name: toolName, stage, reason })
          })
          hooks.registerStop(({ rounds }) => {
            log.info('Agent 循环结束', { runId: message.runId, rounds })
          })

          // 记忆运行时绑定本次 run：选择/读取/写入的审计都在这里。
          const memory = createMemoryRuntime({
            store,
            provider: embeddingProvider,
            selectorModel: memorySelectorModel,
            onMemoryUsed: (payload) => {
              store.appendEvent({
                runId: message.runId,
                conversationId: message.conversationId,
                type: 'memory-used',
                payload,
              })
            },
            onMemoryWritten: (payload) => {
              store.appendEvent({
                runId: message.runId,
                conversationId: message.conversationId,
                type: 'memory-written',
                payload,
              })
            },
          })

          return runAgentTask({
            runId: message.runId,
            prompt: message.prompt,
            history,
            workspaceRoot,
            requestApproval,
            // 检索绑定到本次 run：retrieval 审计事件要能回答"这次检索服务于谁"
            searchConversationHistory: (query, topK) =>
              searchConversationHistory({
                query,
                topK,
                provider: embeddingProvider,
                store,
                runId: message.runId,
                conversationId: message.conversationId,
                rerank: rerankStage,
              }),
            memory,
            hooks,
            signal: controller.signal,
            emit,
          })
        })
        .then((messages) => {
          // runAgentTask 返回的是"历史 + 本轮"的完整列表，只追加新增部分，
          // 否则每次运行都会把整段历史重复写一遍
          const newMessages = messages.slice(history.length)
          store.appendMessages(message.conversationId, newMessages)
          store.finishRun(message.runId, { status: 'done' })
          store.appendEvent({
            runId: message.runId,
            conversationId: message.conversationId,
            type: 'run-finished',
            payload: { status: 'done' },
          })

          // 本轮对话进检索语料（消息落库即索引，天然增量；标题解析在 knowledge 层）。
          // 索引是增强动作：回答已交付，失败只记日志，不让已完成的运行变成失败
          void indexCompletedRun({
            provider: embeddingProvider,
            store,
            conversationId: message.conversationId,
            messages: newMessages,
          }).catch((error: unknown) => {
            log.warn('索引本轮对话失败', {
              runId: message.runId,
              message: error instanceof Error ? error.message : String(error),
            })
          })
        })
        .catch((error: unknown) => {
          // 主动取消不是错误：通知界面"已停止"，而不是弹一条报错
          // 三种收尾分开记：取消是用户意图，失败是错误，done 才是正常完成
          if (controller.signal.aborted) {
            store.finishRun(message.runId, { status: 'cancelled' })
            store.appendEvent({
              runId: message.runId,
              conversationId: message.conversationId,
              type: 'run-finished',
              payload: { status: 'cancelled' },
            })
            parentPort.postMessage({
              runId: message.runId,
              event: { type: 'cancelled', runId: message.runId },
            })
            return
          }

          const detail = error instanceof Error ? error.message : String(error)
          store.finishRun(message.runId, { status: 'failed', error: detail })
          store.appendEvent({
            runId: message.runId,
            conversationId: message.conversationId,
            type: 'run-finished',
            payload: { status: 'failed', error: detail },
          })
          parentPort.postMessage({
            runId: message.runId,
            event: { type: 'error', runId: message.runId, message: detail },
          })
        })
        .finally(() => {
          runs.delete(message.runId)
          runConversations.delete(message.runId)
        })
      break
    }
  }
})
