// 会话语料适配：把"一轮 run 的新增消息"变成可索引的文档。
//
// 检索管道（切块 / embedding / 入库）是语料无关的；本文件只回答一个问题：
// 一轮对话里哪些内容值得进语料。取舍：user 提问与 assistant 的文本块要，
// tool_use / tool_result 不要——文件内容与调用参数是执行痕迹，不是对话知识，
// 进语料只会稀释向量（它们在审计表里本来就查得到）。
import type { Message } from '../core/types'
import type { EmbeddingProvider } from './embedding-provider'
import { indexDocument, type IndexDocumentOptions, type KnowledgeChunkWriter } from './indexer'

/** 会话语料在 chunks 表里的 source_type；记忆 会加 'memory' */
export const CONVERSATION_SOURCE_TYPE = 'conversation'

/** 会话索引与 store 的接壤面：切块写入 + 标题读取 */
export interface ConversationIndexStore extends KnowledgeChunkWriter {
  /** 读单个会话的标题；不存在返回 null（语义同 Store 同名方法） */
  loadConversationTitle(conversationId: string): string | null
}

export interface IndexConversationRunOptions {
  /** 文本转向量的提供方 */
  provider: EmbeddingProvider
  /** 切块与向量的落库目标 */
  store: KnowledgeChunkWriter
  /** 会话 UUID（写入 chunks.source_id） */
  conversationId: string
  /** 会话标题（引用来源的展示名，与会话列表同源） */
  title: string
  /** 本轮 run 的新增消息（executor 传 appendMessages 的同一切片） */
  messages: Message[]
  /** 覆盖切块参数（默认 500 字 / 80 重叠） */
  chunkOptions?: IndexDocumentOptions['chunkOptions']
}

export interface IndexCompletedRunOptions {
  /** 文本转向量的提供方 */
  provider: EmbeddingProvider
  /** 切块写入 + 标题读取（标题由它解析，业务规则不进进程入口） */
  store: ConversationIndexStore
  /** 会话 UUID；标题从库里按它读 */
  conversationId: string
  /** 本轮 run 的新增消息（executor 传 appendMessages 的同一切片） */
  messages: Message[]
  /** 覆盖切块参数（默认 500 字 / 80 重叠） */
  chunkOptions?: IndexDocumentOptions['chunkOptions']
}

/** 一轮消息 → 纯文本：只取 text 块，带角色前缀给向量一点结构 */
export function toConversationText(messages: Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') {
      parts.push(`${roleLabel(message.role)}：${message.content}`)
      continue
    }
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    if (text.trim().length > 0) parts.push(`${roleLabel(message.role)}：${text}`)
  }
  return parts.join('\n\n')
}

/**
 * 索引一轮 run：文本为空（比如只有工具调用的轮次）就跳过，返回 0。
 * 返回实际写入的块数。失败（embedding 报错等）向上抛——
 * 索引是附带动作，由调用方决定降级策略，不该在这里吞掉错误。
 */
export async function indexConversationRun(options: IndexConversationRunOptions): Promise<number> {
  const text = toConversationText(options.messages)
  if (text.trim().length === 0) return 0

  return indexDocument(
    {
      sourceType: CONVERSATION_SOURCE_TYPE,
      sourceId: options.conversationId,
      title: options.title,
      text,
    },
    { provider: options.provider, store: options.store, chunkOptions: options.chunkOptions },
  )
}

function roleLabel(role: Message['role']): string {
  return role === 'user' ? '用户' : '助手'
}

/**
 * 一轮运行收尾后的语料入口（executor 只调这一个函数）：
 * 标题从库里读（ensureConversation 已保证会话行存在，标题 = 首条提问截断），
 * 标题解析这一业务规则因此不进进程入口。
 * 读不到标题说明数据异常：跳过并返回 0——不造默认标题进引用来源。
 */
export async function indexCompletedRun(options: IndexCompletedRunOptions): Promise<number> {
  const title = options.store.loadConversationTitle(options.conversationId)
  if (title === null) return 0
  return indexConversationRun({
    provider: options.provider,
    store: options.store,
    conversationId: options.conversationId,
    title,
    messages: options.messages,
    chunkOptions: options.chunkOptions,
  })
}
