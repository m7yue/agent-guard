// effect handler 的装配：把模型、记忆、工具、hooks、审批接到业务 loop 的副作用上。
//
// 这里不判断权限、不写审计、不拼提示词——那些分别属于 hooks / MemoryRuntime / agent-prompt。
// 每个 handler 只做“这个 effect 怎么执行”。
import type { EffectHandlers } from './core/effects'
import type { Model } from './core/types'
import type { AgentEffect, ApprovalOutcome } from './agent-loop'
import type { HookManager } from './hooks'
import { toMemoryRelevantText } from './memory/memory-document'
import { createToolHandlers } from './tools/manifest'
import type { ToolContext } from './tools/types'

export interface ApprovalRequest {
  runId: string
  /** 请求审批的工具名 */
  tool: string
  /** 工具原始入参 */
  args: Record<string, unknown>
  /** 权限管线给出的原因 */
  reason: string
}

export interface AgentHandlerDeps {
  /** 本次运行 id，审批请求要带 */
  runId: string
  /** 主模型 */
  model: Model
  /** 工具 handler 的能力上下文；memory 也由这里提供 */
  toolContext: ToolContext
  /** 权限/审计/事件钩子 */
  hooks: HookManager
  /** 向用户请求审批；ask 才会走到这里 */
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalOutcome>
  /** 流式 token 出口 */
  onToken?: (text: string) => void
  /** 取消信号 */
  signal?: AbortSignal
  /** 循环日志出口 */
  log: (message: string) => void
}

export function createAgentHandlers(deps: AgentHandlerDeps): EffectHandlers<AgentEffect> {
  return {
    ReadMemoryIndex: () => deps.toolContext.memory.readIndex(),

    SelectMemoryForRun: async (effect) => {
      const selection = await deps.toolContext.memory.select(effect.input.context, 'selected')
      return toMemoryRelevantText(selection.selected.map((item) => item.document))
    },

    Model: (effect) =>
      deps.model.complete({
        ...effect.input,
        onToken: deps.onToken,
        signal: deps.signal,
      }),

    Log: (effect) => {
      deps.log(effect.input.message)
    },

    PreToolUse: (effect) =>
      deps.hooks.runPreToolUse({
        toolName: effect.input.name,
        args: effect.input.args,
      }),

    Approval: (effect) => {
      const { name, args } = effect.input.payload
      return deps.requestApproval({
        runId: deps.runId,
        tool: name,
        args,
        reason: effect.input.reason,
      })
    },

    ToolDenied: (effect) =>
      deps.hooks.runToolDenied({
        toolName: effect.input.name,
        args: effect.input.args,
        stage: effect.input.stage,
        reason: effect.input.reason,
      }),

    ...createToolHandlers(deps.toolContext),

    PostToolUse: (effect) =>
      deps.hooks.runPostToolUse({
        toolName: effect.input.name,
        args: effect.input.args,
        result: effect.input.result,
        isError: effect.input.isError,
      }),

    Stop: (effect) =>
      deps.hooks.runStop({
        rounds: effect.input.rounds,
        messages: effect.input.messages,
      }),
  }
}
