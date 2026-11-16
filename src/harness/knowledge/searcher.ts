// 会话历史检索：查询 → embedding → 与库内全量向量余弦 → （可选）重排 → top-k。
//
// 降级链：向量失败（限流 / 断网 / 配置问题）→ 词法打分（bigram 重合率）；
// 重排失败 → 退回向量排序。两条降级都只记日志不阻塞——检索是回答质量的增强，
// 不是对话的前置条件。
//
// 每次检索写一条 retrieval 审计事件：query、topK、实际用的模式、命中块与分数，
// 重排 起含重排观测（模型、候选数、耗时）。
// 这是 会话检索 的叙事核心：审计从"行为可查"（调了什么工具）推进到"依据可查"
// （答案基于哪几段历史）。
import { getLogger } from '../logging/logger'
import type { NewAuditEvent } from '../../shared/audit-event'
import type { KnowledgeChunkRow } from '../store'
import type { EmbeddingProvider } from './embedding-provider'
import type { RerankStage } from './rerank-provider'
import { CONVERSATION_SOURCE_TYPE } from './conversation-documents'

export type RetrievalMode = 'vector' | 'lexical'

export interface ConversationSearchHit {
  /** 命中块所属的会话 */
  conversationId: string
  /** 引用来源的展示名（会话标题） */
  title: string
  /** 块在会话内的序号；引用格式：标题#序号 */
  chunkIndex: number
  text: string
  /**
   * 排序依据的分数，口径由路径决定：向量余弦 / 词法重合率（0..1），
   * 或重排相关度（rerank 非空时，实测 0..1 但分布不同，不与余弦互相比较）。
   */
  score: number
}

/** 一次重排阶段的观测：进审计与评测报告，回答「这次检索凭什么这么排」 */
export interface RerankSummary {
  /** 重排模型名 */
  model: string
  /** 送进重排的候选数（top-N 的 N） */
  candidateCount: number
  /** 重排调用耗时（毫秒） */
  durationMs: number
}

export interface ConversationSearchOutcome {
  /** 本次检索实际走的路径：向量，或降级后的词法 */
  mode: RetrievalMode
  hits: ConversationSearchHit[]
  /** 重排阶段的观测；未配置、词法降级、候选不足或重排失败时为 null（此时 hits 按原排序） */
  rerank: RerankSummary | null
}

/** 检索需要的最小能力（Store 满足它） */
export interface ConversationSearchStore {
  /** 读某来源类型的全部切块（含向量） */
  listKnowledgeChunks(sourceType: string): KnowledgeChunkRow[]
  /** 追加一条审计事件（retrieval 事件的落点） */
  appendEvent(event: NewAuditEvent): void
}

export interface SearchConversationHistoryOptions {
  /** 检索词（进入 embedding，并原样进审计 payload） */
  query: string
  /** 返回前 k 条命中 */
  topK: number
  /** 查询向量来自它；存量向量按它的 model 名过滤 */
  provider: EmbeddingProvider
  /** 切块的读取来源与审计事件的写入目标 */
  store: ConversationSearchStore
  /** 审计归属：这次检索服务于哪次运行 */
  runId: string
  /** 审计归属：这次检索发生在哪个会话 */
  conversationId: string
  /** 重排阶段；null / 缺省 = 不重排（会话检索 行为） */
  rerank?: RerankStage | null
}

/** 一个切块与它的相似度分数（向量余弦或词法重合率，取决于 mode） */
export interface ScoredKnowledgeChunk {
  chunk: KnowledgeChunkRow
  score: number
}

/** 对给定切块集打分；语料无关——会话检索与记忆降级共用 */
export interface ScoreKnowledgeChunksOptions {
  query: string
  provider: EmbeddingProvider
  chunks: KnowledgeChunkRow[]
}

export interface KnowledgeScoringOutcome {
  /** 本次实际走的路径：向量，或降级后的词法 */
  mode: RetrievalMode
  /** 与输入等长的候选（已打分，未排序） */
  scored: ScoredKnowledgeChunk[]
}

/**
 * 打分核心：查询向量与库内切块余弦；embedding 失败时降级为词法打分。
 * 只打分、不排序、不截断、不写审计——调用方决定取多少条、怎么审计。
 * 不同模型的向量空间不可比：向量路径只使用 provider.model 生成的块；
 * 词法路径不依赖向量，仍可使用全部块。
 */
export async function scoreKnowledgeChunks(
  options: ScoreKnowledgeChunksOptions,
): Promise<KnowledgeScoringOutcome> {
  const { query, provider, chunks } = options

  try {
    const [queryVector] = await provider.embed([query])
    return {
      mode: 'vector',
      scored: chunks
        .filter((chunk) => chunk.vector !== null && chunk.model === provider.model)
        .map((chunk) => ({
          chunk,
          score: cosineSimilarity(queryVector, chunk.vector as Float32Array),
        })),
    }
  } catch (error) {
    // 降级而不是失败：回答可以没有检索，不能没有答案
    getLogger('knowledge').warn('向量检索失败，降级词法检索', {
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      mode: 'lexical',
      scored: chunks.map((chunk) => ({ chunk, score: lexicalScore(query, chunk.text) })),
    }
  }
}

export async function searchConversationHistory(
  options: SearchConversationHistoryOptions,
): Promise<ConversationSearchOutcome> {
  const { query, topK, provider, store, runId, conversationId, rerank = null } = options
  const chunks = store.listKnowledgeChunks(CONVERSATION_SOURCE_TYPE)
  const { mode, scored } = await scoreKnowledgeChunks({ query, provider, chunks })

  // 候选按原路径排序：向量余弦（或词法重合率）降序
  const ranked = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  // 重排阶段：只对向量路径生效——词法是降级路径，在降级之上再叠加增强会混淆两种口径
  const activeRerank = rerank !== null && mode === 'vector' ? rerank : null
  // 候选数不大于 topK 时跳过——池子不大于结果集时重排无事可做（top-k 就是全池）
  const candidates =
    activeRerank !== null ? ranked.slice(0, activeRerank.candidateCount) : []

  let rerankSummary: RerankSummary | null = null
  let rankedHits: Array<{ chunk: KnowledgeChunkRow; score: number }> = []

  if (activeRerank !== null && candidates.length > topK) {
    try {
      const startedAtMs = performance.now()
      const results = await activeRerank.provider.rerank(
        query,
        candidates.map((item) => item.chunk.text),
      )
      const durationMs = performance.now() - startedAtMs

      const reranked = results
        .slice(0, topK)
        .flatMap((result) => {
          const candidate = candidates[result.index]
          return candidate ? [{ chunk: candidate.chunk, score: result.relevanceScore }] : []
        })

      if (reranked.length === 0) {
        // 全部下标都无法映射（响应异常）：按重排失败处理，退回原排序
        throw new Error('重排结果没有可映射的候选')
      }

      rerankSummary = {
        model: activeRerank.provider.model,
        candidateCount: candidates.length,
        durationMs,
      }
      rankedHits = reranked
    } catch (error) {
      // 降级而不是失败：重排失败退回向量排序，检索仍然可用（与词法降级同一哲学）
      getLogger('knowledge').warn('重排失败，退回向量排序', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (rerankSummary === null) {
    rankedHits = ranked.slice(0, topK).map(({ chunk, score }) => ({ chunk, score }))
  }

  const hits: ConversationSearchHit[] = rankedHits.map(({ chunk, score }) => ({
    conversationId: chunk.sourceId,
    title: chunk.title,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    // 分数只用于排序与审计口径，四位小数足够，也避免浮点尾数进 JSON
    score: Number(score.toFixed(4)),
  }))

  store.appendEvent({
    runId,
    conversationId,
    type: 'retrieval',
    payload: {
      query,
      topK,
      mode,
      // 命中原文随事件存：retrieval 是「依据」的一等审计记录，必须自包含——
      // 方案承诺「经审计面板的 retrieval 事件展开看原文」。代价：与 tool-result
      // 事件重复一份（topK 5 块 × 500 字 ≈ 2.5KB/次），审计表可承受。
      // rerank 缺省时省略键而不是写 null：旧事件的 payload 里本没有这个键。
      ...(rerankSummary !== null ? { rerank: rerankSummary } : {}),
      hits: hits.map((hit) => ({
        conversationId: hit.conversationId,
        title: hit.title,
        chunkIndex: hit.chunkIndex,
        score: hit.score,
        text: hit.text,
      })),
    },
  })

  return { mode, hits, rerank: rerankSummary }
}

/**
 * 余弦相似度：两个向量方向的接近程度（1 同向 / 0 无关）。
 * 与参照项目 rag.ts 的公式一致，只是载体从 number[] 换成 Float32Array（省内存）。
 * 任一向量为零向量时返回 0——空文本没有方向可言。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** 词法降级打分：查询的字符 bigram 有多少出现在块文本里（0..1）。导出给 fake 重排复用同一词法信号 */
export function lexicalScore(query: string, text: string): number {
  const terms = toBigramSet(query)
  if (terms.size === 0) return 0

  const haystack = text.toLowerCase()
  let matched = 0
  for (const term of terms) {
    if (haystack.includes(term)) matched += 1
  }
  return matched / terms.size
}

function toBigramSet(text: string): Set<string> {
  const normalized = text.toLowerCase()
  const terms = new Set<string>()
  for (let index = 0; index < normalized.length - 1; index += 1) {
    terms.add(normalized.slice(index, index + 2))
  }
  return terms
}
