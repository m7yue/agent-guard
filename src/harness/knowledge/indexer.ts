// 索引器：文档 → 切块 → 批量 embedding → 一个事务入库。
//
// 幂等设计：块 id = sha256(source_type + source_id + text)。
// 同一段文本无论重放多少次，id 不变，INSERT OR IGNORE 跳过——
// 重复索引同一轮对话写 0 行，也不产生重复向量。
// （embed 仍会被调用一次；"只索引增量"的责任在调用方——executor 只喂本轮新消息。）
//
// 块序号在来源内续号（max + 1 起）：一个会话多轮 run 的块序号单调递增，
// "标题#序号"才是稳定的引用坐标。代价是序号依赖写入顺序——
// 已知边界：把同一轮消息隔了很久再索引，序号会接在后面而不是回到原位；
// 当前调用方（每轮落库即索引）不会触发这条路径。
import { createHash } from 'node:crypto'
import type { KnowledgeChunkInsert } from '../store'
import type { EmbeddingProvider } from './embedding-provider'
import { chunkText, type ChunkOptions } from './chunker'

/** 索引器需要的最小写能力（Store 满足它；测试只需给这几招） */
export interface KnowledgeChunkWriter {
  /** 某来源当前最大的块序号；无块时 -1（续号从 max + 1 开始） */
  loadMaxChunkIndex(sourceType: string, sourceId: string): number
  /** 一个事务写入切块与向量（同 id 已存在则跳过）；返回实际新增块数 */
  insertKnowledgeChunks(chunks: KnowledgeChunkInsert[], embeddingModel: string): number
  /** 一个事务替换某来源的全部切块（先删后写）；返回写入块数 */
  replaceKnowledgeChunks(
    sourceType: string,
    sourceId: string,
    chunks: KnowledgeChunkInsert[],
    embeddingModel: string,
  ): number
}

/** 语料无关的索引对象：会话、记忆 的记忆文档都长这个形状 */
export interface IndexableDocument {
  /** 语料类型（'conversation'；记忆 增 'memory'），写入 chunks.source_type */
  sourceType: string
  /** 来源标识（会话 UUID / 记忆文档名），写入 chunks.source_id */
  sourceId: string
  /** 引用来源的展示名（会话标题 / 记忆 name），写入 chunks.title */
  title: string
  /** 文档正文；切块只对它做 */
  text: string
}

export interface IndexDocumentOptions {
  /** 文本转向量的提供方；其 model 名随向量入库 */
  provider: EmbeddingProvider
  /** 切块与向量的落库目标 */
  store: KnowledgeChunkWriter
  /** 覆盖切块参数（默认 500 字 / 80 重叠） */
  chunkOptions?: Partial<ChunkOptions>
  /**
   * 写入语义：append 只追加（会话历史，默认）；replace 先清空该来源旧块再写
   * （记忆这类可变更文档——正文更新后旧块必须消失）。
   */
  mode?: 'append' | 'replace'
}

/** 索引一篇文档；返回实际新写入的块数（文档为空或全部重复时为 0） */
export async function indexDocument(
  document: IndexableDocument,
  options: IndexDocumentOptions,
): Promise<number> {
  const chunks = chunkText(document.text, options.chunkOptions)
  if (chunks.length === 0) return 0

  // append 模式在来源内续号（会话多轮）；replace 模式先清空旧块，编号从 0 重新开始。
  // 「标题#序号」的引用坐标在 append 下才连续不重号（chunkText 的编号只在本文档内有效）。
  const mode = options.mode ?? 'append'
  const startIndex =
    mode === 'replace' ? 0 : options.store.loadMaxChunkIndex(document.sourceType, document.sourceId) + 1
  const vectors = await options.provider.embed(chunks.map((chunk) => chunk.text))

  const items: KnowledgeChunkInsert[] = chunks.map((chunk, position) => ({
    id: toKnowledgeChunkId(document.sourceType, document.sourceId, chunk.text),
    sourceType: document.sourceType,
    sourceId: document.sourceId,
    chunkIndex: startIndex + position,
    title: document.title,
    text: chunk.text,
    // 近似 token 数：按字符计。精确分词不影响检索排序，只用于口径观察
    tokens: chunk.text.length,
    vector: vectors[position],
  }))

  return mode === 'replace'
    ? options.store.replaceKnowledgeChunks(
        document.sourceType,
        document.sourceId,
        items,
        options.provider.model,
      )
    : options.store.insertKnowledgeChunks(items, options.provider.model)
}

/** 内容哈希：同一来源里同一段文本只占一行。不含 chunk_index——序号会随续号漂移，文本不会 */
export function toKnowledgeChunkId(
  sourceType: string,
  sourceId: string,
  text: string,
): string {
  return createHash('sha256').update(`${sourceType}\n${sourceId}\n${text}`).digest('hex')
}
