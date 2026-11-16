// 脚本化模型：按顺序返回预设回合，不解析提示词。
//
// 这是"可测试"的关键：测试里给定回合，循环的行为完全确定；
// 演示里给一套看起来像人的脚本；真实模型走 AnthropicModel。三者同一个 Model 接口。
import type { Message, Model, ModelInput, ModelTurn } from '../core/types'

// 回合既可以是静态数据，也可以根据对话内容算出来（演示需要读工具结果）
export type Turn = ModelTurn | ((input: ModelInput) => ModelTurn | Promise<ModelTurn>)

export interface ScriptedOptions {
  /** 每个输出片段的间隔，测试里设 0 */
  chunkDelayMs?: number
  chunkSize?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function lastToolResult(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content
    if (typeof content === 'string') continue
    const result = content.find((block) => block.type === 'tool_result')
    if (result) return result.content
  }
  return null
}

export function formatNow(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { now?: string }
    if (parsed.now) return new Date(parsed.now).toLocaleString('zh-CN')
  } catch {
    // 不是 JSON 就原样用
  }
  return raw
}

export class ScriptedModel implements Model {
  readonly mode = 'mock' as const

  private index = 0
  private readonly turns: Turn[]
  private readonly chunkDelayMs: number
  private readonly chunkSize: number

  constructor(turns: Turn[], options: ScriptedOptions = {}) {
    this.turns = turns
    this.chunkDelayMs = options.chunkDelayMs ?? 0
    this.chunkSize = options.chunkSize ?? 4
  }

  reset(): void {
    this.index = 0
  }

  // 模拟流式：把这一回合的文本切片喂给 onToken
  private async speak(
    text: string,
    onToken?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!onToken) return
    for (let i = 0; i < text.length; i += this.chunkSize) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      onToken(text.slice(i, i + this.chunkSize))
      if (this.chunkDelayMs > 0) await sleep(this.chunkDelayMs)
    }
  }

  async complete(input: ModelInput): Promise<ModelTurn> {
    if (input.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const turn = this.turns[Math.min(this.index, this.turns.length - 1)]
    if (!turn) throw new Error('ScriptedModel 没有可用的回合')

    this.index += 1
    const resolved = typeof turn === 'function' ? await turn(input) : turn
    await this.speak(resolved.content ?? '', input.onToken, input.signal)
    return resolved
  }
}

export function toolTurn(name: string, args: Record<string, unknown>, content = ''): ModelTurn {
  return {
    stopReason: 'tool_use',
    content,
    toolUses: [{ id: `tool-${crypto.randomUUID()}`, name, args }],
  }
}

export function finalTurn(content: string): ModelTurn {
  return { stopReason: 'end', content }
}
