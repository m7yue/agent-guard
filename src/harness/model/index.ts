// 模型工厂：有配置走真实模型，没有就用脚本模型。
// 与参照项目的 createModel() 同一思路：零配置可跑，配了才联网。
import { getModelConfig } from './config'
import type { Model } from '../core/types'
import { AnthropicModel } from './anthropic-model'
import { ScriptedModel, finalTurn, lastToolResult, toolTurn } from './scripted-model'

// 演示脚本：两回合写死——先读工作区里的 welcome.md，再把内容摘要出来。
// 它不解析提示词；新增工具不需要改这里，换行为就换一套脚本。
export function createDemoModel(): Model {
  return new ScriptedModel(
    [
      toolTurn('read_file', { path: 'welcome.md' }, '我先读一下工作区里的 welcome.md。'),
      (input) => finalTurn(`welcome.md 的内容：${summarizeToolResult(lastToolResult(input.messages))}`),
    ],
    { chunkDelayMs: 60 },
  )
}

// 工具结果是 JSON 字符串，这里取它的 content 字段并压成一行
function summarizeToolResult(raw: string | null): string {
  if (!raw) return '(没有拿到工具结果)'
  try {
    const parsed = JSON.parse(raw) as { content?: string }
    return (parsed.content ?? raw).replace(/\s+/g, ' ').slice(0, 120)
  } catch {
    return raw.slice(0, 120)
  }
}

export function createModel(): Model {
  const config = getModelConfig()
  return config ? new AnthropicModel(config) : createDemoModel()
}
