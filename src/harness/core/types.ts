// 核心类型：与参照项目的 src/core/types.ts 对齐，只补了"流式 token"这一个回调。
export type Role = 'user' | 'assistant'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export interface Message {
  role: Role
  content: string | ContentBlock[]
}

export interface ToolUse {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export type ModelTurn =
  | { stopReason: 'end' | 'max_tokens'; content: string; toolUses?: never; usage?: Usage }
  | { stopReason: 'tool_use'; content: string; toolUses: ToolUse[]; usage?: Usage }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema：真实模型靠它决定怎么调工具 */
  parameters: Record<string, unknown>
}

export interface ModelInput {
  system: string
  messages: Message[]
  tools: ToolDefinition[]
  /** 流式 token 的旁路出口：模型边生成边喂给调用方 */
  onToken?: (text: string) => void
  /** 取消信号：页面点"停止"时，请求会被中断 */
  signal?: AbortSignal
}

export interface Model {
  readonly mode: 'mock' | 'real'
  complete(input: ModelInput): Promise<ModelTurn>
}

// ── 小工具：从 content 里取纯文本 / 追加块 ──

export function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .map((block) => (block.type === 'text' ? block.text : block.type === 'tool_result' ? block.content : ''))
    .join('')
}
