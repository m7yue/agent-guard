// 记忆选择：记忆选择 的 SelectMemory 为主，会话检索 的向量打分作降级。
//
// 主路径：把目录（name + description）与最近对话交给一个 LLM，让它返回相关下标。
// 模型决定「用不用记忆、用哪条」——不是按相似度自动注入。
//
// 降级：模型调用失败或返回无法解析的下标时，用 会话检索 的切块打分在记忆语料上取 top-k。
// 这条路径让记忆作为第二语料有真实消费者，也是 重排 对比 LLM 选择与向量检索的基线。
//
// 空库不调用任何模型/embedding；选择器本身不写审计——审计归属到 run，由 run-agent 发。
import type { Message } from '../core/types'
import { getLogger } from '../logging/logger'
import type { EmbeddingProvider } from '../knowledge/embedding-provider'
import { scoreKnowledgeChunks } from '../knowledge/searcher'
import type { MemoryDocument } from '../store'
import { MEMORY_SOURCE_TYPE } from './memory-document'
import type { MemoryStore } from './memory-writer'
import type { MemoryTextModel } from './memory-text-model'

/** LLM 选中的记忆：没有相似度分数 */
export interface SelectedMemory {
  /** 完整文档（正文已按需加载） */
  document: MemoryDocument
}

/** 向量降级选中的记忆：带 0..1 的相似度 */
export interface ScoredSelectedMemory extends SelectedMemory {
  score: number
}

/** 选择结果：mode 决定 selected 的元素形状与空值语义 */
export type MemorySelection =
  | { mode: 'none'; selected: [] }
  | { mode: 'llm'; selected: SelectedMemory[] }
  | { mode: 'vector-fallback'; selected: ScoredSelectedMemory[] }

/** 有命中结果的 selection（none 的 selected 为空，不会进入使用审计） */
export type MemorySelectionWithResults = Exclude<MemorySelection, { mode: 'none' }>

export interface SelectMemoriesOptions {
  /** 最近对话 + 当前问题的文本（调用方用 toMemoryQueryText 组装） */
  context: string
  /** 最多选几条，默认 5（与 记忆选择 一致） */
  maxItems?: number
  /** LLM 选择器；为 null 时直接走向量降级 */
  model: MemoryTextModel | null
  /** 记忆行与切块的读取来源 */
  store: MemoryStore
  /** 向量降级与查询向量 */
  provider: EmbeddingProvider
  /** 取消信号：页面点"停止"时不再做额外的选择调用 */
  signal?: AbortSignal
}

const DEFAULT_MAX_ITEMS = 5
const CONTEXT_LIMIT = 2000

/**
 * 选择上下文：最近 3 条 user 文本 + 当前问题。
 * 当前问题必须完整保留（它才是本轮意图），历史文本只截到剩余预算。
 */
export function toMemoryQueryText(prompt: string, history: Message[]): string {
  const userTexts: string[] = []
  for (let index = history.length - 1; index >= 0 && userTexts.length < 3; index -= 1) {
    const message = history[index]
    if (message.role !== 'user') continue
    const text = textOfUserMessage(message)
    if (text.trim().length > 0) userTexts.push(text)
  }
  userTexts.reverse()

  const current = prompt.slice(-CONTEXT_LIMIT)
  const budget = Math.max(0, CONTEXT_LIMIT - current.length)
  const recent = userTexts.join('\n').slice(-budget)
  return [recent, current].filter((part) => part.length > 0).join('\n')
}

export async function selectMemories(
  options: SelectMemoriesOptions,
): Promise<MemorySelection> {
  const { context, maxItems = DEFAULT_MAX_ITEMS, model, store, provider, signal } = options
  const memories = store.listMemories()
  if (memories.length === 0) return { mode: 'none', selected: [] }

  if (model) {
    try {
      const indices = await selectMemoryIndices({ model, context, memories, maxItems, signal })
      // null = 模型返回了无法解析/无合法下标的内容，走降级；
      // [] 是合法结果（模型判断没有相关记忆），不降级。
      if (indices !== null) {
        return {
          mode: 'llm',
          selected: indices.flatMap((index) => {
            const document = memories[index]
            return document ? [{ document }] : []
          }),
        }
      }
    } catch (error) {
      // 主动取消不再做额外调用；其他失败降级，不让记忆选择阻塞对话
      if (signal?.aborted) return { mode: 'none', selected: [] }
      getLogger('memory').warn('LLM 选择记忆失败，降级向量检索', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return selectMemoriesByVector({ context, maxItems, provider, store })
}

interface SelectMemoryIndicesOptions {
  model: MemoryTextModel
  context: string
  memories: MemoryDocument[]
  maxItems: number
  signal?: AbortSignal
}

/** 调 LLM 选下标；返回 null 表示响应不可用（调用方降级），[] 表示模型明确不选 */
async function selectMemoryIndices(
  options: SelectMemoryIndicesOptions,
): Promise<number[] | null> {
  const catalog = options.memories
    .map((memory, index) => `${index}: ${memory.name} — ${memory.description}`)
    .join('\n')
  const prompt = [
    '下面是当前对话与记忆目录。选出与当前对话明确相关的记忆下标。',
    '只返回一个 JSON 整数数组，例如 [0, 3]；没有相关记忆返回 []。',
    '不要解释，不要输出数组以外的内容。',
    '',
    `当前对话：\n${options.context}`,
    '',
    `记忆目录：\n${catalog}`,
  ].join('\n')

  const raw = await options.model.completeText(prompt, { signal: options.signal })
  const parsed = extractJsonArray(raw)
  if (parsed === null) return null

  const indices: number[] = []
  for (const value of parsed) {
    if (typeof value !== 'number' || !Number.isInteger(value)) continue
    if (value < 0 || value >= options.memories.length) continue
    if (indices.includes(value)) continue
    indices.push(value)
    if (indices.length >= options.maxItems) break
  }

  // 模型给了非空数组却一个合法下标都没有：视为坏响应，交给降级
  if (parsed.length > 0 && indices.length === 0) return null
  return indices
}

/** 从模型文本里提取第一个 JSON 数组；没有或解析失败返回 null */
function extractJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*?\]/)
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[0])
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

interface SelectMemoriesByVectorOptions {
  context: string
  maxItems: number
  provider: EmbeddingProvider
  store: MemoryStore
}

/** 降级路径：记忆切块打分 → 按 sourceId 去重保最高分 → top-k → 按需加载正文 */
async function selectMemoriesByVector(
  options: SelectMemoriesByVectorOptions,
): Promise<MemorySelection> {
  const chunks = options.store.listKnowledgeChunks(MEMORY_SOURCE_TYPE)
  if (chunks.length === 0) return { mode: 'none', selected: [] }

  try {
    const { scored } = await scoreKnowledgeChunks({
      query: options.context,
      provider: options.provider,
      chunks,
    })

    const bestBySource = new Map<string, number>()
    for (const item of scored) {
      if (item.score <= 0) continue
      const previous = bestBySource.get(item.chunk.sourceId)
      if (previous === undefined || item.score > previous) {
        bestBySource.set(item.chunk.sourceId, item.score)
      }
    }

    const selected = [...bestBySource.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, options.maxItems)
      .flatMap(([name, score]) => {
        const document = options.store.loadMemory(name)
        // 块还在但记忆行没了（手动删库等）：跳过，不拿孤儿块回答
        return document ? [{ document, score: Number(score.toFixed(4)) }] : []
      })

    if (selected.length === 0) return { mode: 'none', selected: [] }
    return { mode: 'vector-fallback', selected }
  } catch (error) {
    getLogger('memory').warn('向量降级选择记忆失败', {
      message: error instanceof Error ? error.message : String(error),
    })
    return { mode: 'none', selected: [] }
  }
}

/** 只取文本块；user 消息里的 tool_result 不应进入记忆选择的上下文 */
function textOfUserMessage(message: Message): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
}
