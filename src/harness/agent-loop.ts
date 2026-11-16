// 业务视角的 agentLoop：这一轮的副作用顺序就是本文件读到的顺序。
//
// 读法：
//   准备记忆（目录 + 选择） → 模型 → 权限/审批 → 工具 → 工具后处理 → 结束
//
// 自动记忆生命周期是 effect；模型主动调用的 write_memory / read_memory / select_memory
// 是工具 effect。工具名（snake_case）到 effect 类型（PascalCase）的映射写在下面的
// switch 里，读这段循环就能看到这一轮可能执行哪些工具。
import type { AgentProgram, Effect, EffectHandlers } from './core/effects'
import type { ContentBlock, Message, ModelTurn, ToolDefinition } from './core/types'
import { toMemoryQueryText } from './memory/memory-selector'
import type { PermissionResult } from './permission'
import { toToolErrorMessage } from './tools/execute-tool'
import type { ToolEffect } from './tools/manifest'

export interface ReadMemoryIndexEffect
  extends Effect<'ReadMemoryIndex', Record<string, never>, string> {}

export interface SelectMemoryForRunEffect
  extends Effect<'SelectMemoryForRun', { context: string }, string> {}

export interface ModelEffect
  extends Effect<
    'Model',
    { system: string; messages: Message[]; tools: ToolDefinition[] },
    ModelTurn
  > {}

export interface LogEffect extends Effect<'Log', { message: string }, void> {}

export interface PreToolUseEffect
  extends Effect<
    'PreToolUse',
    { name: string; args: Record<string, unknown> },
    PermissionResult
  > {}

export type ApprovalOutcome =
  | { decision: 'approved' }
  | { decision: 'denied'; reason: string }

export interface ApprovalEffect
  extends Effect<
    'Approval',
    { reason: string; payload: { name: string; args: Record<string, unknown> } },
    ApprovalOutcome
  > {}

export interface ToolDeniedEffect
  extends Effect<
    'ToolDenied',
    {
      name: string
      args: Record<string, unknown>
      stage: 'permission' | 'approval' | 'unknown'
      reason: string
    },
    void
  > {}

export interface PostToolUseEffect
  extends Effect<
    'PostToolUse',
    {
      name: string
      args: Record<string, unknown>
      result: string
      isError: boolean
    },
    void
  > {}

export interface StopEffect
  extends Effect<'Stop', { rounds: number; messages: Message[] }, void> {}

/** 本轮可能发生的全部副作用；工具 effect 是其中一组 first-class 类型 */
export type AgentEffect =
  | ReadMemoryIndexEffect
  | SelectMemoryForRunEffect
  | ModelEffect
  | LogEffect
  | PreToolUseEffect
  | ApprovalEffect
  | ToolDeniedEffect
  | ToolEffect
  | PostToolUseEffect
  | StopEffect

export type AgentEffectHandlers = EffectHandlers<AgentEffect>

/** 取消信号不当作工具失败：它应该终止 run，而不是回灌给模型。 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

export interface AgentLoopOptions {
  /** 本轮用户问题 */
  prompt: string
  /** 之前的对话（含工具结果） */
  history: Message[]
  /** 给模型看的工具 schema */
  tools: ToolDefinition[]
  /** 最大模型轮次 */
  maxTurns: number
  /** 纯函数：由记忆目录/相关正文拼 system prompt（不产生副作用） */
  buildSystemPrompt: (memoryIndexText: string, memoryRelevantText: string) => string
}

export function agentLoop(options: AgentLoopOptions): AgentProgram<AgentEffect, Message[]> {
  return function* loop(perform) {
    // 每次运行开始：目录常驻 + 自动选择相关记忆。空库时 handler 返回空串，不产生分支。
    const memoryIndexText = yield* perform({ type: 'ReadMemoryIndex', input: {} })
    const memoryRelevantText = yield* perform({
      type: 'SelectMemoryForRun',
      input: { context: toMemoryQueryText(options.prompt, options.history) },
    })
    const system = options.buildSystemPrompt(memoryIndexText, memoryRelevantText)

    const messages: Message[] = [
      ...options.history,
      { role: 'user', content: options.prompt },
    ]

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      const response = yield* perform({
        type: 'Model',
        input: { system, messages, tools: options.tools },
      })

      // assistant 这一轮说了什么：文本 + 它发起的工具调用，都要原样留在对话里
      const assistantBlocks: ContentBlock[] = []
      if (response.content) assistantBlocks.push({ type: 'text', text: response.content })
      for (const call of response.toolUses ?? []) {
        assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args })
      }
      messages.push({
        role: 'assistant',
        content: assistantBlocks.length > 0 ? assistantBlocks : '',
      })

      if (response.stopReason !== 'tool_use' || !response.toolUses?.length) {
        yield* perform({ type: 'Log', input: { message: `循环结束: ${response.stopReason}` } })
        yield* perform({ type: 'Stop', input: { rounds: turn + 1, messages } })
        return messages
      }

      const resultBlocks: ContentBlock[] = []

      for (const call of response.toolUses) {
        // 权限/审计/事件先过 PreToolUse；allow 直接执行，ask 才进审批，deny 直接拒绝
        const pre = yield* perform({
          type: 'PreToolUse',
          input: { name: call.name, args: call.args },
        })
        if (pre.decision === 'deny') {
          yield* perform({
            type: 'ToolDenied',
            input: {
              name: call.name,
              args: call.args,
              stage: 'permission',
              reason: pre.reason,
            },
          })
          resultBlocks.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: `[拒绝] ${pre.reason}`,
            isError: true,
          })
          continue
        }

        if (pre.decision === 'ask') {
          const approval = yield* perform({
            type: 'Approval',
            input: { reason: pre.reason, payload: { name: call.name, args: call.args } },
          })
          if (approval.decision === 'denied') {
            const reason = approval.reason
            yield* perform({
              type: 'ToolDenied',
              input: {
                name: call.name,
                args: call.args,
                stage: 'approval',
                reason,
              },
            })
            resultBlocks.push({
              type: 'tool_result',
              toolUseId: call.id,
              content: `[拒绝] ${reason}`,
              isError: true,
            })
            continue
          }
        }

        // 工具名 → first-class effect：每个工具一个 case，读这里就知道本轮能执行什么。
        // 执行由 agent-handlers 中同名的 effect handler 负责；未知工具不执行 effect。
        // 工具失败回灌给模型，让它可以换参数/换工具；控制面错误继续向上抛。
        let output: string
        let isError = false
        let unknownToolReason: string | null = null
        try {
          switch (call.name) {
            case 'read_file':
              output = yield* perform({ type: 'ReadFile', input: call.args })
              break
            case 'write_file':
              output = yield* perform({ type: 'WriteFile', input: call.args })
              break
            case 'run_command':
              output = yield* perform({ type: 'RunCommand', input: call.args })
              break
            case 'search_conversations':
              output = yield* perform({ type: 'SearchConversations', input: call.args })
              break
            case 'write_memory':
              output = yield* perform({ type: 'WriteMemory', input: call.args })
              break
            case 'read_memory':
              output = yield* perform({ type: 'ReadMemory', input: call.args })
              break
            case 'select_memory':
              output = yield* perform({ type: 'SelectMemory', input: call.args })
              break
            default:
              isError = true
              output = `[未知工具] ${call.name}`
              unknownToolReason = `未知工具: ${call.name}`
          }
        } catch (error) {
          if (isAbortError(error)) throw error
          isError = true
          const message = toToolErrorMessage(error)
          output = `[工具错误] ${message}`
          yield* perform({
            type: 'Log',
            input: { message: `工具失败: ${call.name}: ${message}` },
          })
        }
        // 未知工具不是工具实现抛错，但同属“这次调用没有成功”；审计钩子放在 catch 外，
        // 避免 ToolDenied hook 自身的错误被当成工具错误回灌。
        if (unknownToolReason) {
          yield* perform({
            type: 'ToolDenied',
            input: {
              name: call.name,
              args: call.args,
              stage: 'unknown',
              reason: unknownToolReason,
            },
          })
        }
        yield* perform({
          type: 'PostToolUse',
          input: { name: call.name, args: call.args, result: output, isError },
        })
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: output,
          isError,
        })
      }

      messages.push({ role: 'user', content: resultBlocks })
    }

    yield* perform({ type: 'Log', input: { message: '达到最大轮次' } })
    yield* perform({ type: 'Stop', input: { rounds: options.maxTurns, messages } })
    return messages
  }
}
