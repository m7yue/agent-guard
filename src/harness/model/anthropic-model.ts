// 真实模型：走 Anthropic SDK，对上 DeepSeek 的 Anthropic 兼容端点。
// 与参照项目的差别只有一处：它用 create（非流式），我们用 stream（要边生成边显示）。
import Anthropic from '@anthropic-ai/sdk'
import { normalizeBaseUrl, type ModelConfig } from './config'
import type { ContentBlock, Message, Model, ModelInput, ModelTurn, ToolDefinition } from '../core/types'

function toApiMessages(messages: Message[]): Anthropic.Messages.MessageParam[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return { role: message.role, content: message.content }
    }

    const blocks: Anthropic.Messages.ContentBlockParam[] = message.content.map((block) => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
      }
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      }
    })

    return { role: message.role, content: blocks }
  })
}

function toApiTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Messages.Tool.InputSchema,
  }))
}

export class AnthropicModel implements Model {
  readonly mode = 'real' as const
  private readonly client: Anthropic
  private readonly config: ModelConfig

  constructor(config: ModelConfig) {
    this.config = config
    // AUTH_TOKEN 走 Bearer，API_KEY 走 x-api-key；只发一个，避免两个头不一致
    const auth =
      config.authHeader === 'authToken' ? { authToken: config.apiKey } : { apiKey: config.apiKey }

    this.client = new Anthropic({
      ...auth,
      baseURL: normalizeBaseUrl(config.baseUrl),
      timeout: config.timeoutMs,
      maxRetries: 1,
    })
  }

  async complete(input: ModelInput): Promise<ModelTurn> {
    const stream = this.client.messages.stream(
      {
        model: this.config.model,
        max_tokens: this.config.maxTokens,
        system: input.system,
        messages: toApiMessages(input.messages),
        ...(input.tools.length > 0 ? { tools: toApiTools(input.tools) } : {}),
      },
      // 取消信号交给 SDK：中断时流会被关闭
      { signal: input.signal },
    )

    // 文本增量直接喂给上层；工具调用要等 finalMessage 才完整
    if (input.onToken) {
      stream.on('text', (delta) => input.onToken?.(delta))
    }

    const message = await stream.finalMessage()

    const text = message.content
      .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')

    const toolUses = message.content
      .filter((block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, args: (block.input ?? {}) as Record<string, unknown> }))

    const usage = {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    }

    if (message.stop_reason === 'tool_use' && toolUses.length > 0) {
      return { stopReason: 'tool_use', content: text, toolUses, usage }
    }
    if (message.stop_reason === 'max_tokens') {
      return { stopReason: 'max_tokens', content: text, usage }
    }
    return { stopReason: 'end', content: text, usage }
  }
}

export type { ContentBlock }
