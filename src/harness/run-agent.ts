// 一次 Agent 运行的组合根：只接线，不承载业务流程。
//
// 业务顺序在 agentLoop 里；副作用实现在 agent-handlers / MemoryRuntime / 工具 effect handlers；
// 横切逻辑在 hooks。这里只负责把它们装起来，并发出运行级事件。
import { agentLoop, type ApprovalOutcome } from './agent-loop'
import { createAgentHandlers, type ApprovalRequest } from './agent-handlers'
import { buildAgentSystemPrompt } from './agent-prompt'
import { runEffects } from './core/effects'
import { textOf } from './core/types'
import { HookManager } from './hooks'
import type { MemoryRuntime } from './memory/runtime'
import { NO_MEMORY } from './memory/runtime'
import { createModel } from './model'
import { checkPermission } from './permission'
import { toolDefinitions } from './tools/manifest'
import type { ToolContext } from './tools/types'
import type { ConversationSearchOutcome } from './knowledge/searcher'
import type { AgentEvent } from '../shared/agent-event'
import type { Message, Model } from './core/types'

export type { ApprovalRequest } from './agent-handlers'
export type { ApprovalOutcome } from './agent-loop'

export interface RunAgentTaskOptions {
  runId: string
  prompt: string
  /** 上一轮结束时的完整消息列表 */
  history: Message[]
  workspaceRoot: string
  emit: (event: AgentEvent) => void
  /** 由调用方决定怎么问用户（弹窗 / 自动拒绝） */
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalOutcome>
  /**
   * 跨会话历史检索（执行器绑定 runId 审计上下文后注入）：
   * search_conversations 工具的执行体。
   */
  searchConversationHistory: (query: string, topK: number) => Promise<ConversationSearchOutcome>
  /** 记忆能力；不传时用 NO_MEMORY（loop 仍然声明 ReadMemoryIndex / SelectMemoryForRun） */
  memory?: MemoryRuntime
  /**
   * 权限/审计/事件钩子。调用方按 run 创建并注册横切 hook；
   * runAgentTask 会追加权限 hook（checkPermission），保证权限不会被漏掉。
   */
  hooks?: HookManager
  /** 取消信号：页面点"停止"时传进来 */
  signal?: AbortSignal
  /** 覆盖模型。评测需要注入 ScriptedModel 或带观测的模型；不传时走 createModel() */
  model?: Model
  /** 覆盖最大轮次。评测任务可以按自己的预算配置；不传时保持 6 轮 */
  maxTurns?: number
}

export async function runAgentTask(options: RunAgentTaskOptions): Promise<Message[]> {
  const {
    runId,
    prompt,
    history,
    workspaceRoot,
    emit,
    requestApproval,
    searchConversationHistory,
    signal,
  } = options

  const memory = options.memory ?? NO_MEMORY
  const hooks = options.hooks ?? new HookManager()
  // 权限 hook 由组合根统一追加：调用方不用记得注册，也不会忘记。
  hooks.registerPreToolUse(({ toolName, args }) =>
    checkPermission(toolName, args, workspaceRoot),
  )

  const model = options.model ?? createModel()
  const toolContext: ToolContext = { workspaceRoot, memory, searchConversationHistory }

  const handlers = createAgentHandlers({
    runId,
    model,
    toolContext,
    hooks,
    requestApproval,
    onToken: (text) => emit({ type: 'token', runId, text }),
    signal,
    log: (message) => emit({ type: 'log', runId, message }),
  })

  const messages = await runEffects(
    agentLoop({
      prompt,
      history,
      tools: toolDefinitions(),
      maxTurns: options.maxTurns ?? 6,
      buildSystemPrompt: buildAgentSystemPrompt,
    }),
    handlers,
  )

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  emit({ type: 'done', runId, text: lastAssistant ? textOf(lastAssistant) : '' })

  // 把这一轮的完整消息交回给调用方，由它写入会话
  return messages
}
