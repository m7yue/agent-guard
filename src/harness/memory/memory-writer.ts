// 记忆写入与启动对账。
//
// 记忆是可变更文档（同名 upsert），所以索引必须用 replace 语义：
// 正文更新后，旧块（旧哈希、旧正文）必须消失，否则向量降级仍会命中旧事实。
// 会话是 append-only，走的是另一条 insert 路径，两者不混。
import { getLogger } from '../logging/logger'
import type { EmbeddingProvider } from '../knowledge/embedding-provider'
import { chunkText } from '../knowledge/chunker'
import {
  indexDocument,
  toKnowledgeChunkId,
  type KnowledgeChunkWriter,
} from '../knowledge/indexer'
import type {
  KnowledgeChunkRow,
  MemoryDocument,
  MemoryUpsertInput,
} from '../store'
import { MEMORY_SOURCE_TYPE, toMemoryMarkdown } from './memory-document'

/** 记忆写入/核对需要的最小存储能力（Store 满足它；测试可给最小替身） */
export interface MemoryStore extends KnowledgeChunkWriter {
  /** 写入或更新一条记忆（同名 upsert） */
  upsertMemory(input: MemoryUpsertInput): void
  /** 按名字读一条记忆 */
  loadMemory(name: string): MemoryDocument | null
  /** 读全部记忆（目录与对账用） */
  listMemories(): MemoryDocument[]
  /** 删除记忆行与该来源的切块（事务；不存在幂等返回 false） */
  deleteMemory(name: string): boolean
  /** 读某来源类型的全部切块（对账比对块 id / 向量模型） */
  listKnowledgeChunks(sourceType: string): KnowledgeChunkRow[]
}

export interface MemoryWriteOptions {
  /** 记忆行与切块的落库目标 */
  store: MemoryStore
  /** 正文转向量的提供方；其 model 名随向量入库 */
  provider: EmbeddingProvider
}

export interface WriteMemoryResult {
  /** 写入后的完整文档（时间戳已刷新） */
  document: MemoryDocument
  /** created = 新建；updated = 覆盖同名记忆 */
  action: 'created' | 'updated'
}

export type UpdateMemoryResult =
  | { status: 'updated'; document: MemoryDocument }
  | { status: 'not-found' }
  | { status: 'conflict'; current: MemoryDocument }

export type DeleteMemoryResult =
  | { status: 'deleted'; document: MemoryDocument }
  | { status: 'not-found' }
  | { status: 'conflict'; current: MemoryDocument }

/**
 * 记忆写操作串行化：记忆更新是"upsert 本体 → 重建索引"两步，中间有 embedding await。
 * 如果两个更新/删除并发，后完成的旧索引可能覆盖新索引，或删除后旧写入又补回块。
 * 所有记忆 mutation 走同一条 promise 链；失败不阻塞下一条。
 */
let memoryMutationChain: Promise<unknown> = Promise.resolve()

function enqueueMemoryMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = memoryMutationChain.then(operation, operation)
  memoryMutationChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * 写入或更新一条记忆。
 *
 * 顺序：先 upsert 记忆行（本体），再重建派生索引。
 * 索引失败不回滚记忆——记忆本体已经保存，只是暂不可检索；
 * 此时清掉该来源旧块，避免旧正文继续被降级检索命中，启动对账会补建。
 */
export function writeMemoryDocument(
  input: MemoryUpsertInput,
  options: MemoryWriteOptions,
): Promise<WriteMemoryResult> {
  return enqueueMemoryMutation(() => writeMemoryDocumentNow(input, options))
}

async function writeMemoryDocumentNow(
  input: MemoryUpsertInput,
  options: MemoryWriteOptions,
): Promise<WriteMemoryResult> {
  const existing = options.store.loadMemory(input.name)
  options.store.upsertMemory(input)

  const document = options.store.loadMemory(input.name)
  if (!document) throw new Error(`记忆写入后读不回来：${input.name}`)

  try {
    await indexMemoryDocument(document, options)
  } catch (error) {
    getLogger('memory').warn('记忆索引失败，已清空该来源旧块', {
      name: input.name,
      message: error instanceof Error ? error.message : String(error),
    })
    options.store.replaceKnowledgeChunks(MEMORY_SOURCE_TYPE, input.name, [], options.provider.model)
  }

  return { document, action: existing === null ? 'created' : 'updated' }
}

/**
 * 管理 UI 的更新：expectedUpdatedAt 检查、upsert、重建索引都在同一条队列里完成。
 * 检查放在队列内，避免"检查后、写入前"被另一条记忆操作插队。
 */
export function updateMemoryDocument(
  input: MemoryUpsertInput & { expectedUpdatedAt: number },
  options: MemoryWriteOptions,
): Promise<UpdateMemoryResult> {
  return enqueueMemoryMutation(async () => {
    const current = options.store.loadMemory(input.name)
    if (!current) return { status: 'not-found' }
    if (current.updatedAt !== input.expectedUpdatedAt) {
      return { status: 'conflict', current }
    }

    const result = await writeMemoryDocumentNow(input, options)
    return { status: 'updated', document: result.document }
  })
}

/**
 * 管理 UI 的删除：expectedUpdatedAt 检查与"删记忆行 + 切块"在同一队列/事务语义里。
 * 先读旧文档是为了返回 memoryType 给审计；删除本身由 store 事务保证原子。
 */
export function deleteMemoryDocument(
  name: string,
  expectedUpdatedAt: number,
  options: MemoryWriteOptions,
): Promise<DeleteMemoryResult> {
  return enqueueMemoryMutation(async () => {
    const current = options.store.loadMemory(name)
    if (!current) return { status: 'not-found' }
    if (current.updatedAt !== expectedUpdatedAt) {
      return { status: 'conflict', current }
    }

    const deleted = options.store.deleteMemory(name)
    if (!deleted) return { status: 'not-found' }
    return { status: 'deleted', document: current }
  })
}

/**
 * 把一条记忆渲染成切块与向量，replace 写入。
 * 索引文本包含 frontmatter（name/description/type）——降级检索时目录信息也能参与匹配。
 */
export async function indexMemoryDocument(
  document: MemoryDocument,
  options: MemoryWriteOptions,
): Promise<number> {
  return indexDocument(
    {
      sourceType: MEMORY_SOURCE_TYPE,
      sourceId: document.name,
      title: document.name,
      text: toMemoryMarkdown(document),
    },
    { provider: options.provider, store: options.store, mode: 'replace' },
  )
}

/**
 * 启动对账：只重建「缺块 / 块 id 与当前正文不符 / 向量模型与当前 provider 不符」的记忆。
 *
 * 为什么要对账：
 * - 写入与索引是两步，进程在两步之间挂掉会留下「有记忆没块」；
 * - 换 embedding 提供方后旧向量与查询向量不可比，记忆会静默从降级检索里消失；
 * - 会话只增量索引新轮次，记忆文档小且少，启动时一次比对成本低。
 *
 * 正常启动（块齐全、模型一致）零 embedding 调用；只有不匹配的记忆才重算。
 * 返回重建了几条，执行器用它打日志。
 */
export function reconcileMemoryIndex(options: MemoryWriteOptions): Promise<number> {
  return enqueueMemoryMutation(() => reconcileMemoryIndexNow(options))
}

async function reconcileMemoryIndexNow(options: MemoryWriteOptions): Promise<number> {
  const memories = options.store.listMemories()
  if (memories.length === 0) return 0

  const chunksBySource = new Map<string, KnowledgeChunkRow[]>()
  for (const chunk of options.store.listKnowledgeChunks(MEMORY_SOURCE_TYPE)) {
    const list = chunksBySource.get(chunk.sourceId) ?? []
    list.push(chunk)
    chunksBySource.set(chunk.sourceId, list)
  }

  let reindexed = 0
  for (const memory of memories) {
    const chunks = chunksBySource.get(memory.name) ?? []
    if (isIndexCurrent(memory, chunks, options.provider.model)) continue

    try {
      await indexMemoryDocument(memory, options)
      reindexed += 1
    } catch (error) {
      getLogger('memory').warn('记忆对账重建失败', {
        name: memory.name,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return reindexed
}

/**
 * 判断某条记忆的索引是否与当前正文、当前向量模型一致。
 * 期望块 id 由与写入完全相同的渲染 + 切块 + 哈希规则算出；
 * 块数、id 集合、model 三者都一致才算当前。
 */
function isIndexCurrent(
  memory: MemoryDocument,
  chunks: KnowledgeChunkRow[],
  embeddingModel: string,
): boolean {
  const expectedIds = new Set(
    chunkText(toMemoryMarkdown(memory)).map((chunk) =>
      toKnowledgeChunkId(MEMORY_SOURCE_TYPE, memory.name, chunk.text),
    ),
  )
  if (chunks.length !== expectedIds.size) return false
  if (chunks.some((chunk) => chunk.model !== embeddingModel)) return false
  return chunks.every((chunk) => expectedIds.has(chunk.id))
}
