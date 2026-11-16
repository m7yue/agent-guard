// 建表语句。数组里每一段是一个"迁移"，只能往后追加，不能改历史项——
// 否则已经升级过的老库就再也对不上号了。
//
// 先补几个 SQLite 的基础概念（不熟的话从这里读）：
// - **类型只是"亲和性"**：SQLite 是动态类型，列声明成 INTEGER 也不会拦住字符串；
//   真正生效的是约束（NOT NULL / PRIMARY KEY / UNIQUE）。
// - **`TEXT PRIMARY KEY`**：用业务 id（这里是会话 UUID）当主键。
// - **`INTEGER PRIMARY KEY`**：它其实是 SQLite 内建行号 `rowid` 的别名；
//   加上 `AUTOINCREMENT` 后，这个值只增不减，删除的行号也不会被复用。
// - **外键**：`REFERENCES ... ON DELETE CASCADE` 表示父行被删时子行一起删；
//   但 SQLite 的外键约束默认是关闭的，需要每个连接执行 `PRAGMA foreign_keys = ON`。
// - **时间**：统一存毫秒时间戳（INTEGER）。跨时区、比较、排序都简单，展示时再转本地时间。
export const MIGRATIONS: string[] = [
  `
  -- 会话（侧栏的一行）：标题 + 创建/最近活动时间
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,              -- 会话 UUID，由渲染层生成
    title TEXT NOT NULL,              -- 首条提问截断，之后不被覆盖
    created_at INTEGER NOT NULL,      -- 毫秒时间戳
    updated_at INTEGER NOT NULL       -- 每次追加消息时更新，列表按它倒序
  );

  -- 消息：一条会话里的若干个"轮次"，内容整体存 JSON
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,   -- 自增行号，同时充当"写入顺序"
    conversation_id TEXT NOT NULL            -- 属于哪个会话
      REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                     -- 'user' | 'assistant'
    content_json TEXT NOT NULL,             -- 消息块数组的 JSON（含 tool_use / tool_result）
    created_at INTEGER NOT NULL             -- 毫秒时间戳
  );

  -- 索引不是"表里的一列"，而是建在 messages 旁边的一棵独立的 B 树，
  -- 和表存在同一个 .db 文件里（在 sqlite_master 里能看到它，tbl_name = messages）。
  -- 它按 (conversation_id, id) 排序保存"键 + 指向行的 rowid"，并不复制整行内容。
  --
  -- 读某个会话的历史时：SQLite 先在索引里按 conversation_id 定位到那一段，
  -- 再顺着 id 的顺序读——既不用全表扫描，也不用额外排序。
  -- 代价：每次 INSERT / UPDATE / DELETE 都要同步维护这棵树，所以只为真实用到的查询建索引。
  --
  -- 查看方式：sqlite3 库文件 ".indexes messages"；
  --          在查询前加 EXPLAIN QUERY PLAN 能看到是否 "USING INDEX ..."。
  CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);

  -- 运行记录：一次"从提问到结束"的执行，单独一张表
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,                -- runId，由主进程生成（跨重启唯一）
    conversation_id TEXT NOT NULL,      -- 属于哪个会话
    prompt TEXT NOT NULL,               -- 这次的原始提问，便于审计回看
    status TEXT NOT NULL,               -- running / done / cancelled / failed / interrupted
    started_at INTEGER NOT NULL,        -- 开始时间（毫秒）
    finished_at INTEGER,                -- 结束时间；NULL 表示还没结束
    error TEXT                          -- 失败原因；正常结束为 NULL
  );
  `,

  `
  -- 审计事件：追加写、只增不改。和 runs 分开的原因是"一条运行会产生多条事件"
  -- （开始、请求审批、审批结果、工具调用、工具结果、结束），粒度更细。
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增行号，同时是天然的先后顺序
    run_id TEXT,                           -- 哪一次运行（有些事件可能不属于某次运行）
    conversation_id TEXT,                  -- 哪个会话
    type TEXT NOT NULL,                    -- 事件类型：run-started / approval-requested / …
    payload_json TEXT NOT NULL,            -- 事件细节的 JSON（工具名、参数、决定等）
    created_at INTEGER NOT NULL            -- 毫秒时间戳
  );

  -- 审计页按"最近发生"倒序读，走这个索引
  CREATE INDEX idx_events_created ON events(created_at DESC);
  `,

  `
  -- 知识切块与向量（会话检索 RAG v1）。语料是会话历史（source_type = 'conversation'），
  -- 记忆 的记忆文档会以 source_type = 'memory' 接进同一张表——切块表是语料无关的。
  --
  -- chunks.id 是内容哈希（source_type + source_id + text）：同一段文本重复索引得到
  -- 同一个 id，配合 INSERT OR IGNORE 实现幂等去重；chunk_index 只是引用坐标
  -- （"标题#序号"），不参与 id，序号在来源内单调递增。
  CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,    -- 'conversation'（记忆 增 'memory'）
    source_id TEXT NOT NULL,      -- 会话 UUID / 记忆文档名
    chunk_index INTEGER NOT NULL, -- 块在来源内的序号；检索结果按它引用
    title TEXT NOT NULL,          -- 引用来源的展示名（会话标题 / 记忆 name）
    text TEXT NOT NULL,
    tokens INTEGER                -- 近似值：按字符数估，不引入分词依赖
  );

  -- 向量与文本分表：换 embedding 模型时只重建这张表，切块不受影响。
  -- 向量按 Float32Array → Buffer 存 BLOB（1024 维 = 4KB/块）。
  CREATE TABLE embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- "某个来源已编到几号"（续号写新块）走这个索引
  CREATE INDEX idx_chunks_source ON chunks(source_type, source_id);
  `,

  `
  -- 会话软删（会话软删）：deleted_at 非空 = 已删除。
  -- 设计：源数据软删（conversations 标记，messages/runs 行保留——可恢复）；
  -- 派生数据硬删（chunks/embeddings 物理删除——向量可从消息重建，
  -- 且这正是"删除即清出检索语料"的落点，检索查询因此不用到处加过滤）；
  -- 审计事件硬删、只留墓碑——事件 payload 是内容承载面，留着等于删除后内容仍全量可见。
  ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
  `,

  `
  -- 记忆（记忆）：跨会话的结构化事实。列就是记忆文档的字段，
  -- 落盘形态是列而不是 frontmatter 文本；frontmatter 只是喂给模型/工具时的渲染形态
  -- （见 harness/memory/memory-document.ts）。
  -- 记忆与会话是两份独立语料：删除会话不会删除记忆；
  -- 同名写入是更新（ON CONFLICT ... DO UPDATE），created_at 保留第一次写入时间。
  CREATE TABLE memories (
    name TEXT PRIMARY KEY,                        -- kebab-case 标识，也是引用坐标「记忆:name」
    description TEXT NOT NULL,                    -- 一行摘要，常驻 system prompt 的目录用它
    type TEXT NOT NULL                            -- 四类语义，约束在库内也留一道
      CHECK (type IN ('user', 'feedback', 'project', 'reference')),
    body TEXT NOT NULL,                           -- 正文，按需加载
    created_at INTEGER NOT NULL,                  -- 首次写入时间（毫秒）
    updated_at INTEGER NOT NULL                   -- 最近一次更新时间（毫秒）
  );
  `,

  `
  -- 审计事件 ADT 的字段归一（记忆管理）：memory-written 的 payload 由
  -- { updated: boolean } 改为 { action: 'created' | 'updated' }。
  -- 只改字段名与取值，不改变事件含义；WHERE 保证重复执行幂等。
  -- JSON1 是 SQLite 自带的 JSON 扩展（json_set / json_remove / json_extract）。
  UPDATE events
  SET payload_json = json_remove(
    json_set(
      payload_json,
      '$.action',
      CASE WHEN json_extract(payload_json, '$.updated') = 1 THEN 'updated' ELSE 'created' END
    ),
    '$.updated'
  )
  WHERE type = 'memory-written'
    AND json_extract(payload_json, '$.updated') IS NOT NULL
    AND json_extract(payload_json, '$.action') IS NULL;
  `,

  `
  -- 会话工作区（v7）：每个会话绑定一个用户选择的目录。
  -- 旧会话没有工作区，按作者决定直接清空（发布前的开发数据）。
  ALTER TABLE conversations ADD COLUMN workspace_root TEXT;

  DELETE FROM messages;
  DELETE FROM runs;
  DELETE FROM events;
  DELETE FROM chunks WHERE source_type = 'conversation';
  DELETE FROM embeddings WHERE chunk_id NOT IN (SELECT id FROM chunks);
  DELETE FROM conversations;
  `,
]
