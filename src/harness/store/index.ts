// 会话与运行记录的持久化。只有这一层碰 SQLite。
//
// 三个入口，对应三种"谁要用、能写不能写"：
// - `bootstrapStore`（主进程启动时）：唯一的引导期写入——建表/迁移、修复上次中断的运行；
// - `openReadStore`（主进程长期持有）：只返回读方法，连接上开 `query_only`，写不进去；
// - `openStore`（执行器）：完整读写，业务写入都在这里。
//
// better-sqlite3 速查（不熟先看这几行）：
// - `new Database(file)`：打开（不存在则创建）一个数据库文件；
// - `db.pragma('journal_mode = WAL')`：切到 WAL 日志模式（见 openStore 里的说明）；
// - `db.prepare(sql)`：预编译一条 SQL，返回"语句对象"。SQL 里的 `?` 是占位符，
//   执行时传参替换——不要自己拼字符串，拼接既慢又会被注入；
// - `语句.all(...)`：返回所有结果行（数组）；
//   `语句.get(...)`：只返回第一行（找不到返回 undefined）；
//   `语句.run(...)`：执行写操作，返回 `{ changes, lastInsertRowid }`；
// - `db.transaction(fn)`：把 fn 包成一个事务（BEGIN / COMMIT，抛错则 ROLLBACK）。
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Message } from '../core/types'
import {
  MEMORY_SOURCE_TYPE,
  type MemoryItem,
  type MemoryType,
} from '../../shared/memory'
import type {
  AuditEvent,
  AuditEventType,
  NewAuditEvent,
} from '../../shared/audit-event'
import { AuditEventSchema } from '../../shared/audit-event'
import { MIGRATIONS } from './schema'

export { MEMORY_TYPES, type MemoryType } from '../../shared/memory'
export type { AuditEvent, AuditEventType } from '../../shared/audit-event'

/** 库文件名：主进程与执行器都通过 databaseFile() 取路径，避免两处各拼一遍 */
export const DATABASE_FILENAME = 'agentguard.db'

/** 由状态目录推出库文件的完整路径（状态目录由主进程决定：开发态 .state，打包后 userData/state） */
export function databaseFile(stateDir: string): string {
  return path.join(stateDir, DATABASE_FILENAME)
}

/** 侧栏展示一个会话需要的字段（不是数据库表的全部列，messageCount 是算出来的） */
export interface StoredConversation {
  /** 会话 UUID */
  id: string
  /** 侧栏标题：由首条提问截断而成 */
  title: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 最近一次写入消息的时间（毫秒时间戳），列表按它倒序 */
  updatedAt: number
  /** 消息条数：用子查询现算，不单独存一列，避免和 messages 表不同步 */
  messageCount: number
  /** 该会话绑定的工作区根目录（用户新建会话时选择） */
  workspaceRoot: string
}

/** 一次运行的终态；failed 必须带原因，done/cancelled 不带 */
export type RunFinish =
  | { status: 'done' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }

/** 一次运行的生命周期：running 是起点，后四种都是终点 */
export type RunStatus = 'running' | 'interrupted' | RunFinish['status']

/** 待写入的知识切块：文本与向量在同一事务里落库 */
export interface KnowledgeChunkInsert {
  /** 内容哈希（source_type + source_id + text），幂等去重的依据 */
  id: string
  sourceType: string
  sourceId: string
  /** 块在来源内的序号（引用坐标："标题#序号"） */
  chunkIndex: number
  /** 引用来源的展示名（会话标题 / 记忆 的记忆 name） */
  title: string
  text: string
  tokens: number
  vector: Float32Array
}

/** 检索时读出的切块：向量从 embeddings 表拼回（历史原因可能缺失，检索跳过） */
export interface KnowledgeChunkRow {
  id: string
  sourceType: string
  sourceId: string
  chunkIndex: number
  title: string
  text: string
  tokens: number
  /** 生成该向量的模型名；无向量时为 null */
  model: string | null
  vector: Float32Array | null
}

/** 一条记忆文档：结构化字段 + 时间戳（正文按需加载） */
export type MemoryDocument = MemoryItem

/** 写入/更新一条记忆时的入参（时间戳由 store 负责） */
export interface MemoryUpsertInput {
  name: string
  description: string
  type: MemoryType
  body: string
}

export interface SearchMemoriesOptions {
  /** 按 name 模糊匹配 */
  name?: string
  /** 按 description 模糊匹配 */
  description?: string
  /** 按语义类型筛选 */
  type?: MemoryType
  /** updatedAt 下限（含），epoch 毫秒 */
  updatedAtFrom?: number
  /** updatedAt 上限（含），epoch 毫秒 */
  updatedAtTo?: number
  /** 默认 20 */
  limit?: number
  /** 默认 0 */
  offset?: number
  /** 默认 updatedAt */
  sortBy?: 'name' | 'updatedAt'
  /** 默认 desc */
  sortOrder?: 'asc' | 'desc'
}

export interface SearchMemoriesResult {
  /** 当前页完整文档；调用方只展示摘要 */
  items: MemoryDocument[]
  /** 过滤后的总条数 */
  total: number
}

/**
 * 只读接口：主进程长期持有的全部能力。
 *
 * 这是"能力清单"而不是"完整接口的一部分"——主进程拿到的对象上只有这些读方法
 *（会话、审计、记忆），写方法在类型上、运行时对象上都不存在。
 */
export interface ReadStore {
  /** 侧栏列表：按最近活动倒序，附带消息条数 */
  listConversations(): StoredConversation[]
  /** 读某个会话的全部消息，按写入顺序（执行器用它拼上下文） */
  loadMessages(conversationId: string): Message[]
  /** 读会话绑定的工作区；不存在或已软删返回 null */
  loadConversationWorkspace(conversationId: string): string | null
  /** 审计事件：按时间倒序，可按会话过滤 */
  listEvents(options?: { limit?: number; conversationId?: string }): AuditEvent[]
  /** 记忆列表：管理 UI 与目录用，按名字升序 */
  listMemories(): MemoryDocument[]
  /** 管理 UI 的服务端搜索/筛选/分页/排序；不返回全量 */
  searchMemories(options?: SearchMemoriesOptions): SearchMemoriesResult
  /** 按名字读一条记忆；不存在返回 null */
  loadMemory(name: string): MemoryDocument | null
  /** 关库（应用退出时调用） */
  close(): void
}

/** 完整接口：执行器用，包含写方法 */
export interface Store extends ReadStore {
  /** 建会话；已存在就什么都不做（标题不会被后来的提问覆盖） */
  ensureConversation(conversationId: string, title: string, workspaceRoot: string): void
  /** 会话还没有标题时写入首条提问的前缀（新建时标题为空） */
  updateConversationTitleIfEmpty(conversationId: string, title: string): void
  /** 追加消息并刷新会话的 updated_at，整体在一个事务里 */
  appendMessages(conversationId: string, messages: Message[]): void
  /** 记一条"开始运行"；同一 runId 重复上报会被忽略 */
  startRun(run: { id: string; conversationId: string; prompt: string }): void
  /** 记运行结束（done / cancelled / failed） */
  finishRun(id: string, result: RunFinish): void
  /** 追加一条审计事件（只增不改）；type 决定 payload 的形状 */
  appendEvent(event: NewAuditEvent): void
  /** 某来源当前最大的块序号；无块时 -1（续号从 max + 1 开始） */
  loadMaxChunkIndex(sourceType: string, sourceId: string): number
  /** 读单个会话的标题（语料索引的引用来源用）；不存在或已软删返回 null */
  loadConversationTitle(conversationId: string): string | null
  /**
   * 一个事务写入切块与向量（INSERT OR IGNORE：id 已存在就跳过）。
   * 返回实际新插入的块数——重复索引同一段文本返回 0，这就是幂等。
   */
  insertKnowledgeChunks(chunks: KnowledgeChunkInsert[], embeddingModel: string): number
  /**
   * 一个事务替换某来源的全部切块与向量：先删除该来源旧块（向量级联），
   * 再写入新块。记忆是可变更文档——正文更新后旧块必须消失，
   * 否则旧事实会继续被检索命中。返回实际写入的块数。
   */
  replaceKnowledgeChunks(
    sourceType: string,
    sourceId: string,
    chunks: KnowledgeChunkInsert[],
    embeddingModel: string,
  ): number
  /** 写入或更新一条记忆；同名更新时保留 created_at、刷新 updated_at */
  upsertMemory(input: MemoryUpsertInput): void
  /** 按名字读一条记忆；不存在返回 null */
  loadMemory(name: string): MemoryDocument | null
  /** 读全部记忆，按名字升序（目录与选择器的稳定顺序） */
  listMemories(): MemoryDocument[]
  /**
   * 删除一条记忆：事务内删除 memories 行与该记忆的 memory chunks/embeddings。
   * 返回是否真的删到了行；不存在时幂等返回 false。
   */
  deleteMemory(name: string): boolean
  /**
   * 读某来源类型的全部切块与向量（检索用）。演示级数据量全量载入内存算余弦；
   * 向量索引（sqlite-vec 或等价方案）是 重排 的对比题，这里不做。
   */
  listKnowledgeChunks(sourceType: string): KnowledgeChunkRow[]
  /**
   * 软删一个会话，一个事务里做三件事：
   * - 源数据软删：conversations 打 deleted_at 标记（messages / runs 行保留，可恢复）；
   * - 派生数据硬删：该会话的 chunks 物理删除（embeddings 随外键级联）——
   *   向量可从消息重建，且这正是"删除即清出检索语料"的落点，
   *   检索查询因此不用加"排除已删会话"的过滤；
   * - 审计事件硬删：该会话的业务事件（prompt、工具参数、检索原文……）一并删除，
   *   只留墓碑与 memory-written——前者是生命周期标记；后者只有 name/type，
   *   是记忆的创建审计，记忆独立于会话存活，创建证据也要保留。
   * 已删除的会话重复调用是幂等的（标记不动；墓碑不在删除范围，不会被抹掉）。
   *
   * 记忆（memories 表）是独立语料，不在这里处理：删会话不等于忘记忆，
   * 记忆的删除归记忆管理模块，避免一次会话清理静默抹掉跨会话事实。
   */
  deleteConversation(conversationId: string): void
}

/**
 * 按顺序补齐迁移。
 *
 * `PRAGMA user_version` 是 SQLite 文件头里预留的一个整数（不占表、不占行），
 * 用来记"这个库已经执行到第几段迁移"。新库是 0，执行完第一段后变成 1，以此类推。
 * 每段迁移放在事务里：建表与版本号要么一起生效，要么一起回滚。
 */
function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number

  for (let index = current; index < MIGRATIONS.length; index += 1) {
    const migrateOne = db.transaction(() => {
      db.exec(MIGRATIONS[index])
      db.pragma(`user_version = ${index + 1}`)
    })
    migrateOne()
  }
}

/** 每个连接都要做的设置：WAL（持久在文件头里）、外键约束 */
function applyConnectionPragmas(db: Database.Database): void {
  // WAL：写连接与读连接可以并发（写与写仍然互斥，一次只有一个写者）
  db.pragma('journal_mode = WAL')
  // 外键约束默认关闭，必须每个连接显式打开，REFERENCES ... ON DELETE CASCADE 才会生效
  db.pragma('foreign_keys = ON')
}

/** 读语句：三个入口共用（列表、按会话读历史） */
function prepareReadStatements(db: Database.Database) {
  // 列表查询里的 count 是"相关子查询"：对每一行 conversations 执行一次，
  // 只数属于它的消息条数（idx_messages_conversation 索引会加速这一步）。
  // 只列未删除的（软删的会话不出现在侧栏）。
  const listStmt = db.prepare(
    `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt,
            c.workspace_root AS workspaceRoot,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount
     FROM conversations c
     WHERE c.deleted_at IS NULL
     ORDER BY c.updated_at DESC`,
  )

  // 按自增主键排序 = 按写入顺序排序，模型看到的上下文顺序才正确。
  // JOIN 未删除的会话：软删的会话读出空历史（防御——正常流程侧栏里已点不到它）
  const loadStmt = db.prepare(
    `SELECT m.role, m.content_json AS contentJson
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
     WHERE m.conversation_id = ?
     ORDER BY m.id`,
  )

  // 审计：最近发生的在前；带会话过滤时走同一个索引
  // 会话工作区：新建会话时写入，运行时用它约束工具路径
  const workspaceStmt = db.prepare(
    'SELECT workspace_root AS workspaceRoot FROM conversations WHERE id = ? AND deleted_at IS NULL',
  )

  const eventsStmt = db.prepare(
    `SELECT id, run_id AS runId, conversation_id AS conversationId, type, payload_json AS payloadJson,
            created_at AS createdAt
     FROM events
     WHERE (? IS NULL OR conversation_id = ?)
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  )

  // 记忆：列表与详情共用两种读形状；正文只在详情/选择器/工具里加载。
  const listMemoriesStmt = db.prepare(
    `SELECT name, description, type, body,
            created_at AS createdAt, updated_at AS updatedAt
     FROM memories ORDER BY name`,
  )
  const loadMemoryStmt = db.prepare(
    `SELECT name, description, type, body,
            created_at AS createdAt, updated_at AS updatedAt
     FROM memories WHERE name = ?`,
  )

  return { listStmt, loadStmt, workspaceStmt, eventsStmt, listMemoriesStmt, loadMemoryStmt }
}

type ReadStatements = ReturnType<typeof prepareReadStatements>

/** LIKE 的 % / _ / \ 需要转义，否则用户搜索词会被当成通配符。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * 共享的读 API 实现：把 SQL 结果映射成领域对象。
 * 只读入口与读写入口都用它，避免两处各写一遍映射逻辑而慢慢漂移。
 */
function createReadApi(db: Database.Database, statements: ReadStatements): Omit<ReadStore, 'close'> {
  const { listStmt, loadStmt, workspaceStmt, eventsStmt, listMemoriesStmt, loadMemoryStmt } = statements

  return {
    listConversations() {
      // all() 返回所有行；SQL 里用 AS 起了驼峰别名，形状正好对得上 StoredConversation
      return listStmt.all() as StoredConversation[]
    },

    loadConversationWorkspace(conversationId) {
      const row = workspaceStmt.get(conversationId) as { workspaceRoot: string | null } | undefined
      return row?.workspaceRoot ?? null
    },

    loadMessages(conversationId) {
      const rows = loadStmt.all(conversationId) as Array<{ role: string; contentJson: string }>
      // 存进去时是 JSON 字符串，读出来要还原成消息块数组（含 tool_use / tool_result）
      return rows.map((row) => ({
        role: row.role as Message['role'],
        content: JSON.parse(row.contentJson) as Message['content'],
      }))
    },

    listEvents(options = {}) {
      const conversationId = options.conversationId ?? null
      // 默认最近 100 条；`(? IS NULL OR ...)` 让"带过滤/不带过滤"共用一条语句
      const rows = eventsStmt.all(conversationId, conversationId, options.limit ?? 100) as Array<{
        id: number
        runId: string | null
        conversationId: string | null
        type: AuditEventType
        payloadJson: string
        createdAt: number
      }>

      return rows.map((row) =>
        AuditEventSchema.parse({
          id: row.id,
          runId: row.runId,
          conversationId: row.conversationId,
          type: row.type,
          payload: JSON.parse(row.payloadJson) as unknown,
          createdAt: row.createdAt,
        }),
      )
    },

    listMemories() {
      return listMemoriesStmt.all() as MemoryDocument[]
    },

    loadMemory(name) {
      const row = loadMemoryStmt.get(name) as MemoryDocument | undefined
      return row ?? null
    },

    searchMemories(options = {}) {
      const name = (options.name ?? '').trim()
      const description = (options.description ?? '').trim()
      const limit = Math.min(Math.max(options.limit ?? 20, 1), 100)
      const offset = Math.max(options.offset ?? 0, 0)
      // 排序列只允许白名单，避免把用户输入拼进 ORDER BY。
      const sortColumn = options.sortBy === 'name' ? 'name' : 'updated_at'
      const direction = options.sortOrder === 'asc' ? 'ASC' : 'DESC'
      const clauses: string[] = []
      const filterParams: Array<string | number> = []
      if (name) {
        clauses.push(`name LIKE ? ESCAPE '\\'`)
        filterParams.push(`%${escapeLike(name)}%`)
      }
      if (description) {
        clauses.push(`description LIKE ? ESCAPE '\\'`)
        filterParams.push(`%${escapeLike(description)}%`)
      }
      if (options.type) {
        clauses.push('type = ?')
        filterParams.push(options.type)
      }
      if (options.updatedAtFrom !== undefined) {
        clauses.push('updated_at >= ?')
        filterParams.push(options.updatedAtFrom)
      }
      if (options.updatedAtTo !== undefined) {
        clauses.push('updated_at <= ?')
        filterParams.push(options.updatedAtTo)
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

      const totalRow = db
        .prepare(`SELECT COUNT(*) AS total FROM memories ${where}`)
        .get(...filterParams) as { total: number }
      const rows = db
        .prepare(
          `SELECT name, description, type, body,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM memories
           ${where}
           ORDER BY ${sortColumn} ${direction}, name ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...filterParams, limit, offset) as MemoryDocument[]

      return { items: rows, total: totalRow.total }
    },
  }
}

/**
 * 引导期入口（主进程启动时调用一次）：建库、跑迁移、修复上次中断的运行。
 *
 * 这是整个存储层唯一"在只读路径上写"的地方，所以单独拆成一个函数：
 * 名字直接说明它会写，调用方（主进程）也不需要因此拿到写接口。
 * 返回修复了几条运行记录，主进程用它打日志。
 */
export function bootstrapStore(filePath: string): number {
  const db = new Database(filePath)
  applyConnectionPragmas(db)
  migrate(db)

  // 上次还在 running，说明没走完正常收尾（强杀 / 崩溃）：中断是信息，不能静默消失
  const repaired = db
    .prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
    .run(Date.now()).changes

  // 引导结束就关掉这条写连接，主进程之后只持有只读视图
  db.close()
  return repaired
}

/**
 * 只读入口（主进程长期持有）。
 *
 * 不做迁移、不做修复——那两件事已经由 bootstrapStore 完成；这里只检查"库是否已就绪"，
 * 然后开 `query_only`：之后这条连接上的任何写操作都会被 SQLite 拒绝（防手滑，不是防恶意）。
 *
 * 返回的对象**只有读方法**，写方法在类型与运行时都不存在。
 */
export function openReadStore(filePath: string): ReadStore {
  const db = new Database(filePath)

  // 版本对不上说明没有先跑 bootstrapStore：直接报错，而不是让后续读到空表
  const version = db.pragma('user_version', { simple: true }) as number
  if (version !== MIGRATIONS.length) {
    db.close()
    throw new Error(
      `数据库尚未初始化（user_version=${version}，期望 ${MIGRATIONS.length}），请先调用 bootstrapStore()`,
    )
  }

  applyConnectionPragmas(db)
  // 只读开关：任何写语句都会报 "attempt to write a readonly database"
  db.pragma('query_only = ON')

  const statements = prepareReadStatements(db)
  return {
    ...createReadApi(db, statements),
    close() {
      db.close()
    },
  }
}

/**
 * 读写入口（执行器用）。
 *
 * 同一时刻只允许一个写者，所以执行器是唯一的业务写入口；
 * 主进程通过 openReadStore 拿到只读视图。
 */
export function openStore(filePath: string): Store {
  const db = new Database(filePath)
  applyConnectionPragmas(db)
  migrate(db)

  const statements = prepareReadStatements(db)

  // 追加消息时同步刷新会话的最近活动时间，侧栏排序随之变化
  const touchConversation = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')

  // ON CONFLICT(id) DO NOTHING：主键已存在就跳过这条 INSERT（幂等创建，不覆盖标题）
  const updateEmptyTitleStmt = db.prepare(
    "UPDATE conversations SET title = ? WHERE id = ? AND title = ''",
  )

  const ensureStmt = db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at, workspace_root) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  )

  const insertMessage = db.prepare(
    'INSERT INTO messages (conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?)',
  )

  // 运行记录同理：同一个 runId 重复上报时保留第一次，不覆盖已写的内容
  const startRunStmt = db.prepare(
    'INSERT INTO runs (id, conversation_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
  )

  const finishRunStmt = db.prepare(
    'UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?',
  )

  // 审计事件：只追加、不更新（INSERT 而非 UPSERT，重复调用就是两条独立事件）
  const insertEvent = db.prepare(
    'INSERT INTO events (run_id, conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
  )

  // 知识切块：OR IGNORE 是幂等的关键——同 id（同文本）重放直接跳过
  const maxChunkIndexStmt = db.prepare(
    'SELECT MAX(chunk_index) AS maxIndex FROM chunks WHERE source_type = ? AND source_id = ?',
  )
  // 软删：只标记未删除的行（已删的重复调用不覆盖时间戳）
  const markConversationDeletedStmt = db.prepare(
    'UPDATE conversations SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
  )
  const deleteConversationChunksStmt = db.prepare(
    "DELETE FROM chunks WHERE source_type = 'conversation' AND source_id = ?",
  )
  // 删除该会话的业务事件，但墓碑与记忆写入事件除外：
  // - 墓碑是生命周期标记，重复删除时不能把上一次的墓碑也抹掉；
  // - memory-written 只含 name/type（不含正文），是记忆的创建审计；
  //   记忆独立于会话存活，创建证据也应独立于会话保留。
  const deleteConversationEventsStmt = db.prepare(
    "DELETE FROM events WHERE conversation_id = ? AND type NOT IN ('conversation-deleted', 'memory-written')",
  )
  // 只读未删除会话的标题：软删后索引自然跳过（indexCompletedRun 拿到 null 返回 0）
  const titleStmt = db.prepare('SELECT title FROM conversations WHERE id = ? AND deleted_at IS NULL')
  const insertChunkStmt = db.prepare(
    `INSERT OR IGNORE INTO chunks (id, source_type, source_id, chunk_index, title, text, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  const insertEmbeddingStmt = db.prepare(
    `INSERT OR IGNORE INTO embeddings (chunk_id, model, dimensions, vector, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const listChunksStmt = db.prepare(
    `SELECT c.id, c.source_type AS sourceType, c.source_id AS sourceId,
            c.chunk_index AS chunkIndex, c.title, c.text, c.tokens,
            e.model, e.dimensions, e.vector
     FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
     WHERE c.source_type = ?
     ORDER BY c.source_id, c.chunk_index`,
  )

  // 记忆：同名 upsert。只更新内容字段与 updated_at，created_at 保留首次写入时间。
  const upsertMemoryStmt = db.prepare(
    `INSERT INTO memories (name, description, type, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       description = excluded.description,
       type = excluded.type,
       body = excluded.body,
       updated_at = excluded.updated_at`,
  )
  const deleteMemoryStmt = db.prepare('DELETE FROM memories WHERE name = ?')
  // 替换来源前的清场；embeddings 随 chunks 的外键级联删除
  const deleteChunksForSourceStmt = db.prepare(
    'DELETE FROM chunks WHERE source_type = ? AND source_id = ?',
  )

  return {
    ...createReadApi(db, statements),

    /**
     * 建会话；已存在就什么都不做（幂等）。
     * 执行 ensureStmt，靠 ON CONFLICT DO NOTHING 保证标题不被覆盖。
     * 调用方：执行器在 ask 时。
     */
    ensureConversation(conversationId, title, workspaceRoot) {
      const now = Date.now()
      ensureStmt.run(conversationId, title, now, now, workspaceRoot)
    },

    updateConversationTitleIfEmpty(conversationId, title) {
      updateEmptyTitleStmt.run(title, conversationId)
    },

    /**
     * 追加一组消息，并刷新会话的最近活动时间。
     * 事务包住"N 条插入 + 一次时间更新"，中途失败整体回滚。
     * 调用方：执行器在一轮运行结束后追加新增消息。
     */
    appendMessages(conversationId, messages) {
      if (messages.length === 0) return
      const now = Date.now()

      const write = db.transaction(() => {
        for (const message of messages) {
          insertMessage.run(conversationId, message.role, JSON.stringify(message.content), now)
        }
        touchConversation.run(now, conversationId)
      })
      write()
    },

    /**
     * 记一条"开始运行"：初始状态固定 running，started_at 只写这一次。
     * 同一 runId 重复上报被 ON CONFLICT 忽略。
     * 调用方：执行器在收到 ask、真正开始跑之前。
     */
    startRun({ id, conversationId, prompt }) {
      startRunStmt.run(id, conversationId, prompt, 'running', Date.now())
    },

    /**
     * 记运行结束：一次 UPDATE 同时写 status、finished_at、error。
     * 调用方：执行器在成功 / 被取消 / 抛错三条路径上。
     */
    finishRun(id, result) {
      finishRunStmt.run(
        result.status,
        Date.now(),
        result.status === 'failed' ? result.error : null,
        id,
      )
    },

    /**
     * 追加一条审计事件（只增不改）。
     * 用 INSERT 而不是 UPSERT：审计记录不应该被覆盖，重复调用就是两条独立事件。
     * 调用方：执行器在运行开始/审批/工具调用/结束时。
     */
    appendEvent({ runId, conversationId, type, payload }) {
      insertEvent.run(
        runId ?? null,
        conversationId ?? null,
        type,
        JSON.stringify(payload),
        Date.now(),
      )
    },

    /**
     * 软删一个会话（见 Store 接口的完整说明）。调用方：执行器的
     * delete-conversation 分发（它先做过运行中守卫与存在性检查）。
     */
    deleteConversation(conversationId) {
      const write = db.transaction(() => {
        markConversationDeletedStmt.run(Date.now(), conversationId)
        // embeddings 随 chunks 的外键级联删除（连接已开 foreign_keys）
        deleteConversationChunksStmt.run(conversationId)
        deleteConversationEventsStmt.run(conversationId)
      })
      write()
    },

    /**
     * 某来源已编到几号。无块返回 -1，续号从 max + 1 开始——
     * 一个会话多轮 run 的块序号由此单调递增，"标题#序号"才是稳定坐标。
     * 调用方：索引器在写入前。
     */
    loadMaxChunkIndex(sourceType, sourceId) {
      const row = maxChunkIndexStmt.get(sourceType, sourceId) as { maxIndex: number | null }
      return row.maxIndex ?? -1
    },

    /**
     * 读单个会话的标题。单行主键查询，不做全表扫描；已软删的返回 null
     * （软删后到账的迟到索引会因此自然跳过，不给已删会话重建语料）。
     * 调用方：knowledge 层在索引前解析引用来源的展示名。
     */
    loadConversationTitle(conversationId) {
      const row = titleStmt.get(conversationId) as { title: string } | undefined
      return row?.title ?? null
    },

    /**
     * 一个事务写入切块与向量。块与向量必须同生共死：
     * 半途失败整体回滚，不会出现"有块没向量"的中间态。
     * 调用方：索引器（indexDocument）。
     */
    insertKnowledgeChunks(chunks, embeddingModel) {
      if (chunks.length === 0) return 0
      let inserted = 0

      const write = db.transaction(() => {
        const now = Date.now()
        for (const chunk of chunks) {
          inserted += insertChunkStmt.run(
            chunk.id,
            chunk.sourceType,
            chunk.sourceId,
            chunk.chunkIndex,
            chunk.title,
            chunk.text,
            chunk.tokens,
          ).changes
          insertEmbeddingStmt.run(
            chunk.id,
            embeddingModel,
            chunk.vector.length,
            vectorToBlob(chunk.vector),
            now,
          )
        }
      })
      write()
      return inserted
    },

    /**
     * 替换某来源的全部切块：删除与写入在同一个事务里，读侧只会看到旧集合或新集合。
     * 记忆正文更新时用（会话索引仍是 append-only，不经过这里）。
     * 调用方：知识索引器的 replace 模式（记忆写入/对账重建）。
     */
    replaceKnowledgeChunks(sourceType, sourceId, chunks, embeddingModel) {
      let inserted = 0

      const write = db.transaction(() => {
        deleteChunksForSourceStmt.run(sourceType, sourceId)
        const now = Date.now()
        for (const chunk of chunks) {
          inserted += insertChunkStmt.run(
            chunk.id,
            chunk.sourceType,
            chunk.sourceId,
            chunk.chunkIndex,
            chunk.title,
            chunk.text,
            chunk.tokens,
          ).changes
          insertEmbeddingStmt.run(
            chunk.id,
            embeddingModel,
            chunk.vector.length,
            vectorToBlob(chunk.vector),
            now,
          )
        }
      })
      write()
      return inserted
    },

    /**
     * 写入或更新一条记忆。同名 upsert 保留 created_at，刷新 updated_at。
     * 调用方：记忆写入器（writeMemoryDocument）。
     */
    upsertMemory(input) {
      const now = Date.now()
      upsertMemoryStmt.run(input.name, input.description, input.type, input.body, now, now)
    },

    /**
     * 删除一条记忆：记忆行与它的 memory chunks 在同一个事务里删除。
     * embeddings 随 chunks 的外键级联删除；不存在时幂等返回 false。
     * 调用方：记忆管理服务（deleteMemoryDocument）。
     */
    deleteMemory(name) {
      let deleted = false
      const remove = db.transaction(() => {
        deleteChunksForSourceStmt.run(MEMORY_SOURCE_TYPE, name)
        deleted = deleteMemoryStmt.run(name).changes > 0
      })
      remove()
      return deleted
    },

    /**
     * 读某来源类型的全部切块（含向量）。LEFT JOIN：向量行缺失时 vector 为 null，
     * 检索侧跳过这些块而不是报错——老数据、写入中断都不该让检索崩掉。
     * 调用方：检索器（searchConversationHistory）。
     */
    listKnowledgeChunks(sourceType) {
      const rows = listChunksStmt.all(sourceType) as Array<{
        id: string
        sourceType: string
        sourceId: string
        chunkIndex: number
        title: string
        text: string
        tokens: number
        model: string | null
        dimensions: number | null
        vector: Buffer | null
      }>

      return rows.map((row) => ({
        id: row.id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        chunkIndex: row.chunkIndex,
        title: row.title,
        text: row.text,
        tokens: row.tokens,
        model: row.model,
        vector:
          row.vector !== null && row.dimensions !== null
            ? blobToVector(row.vector, row.dimensions)
            : null,
      }))
    },

    /** 关闭连接：WAL 模式下会把日志里未合并的内容写回主库 */
    close() {
      db.close()
    },
  }
}

// ── 向量的 BLOB 编解码 ────────────────────────────────────────────────
// Float32Array 的底层字节就是 4 字节/分量的 IEEE 754，SQLite BLOB 存字节序列，
// 之间只差一次拷贝。不序列化成 JSON：1024 维的数字数组转字符串既慢又大 3 倍以上。

/** Float32Array → Buffer（拷贝一份字节，脱离原数组的 ArrayBuffer） */
function vectorToBlob(vector: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength))
}

/** Buffer → Float32Array。dimensions 用来校验长度，不匹配说明数据损坏，宁可报错 */
function blobToVector(blob: Buffer, dimensions: number): Float32Array {
  if (blob.byteLength !== dimensions * 4) {
    throw new Error(`向量字节数与维度不符：${blob.byteLength} 字节 vs ${dimensions} 维`)
  }
  const vector = new Float32Array(dimensions)
  new Uint8Array(vector.buffer).set(blob)
  return vector
}
