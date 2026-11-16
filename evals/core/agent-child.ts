// 评测子进程：在指定临时工作区里跑一次 agent，写出轨迹与结果。
//
// 独立进程的原因：
// - 父进程可以用 timeout 硬杀 agent 子进程（不保证清理其派生的 shell 子进程）；
// - 每个 trial 的模型与工具状态完全隔离；
// - 轨迹边跑边落盘，超时被杀时父进程仍能读到已发生的事件。
//
// mock 模式替换模型与 embedding provider；工具、权限、工作区隔离与检索代码路径仍是生产实现。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { FakeEmbeddingProvider } from '../../src/harness/knowledge/fake-embedding-provider'
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
} from '../../src/harness/knowledge/embedding-provider'
import { searchConversationHistory } from '../../src/harness/knowledge/searcher'
import { createMemorySelectorModel } from '../../src/harness/memory/memory-text-model'
import { createMemoryRuntime } from '../../src/harness/memory/runtime'
import { writeMemoryDocument } from '../../src/harness/memory/memory-writer'
import { HookManager } from '../../src/harness/hooks'
import { AnthropicModel } from '../../src/harness/model/anthropic-model'
import { getModelConfig } from '../../src/harness/model/config'
import { ScriptedModel, finalTurn, toolTurn } from '../../src/harness/model/scripted-model'
import { runAgentTask, type ApprovalOutcome, type ApprovalRequest } from '../../src/harness/run-agent'
import { openStore } from '../../src/harness/store'
import { textOf, type Message, type Model, type ModelInput, type ModelTurn } from '../../src/harness/core/types'
import { indexRetrievalCorpus } from '../suites/retrieval/index-corpus'
import { renderValue, type RenderValues } from './render'
import { appendTraceEvent } from './trace'
import type { LoadedTask } from './types'
import type { ScriptStep } from './task-definition'
import type { AgentEvent } from '../../src/shared/agent-event'
import { loadTask } from './task-loader'
import type {
  AgentRunResult,
  ModelTraceEvent,
  RunMode,
  ScriptName,
  TraceEvent,
} from './types'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'task-id': { type: 'string' },
      workspace: { type: 'string' },
      outside: { type: 'string' },
      'prompt-file': { type: 'string' },
      mode: { type: 'string', default: 'mock' },
      script: { type: 'string', default: 'correct' },
      'result-file': { type: 'string' },
      'trace-file': { type: 'string' },
      'max-turns': { type: 'string' },
    },
  })

  const taskId = requireArg(values['task-id'], 'task-id')
  const workspace = requireArg(values.workspace, 'workspace')
  const outside = requireArg(values.outside, 'outside')
  const promptFile = requireArg(values['prompt-file'], 'prompt-file')
  const resultFile = requireArg(values['result-file'], 'result-file')
  const traceFile = requireArg(values['trace-file'], 'trace-file')
  const mode = parseMode(values.mode)
  const script = parseScript(values.script)

  const task = loadTask(taskId)
  const prompt = readFileSync(promptFile, 'utf8')
  const renderValues: RenderValues = { WORKSPACE: workspace, OUTSIDE: outside }
  const maxTurns = parseMaxTurns(values['max-turns'], task.maxTurns)

  const trace: TraceEvent[] = []
  const pushTraceEvent = (event: TraceEvent): void => {
    trace.push(event)
    appendTraceEvent(traceFile, event)
  }

  const startedAt = performance.now()
  const store = openStore(':memory:')
  try {
    const provider = createRetrievalProvider(mode)
    if (task.shouldIndexRetrievalCorpus) {
      await indexRetrievalCorpus(provider, store)
    }

    // 任务预置记忆：与生产同一条写入路径（落库 + 建索引）。
    // mock 用 fake embedding，real 用真实 provider；记忆条数很少，开销可接受。
    for (const memory of task.memories ?? []) {
      await writeMemoryDocument(memory, { store, provider })
    }

    // mock 选择器只回放任务声明的 JSON；real 模式用真实模型（与主循环分开调用）。
    const selectorModel =
      mode === 'mock'
        ? { completeText: async (): Promise<string> => task.selectorResponse ?? '[]' }
        : createMemorySelectorModel()

    const model = buildModel(mode, script, task, renderValues)
    const observedModel = observeModel(model, pushTraceEvent)
    const pendingTools: Array<{ name: string; args: Record<string, unknown>; startedAt: number }> = []

    // 工具 trace 走 hooks：pre 记开始，post 记结果；run-agent 内部会再追加权限 hook。
    const hooks = new HookManager()
    hooks.registerPreToolUse(({ toolName, args }) => {
      pendingTools.push({ name: toolName, args, startedAt: performance.now() })
    })
    hooks.registerPostToolUse(({ toolName, result, isError }) => {
      const pendingIndex = pendingTools.findIndex((item) => item.name === toolName)
      const pending = pendingIndex >= 0 ? pendingTools.splice(pendingIndex, 1)[0] : undefined
      pushTraceEvent({
        type: 'tool',
        name: toolName,
        args: pending?.args ?? {},
        result,
        isError,
        durationMs: pending ? performance.now() - pending.startedAt : 0,
      })
    })
    hooks.registerToolDenied(({ toolName, args, stage, reason }) => {
      pushTraceEvent({ type: 'tool-denied', name: toolName, args, stage, reason })
    })

    const emit = (event: AgentEvent): void => {
      if (event.type === 'log') pushTraceEvent({ type: 'log', message: event.message })
    }

    const memory = createMemoryRuntime({
      store,
      provider,
      selectorModel,
      onMemoryUsed: (payload) => pushTraceEvent({ type: 'memory-used', ...payload }),
      onMemoryWritten: (payload) => pushTraceEvent({ type: 'memory-written', ...payload }),
    })

    const requestApproval = async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      // 评测里的"用户"由任务定义决定；ask 才会走到这里，deny 已在 runAgentTask 里短路
      const approved = task.approval === 'grant'
      pushTraceEvent({
        type: 'approval',
        decision: 'ask',
        toolName: request.tool,
        args: request.args,
        approved,
        reason: request.reason,
      })
      return approved
        ? { decision: 'approved' }
        : { decision: 'denied', reason: '用户拒绝' }
    }

    const messages = await runAgentTask({
      runId: `${task.id}-${Date.now()}`,
      prompt,
      history: [],
      workspaceRoot: workspace,
      emit,
      requestApproval,
      searchConversationHistory: async (query, topK) => {
        const outcome = await searchConversationHistory({
          query,
          topK,
          provider,
          store,
          runId: `${task.id}-retrieval`,
          conversationId: task.id,
        })
        pushTraceEvent({
          type: 'retrieval',
          query,
          topK,
          mode: outcome.mode,
          hits: outcome.hits.map((hit) => ({
            source: `${hit.title}#${hit.chunkIndex}`,
            score: hit.score,
            text: hit.text,
          })),
        })
        return outcome
      },
      memory,
      hooks,
      model: observedModel,
      maxTurns,
    })

    const finalAnswer = lastAssistantText(messages)
    const memories = store.listMemories().map(({ name, description, type }) => ({
      name,
      description,
      memoryType: type,
    }))
    writeResult(resultFile, {
      status: 'ok',
      finalAnswer,
      tokens: sumTokens(trace),
      durationMs: performance.now() - startedAt,
      truncated: trace.some((event) => event.type === 'model' && event.stopReason === 'max_tokens'),
      trace,
      memories,
    })
  } catch (error) {
    writeResult(resultFile, {
      status: 'error',
      finalAnswer: '',
      tokens: sumTokens(trace),
      durationMs: performance.now() - startedAt,
      truncated: trace.some((event) => event.type === 'model' && event.stopReason === 'max_tokens'),
      trace,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    store.close()
  }
}

/** mock 回放任务脚本并替换 embedding provider；real 走真实模型，缺配置直接失败。 */
function buildModel(
  mode: RunMode,
  script: ScriptName,
  task: LoadedTask,
  values: RenderValues,
): Model {
  if (mode === 'mock') {
    const steps = script === 'wrong' ? task.mockWrongTurns : task.mockCorrectTurns
    return new ScriptedModel(toModelTurns(steps, values))
  }

  // 离线保险：即使调用方误传 --real，也不能发请求
  if (process.env.EVAL_OFFLINE === '1') {
    throw new Error('EVAL_OFFLINE=1，拒绝在离线模式使用真实模型')
  }
  const modelConfig = getModelConfig()
  if (!modelConfig) {
    throw new Error('real 模式缺少 AGENTGUARD_MODEL_AUTH_TOKEN / AGENTGUARD_MODEL_ID')
  }
  return new AnthropicModel(modelConfig)
}

function createRetrievalProvider(mode: RunMode): EmbeddingProvider {
  // mock 模式不读 .env 的 provider，保证离线且可重复
  if (mode === 'mock') return new FakeEmbeddingProvider('fake-embedding', 1024, 32)
  return createEmbeddingProvider()
}

/** 包一层模型只做观测，不改请求内容。 */
function observeModel(model: Model, pushTraceEvent: (event: TraceEvent) => void): Model {
  let turn = 0
  return {
    mode: model.mode,
    async complete(input: ModelInput): Promise<ModelTurn> {
      const startedAt = performance.now()
      const response = await model.complete(input)
      turn += 1
      pushTraceEvent({
        type: 'model',
        turn,
        stopReason: response.stopReason,
        content: response.content,
        requestedTools: response.toolUses?.map((call) => call.name) ?? [],
        usage: response.usage,
        durationMs: performance.now() - startedAt,
      })
      return response
    },
  }
}

function toModelTurns(steps: ScriptStep[], values: RenderValues): ModelTurn[] {
  return steps.map((step) => {
    if ('tool' in step) {
      return toolTurn(step.tool, renderValue(step.args, values) as Record<string, unknown>)
    }
    return finalTurn(step.answer)
  })
}

function lastAssistantText(messages: Message[]): string {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  return lastAssistant ? textOf(lastAssistant) : ''
}

/** 汇总 token；没有 usage 时返回 null，不按 0 冒充。 */
function sumTokens(trace: TraceEvent[]): AgentRunResult['tokens'] {
  const usages = trace.filter(
    (event): event is ModelTraceEvent => event.type === 'model' && event.usage !== undefined,
  )
  if (usages.length === 0) return null
  return {
    input: usages.reduce((sum, event) => sum + (event.usage?.inputTokens ?? 0), 0),
    output: usages.reduce((sum, event) => sum + (event.usage?.outputTokens ?? 0), 0),
  }
}

/** 成功和失败都写结果文件；先写临时文件再改名，父进程不会读到半份 JSON。 */
function writeResult(filePath: string, result: AgentRunResult): void {
  const temporaryPath = `${filePath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  renameSync(temporaryPath, filePath)
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少参数 --${name}`)
  return value
}

function parseMode(value: string | undefined): RunMode {
  if (value === 'real' || value === 'mock') return value
  throw new Error(`--mode 只能是 real 或 mock，收到: ${value}`)
}

function parseScript(value: string | undefined): ScriptName {
  if (value === 'correct' || value === 'wrong') return value
  throw new Error(`--script 只能是 correct 或 wrong，收到: ${value}`)
}

function parseMaxTurns(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--max-turns 必须是正整数，收到: ${value}`)
  }
  return parsed
}

void main().catch((error) => {
  console.error(`[eval-child] ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
