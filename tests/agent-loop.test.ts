import { describe, expect, it } from 'vitest'
import { agentLoop, type AgentEffectHandlers } from '../src/harness/agent-loop'
import { runEffects } from '../src/harness/core/effects'
import type { ModelTurn } from '../src/harness/core/types'
import type { PermissionResult } from '../src/harness/permission'
import { NO_MEMORY } from '../src/harness/memory/runtime'
import { toolDefinitions, toolModules, type ToolHandlers, type ToolEffect } from '../src/harness/tools/manifest'
import { readFileTool } from '../src/harness/tools/read-file'
import { ScriptedModel, finalTurn, toolTurn } from '../src/harness/model/scripted-model'

// 编译期守卫：manifest 推导出的 ToolEffect 必须是有限字面量 union，不能退化为 string。
// @ts-expect-error mystery_tool 不在工具 effect 集合里
const invalidToolEffect: ToolEffect = { type: 'mystery_tool', input: {}, output: '' }
void invalidToolEffect

interface HandlerOptions {
  /** Approval 的裁决；只有 preDecision=ask 时才会用到 */
  approve?: boolean
  /** PreToolUse 的权限结论；默认 allow */
  preDecision?: PermissionResult
}

function makeHandlers(model: ScriptedModel, options: HandlerOptions = {}) {
  const toolCalls: string[] = []
  const toolEffects: string[] = []
  const approvals: unknown[] = []
  const denials: Array<{ name: string; stage: string; reason: string }> = []
  const postToolResults: Array<{ toolName: string; result: string; isError: boolean }> = []

  const handlers: AgentEffectHandlers = {
    ReadMemoryIndex: () => '',
    SelectMemoryForRun: () => '',
    Model: (effect) =>
      model.complete({
        system: effect.input.system,
        messages: effect.input.messages,
        tools: effect.input.tools,
      }),
    Log: () => {},
    PreToolUse: () => options.preDecision ?? { decision: 'allow', reason: '允许' },
    Approval: (effect) => {
      approvals.push(effect.input.payload)
      return options.approve
        ? { decision: 'approved' as const }
        : { decision: 'denied' as const, reason: '用户拒绝' }
    },
    ToolDenied: (effect) => {
      denials.push({
        name: effect.input.name,
        stage: effect.input.stage,
        reason: effect.input.reason,
      })
    },
    ReadFile: () => {
      toolEffects.push('ReadFile')
      toolCalls.push('read_file')
      return 'result-of-read_file'
    },
    WriteFile: () => {
      toolEffects.push('WriteFile')
      return ''
    },
    RunCommand: () => {
      toolEffects.push('RunCommand')
      return ''
    },
    SearchConversations: () => {
      toolEffects.push('SearchConversations')
      return ''
    },
    WriteMemory: () => {
      toolEffects.push('WriteMemory')
      return ''
    },
    ReadMemory: () => {
      toolEffects.push('ReadMemory')
      return ''
    },
    SelectMemory: () => {
      toolEffects.push('SelectMemory')
      return ''
    },
    PostToolUse: (effect) => {
      postToolResults.push({
        toolName: effect.input.name,
        result: effect.input.result,
        isError: effect.input.isError,
      })
    },
    Stop: () => {},
  }

  return { handlers, toolCalls, toolEffects, approvals, denials, postToolResults }
}

const baseOptions = {
  prompt: 'hi',
  history: [] as [],
  tools: toolDefinitions(),
  maxTurns: 6,
  buildSystemPrompt: () => 'sys',
}

describe('agentLoop', () => {
  it('模型不再要工具时返回消息列表', async () => {
    const model = new ScriptedModel([finalTurn('done')])
    const { handlers, toolCalls } = makeHandlers(model)

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(toolCalls).toHaveLength(0)
  })

  it('工具结果以 tool_result 块回灌进对话', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: 'a.txt' }),
      finalTurn('ok'),
    ])
    const { handlers, toolCalls, postToolResults } = makeHandlers(model)

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(toolCalls).toEqual(['read_file'])
    const withResult = messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    )
    expect(JSON.stringify(withResult)).toContain('result-of-read_file')
    expect(postToolResults).toEqual([
      { toolName: 'read_file', result: 'result-of-read_file', isError: false },
    ])
  })

  it('工具抛错时不终止整轮，错误以 isError 回灌', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: 'missing.txt' }),
      finalTurn('ok'),
    ])
    const { handlers, postToolResults } = makeHandlers(model)
    handlers.ReadFile = () => {
      throw new Error('文件不存在')
    }

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    const withResult = messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'tool_result'),
    )
    expect(JSON.stringify(withResult)).toContain('[工具错误] 文件不存在')
    expect(JSON.stringify(withResult)).toContain('"isError":true')
    expect(postToolResults).toEqual([
      { toolName: 'read_file', result: '[工具错误] 文件不存在', isError: true },
    ])
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    })
  })

  it('AbortError 终止 run，不回灌为工具错误', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: 'a.txt' }),
      finalTurn('ok'),
    ])
    const { handlers } = makeHandlers(model)
    handlers.ReadFile = () => {
      const error = new Error('已取消')
      error.name = 'AbortError'
      throw error
    }

    await expect(runEffects(agentLoop(baseOptions), handlers)).rejects.toThrow('已取消')
  })

  it('一轮多个工具：一个失败，另一个继续执行', async () => {
    const multiToolTurn: ModelTurn = {
      stopReason: 'tool_use',
      content: '',
      toolUses: [
        { id: 'first', name: 'read_file', args: { path: 'missing.txt' } },
        { id: 'second', name: 'write_file', args: { path: 'ok.txt', content: 'x' } },
      ],
    }
    const model = new ScriptedModel([multiToolTurn, finalTurn('ok')])
    const { handlers, postToolResults } = makeHandlers(model)
    handlers.ReadFile = () => {
      throw new Error('文件不存在')
    }

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(postToolResults).toEqual([
      { toolName: 'read_file', result: '[工具错误] 文件不存在', isError: true },
      { toolName: 'write_file', result: '', isError: false },
    ])
    expect(JSON.stringify(messages)).toContain('[工具错误] 文件不存在')
  })

  it('真实工具 handler 的 zod 错误经 loop 回灌', async () => {
    const model = new ScriptedModel([toolTurn('read_file', {}), finalTurn('ok')])
    const { handlers, postToolResults } = makeHandlers(model)
    handlers.ReadFile = readFileTool.createHandler({
      workspaceRoot: process.cwd(),
      memory: NO_MEMORY,
      searchConversationHistory: async () => ({ mode: 'vector', hits: [], rerank: null }),
    })

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(JSON.stringify(messages)).toContain('[工具错误] 工具 read_file 入参不合法')
    expect(postToolResults[0]?.isError).toBe(true)
  })

  it('达到轮次上限即停止', async () => {
    const model = new ScriptedModel([toolTurn('read_file', { path: 'a.txt' })])
    const { handlers, toolCalls } = makeHandlers(model)

    await runEffects(agentLoop({ ...baseOptions, maxTurns: 2 }), handlers)

    expect(toolCalls).toHaveLength(2)
  })

  it('deny 不执行工具，把具体理由写回对话', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: '../secret.txt' }),
      finalTurn('ok'),
    ])
    const { handlers, toolCalls, approvals, denials } = makeHandlers(model, {
      preDecision: { decision: 'deny', reason: '命中硬拒绝规则' },
    })

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(approvals).toHaveLength(0)
    expect(toolCalls).toHaveLength(0)
    expect(denials).toEqual([
      { name: 'read_file', stage: 'permission', reason: '命中硬拒绝规则' },
    ])
    expect(JSON.stringify(messages)).toContain('[拒绝] 命中硬拒绝规则')
    expect(JSON.stringify(messages)).toContain('"isError":true')
  })

  it('ask + 拒绝时不执行工具，并把拒绝写回对话', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: 'a.txt' }),
      finalTurn('ok'),
    ])
    const { handlers, toolCalls, approvals, denials } = makeHandlers(model, {
      approve: false,
      preDecision: { decision: 'ask', reason: '需要审批' },
    })

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(approvals).toHaveLength(1)
    expect(toolCalls).toHaveLength(0)
    expect(denials).toEqual([
      { name: 'read_file', stage: 'approval', reason: '用户拒绝' },
    ])
    expect(JSON.stringify(messages)).toContain('[拒绝]')
    expect(JSON.stringify(messages)).toContain('"isError":true')
  })

  it('ask + 通过时才执行工具', async () => {
    const model = new ScriptedModel([
      toolTurn('read_file', { path: 'a.txt' }),
      finalTurn('ok'),
    ])
    const { handlers, toolCalls } = makeHandlers(model, {
      approve: true,
      preDecision: { decision: 'ask', reason: '需要审批' },
    })

    await runEffects(agentLoop(baseOptions), handlers)

    expect(toolCalls).toEqual(['read_file'])
  })

  it('未知工具不执行 effect，把错误写回对话', async () => {
    const model = new ScriptedModel([toolTurn('mystery_tool', {}), finalTurn('ok')])
    const { handlers, toolCalls, denials } = makeHandlers(model)

    const messages = await runEffects(agentLoop(baseOptions), handlers)

    expect(toolCalls).toHaveLength(0)
    expect(denials).toEqual([
      { name: 'mystery_tool', stage: 'unknown', reason: '未知工具: mystery_tool' },
    ])
    expect(JSON.stringify(messages)).toContain('[未知工具] mystery_tool')
    expect(JSON.stringify(messages)).toContain('"isError":true')
  })

  it('manifest 里的每个工具名映射到对应的 effect 类型', async () => {
    const model = new ScriptedModel([
      ...toolModules.map((tool) => toolTurn(tool.name, {})),
      finalTurn('ok'),
    ])
    const { handlers } = makeHandlers(model)
    const toolEffects: string[] = []
    const toolSpies = Object.fromEntries(
      toolModules.map((tool) => [
        tool.effectType,
        () => {
          toolEffects.push(tool.effectType)
          return ''
        },
      ]),
    ) as unknown as ToolHandlers
    const generatedHandlers: AgentEffectHandlers = { ...handlers, ...toolSpies }

    await runEffects(
      agentLoop({ ...baseOptions, maxTurns: toolModules.length + 1 }),
      generatedHandlers,
    )

    expect(toolEffects).toEqual(toolModules.map((tool) => tool.effectType))
  })
})

describe('多轮历史', () => {
  it('agentLoop 把历史铺在本轮问题之前', async () => {
    const model = new ScriptedModel([finalTurn('你叫小林')])
    const { handlers } = makeHandlers(model)

    const messages = await runEffects(
      agentLoop({
        ...baseOptions,
        prompt: '我叫什么？',
        history: [
          { role: 'user', content: '我叫小林' },
          { role: 'assistant', content: '你好，小林' },
        ],
      }),
      handlers,
    )

    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ role: 'user', content: '我叫小林' })
    expect(messages[2]).toMatchObject({ role: 'user', content: '我叫什么？' })
  })
})
