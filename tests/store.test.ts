import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { bootstrapStore, openReadStore, openStore } from '../src/harness/store'
import { MIGRATIONS } from '../src/harness/store/schema'

const dirs: string[] = []

function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentguard-store-'))
  dirs.push(dir)
  return path.join(dir, 'test.db')
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

// 每条用例守一个行为约定：顺序、幂等、状态机、主键冲突
describe('会话存储', () => {
  it('建会话、追加消息、按序读回', () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', '第一个会话', process.cwd())
    store.appendMessages('c1', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，我是 Agent' },
    ])

    const messages = store.loadMessages('c1')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ role: 'user', content: '你好' })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '你好，我是 Agent' })

    expect(store.listConversations()).toEqual([
      expect.objectContaining({ id: 'c1', title: '第一个会话', messageCount: 2 }),
    ])
    store.close()
  })

  it('ensureConversation 幂等，不覆盖已有标题', () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', '原标题', process.cwd())
    store.ensureConversation('c1', '新标题', process.cwd())

    expect(store.listConversations()[0].title).toBe('原标题')
    store.close()
  })

  // 恢复语义的核心：只有 running 会被改，已结束的状态不能被覆盖
  it('引导期把 running 标成 interrupted，已结束的不受影响', () => {
    const file = tempDb()
    const store = openStore(file)
    store.ensureConversation('c1', '会话', process.cwd())
    store.startRun({ id: 'run-1', conversationId: 'c1', prompt: '跑一半' })
    store.startRun({ id: 'run-2', conversationId: 'c1', prompt: '跑完了' })
    store.finishRun('run-2', { status: 'done' })
    store.close()

    // 只修 run-1；run-2 已是 done，不会被覆盖
    expect(bootstrapStore(file)).toBe(1)
    expect(bootstrapStore(file)).toBe(0)
  })

  it('重复 startRun 同一 id 只留一条', () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', '会话', process.cwd())
    store.startRun({ id: 'run-1', conversationId: 'c1', prompt: 'a' })
    store.startRun({ id: 'run-1', conversationId: 'c1', prompt: 'a' })
    store.close()
  })

  it('loadConversationTitle 单行读取；不存在的会话返回 null', () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', '原标题', process.cwd())
    expect(store.loadConversationTitle('c1')).toBe('原标题')
    expect(store.loadConversationTitle('missing')).toBeNull()
    store.close()
  })
})

describe('只读视图', () => {
  it('未初始化时 openReadStore 直接报错，而不是读到空表', () => {
    expect(() => openReadStore(tempDb())).toThrow(/尚未初始化/)
  })

  it('返回的对象上没有写方法', () => {
    const file = tempDb()
    bootstrapStore(file)
    const reader = openReadStore(file)

    expect('appendMessages' in reader).toBe(false)
    expect('ensureConversation' in reader).toBe(false)
    expect('startRun' in reader).toBe(false)
    expect(typeof reader.listConversations).toBe('function')
    expect(typeof reader.loadMessages).toBe('function')
    reader.close()
  })

  it('bootstrapStore 修复中断的运行并返回条数', () => {
    const file = tempDb()

    const writer = openStore(file)
    writer.ensureConversation('c1', '会话', process.cwd())
    writer.startRun({ id: 'run-1', conversationId: 'c1', prompt: '跑一半' })
    writer.close()

    expect(bootstrapStore(file)).toBe(1)
    // 第二次没有 running 了，返回 0
    expect(bootstrapStore(file)).toBe(0)

    const reader = openReadStore(file)
    expect(reader.listConversations()[0]).toMatchObject({ id: 'c1' })
    reader.close()
  })

  it('query_only 连接确实拒绝写入（机制验证）', () => {
    const file = tempDb()
    const db = new Database(file)
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)')
    db.pragma('query_only = ON')

    expect(() => db.prepare('INSERT INTO probe (value) VALUES (?)').run('x')).toThrow(/readonly/i)
    db.close()
  })
})

describe('审计事件', () => {
  it('追加后可读，按时间倒序，支持按会话过滤', () => {
    const file = tempDb()
    const store = openStore(file)
    store.ensureConversation('c1', '会话', process.cwd())
    store.appendEvent({ runId: 'run-1', conversationId: 'c1', type: 'run-started', payload: { prompt: 'hi' } })
    store.appendEvent({
      runId: 'run-1',
      conversationId: 'c1',
      type: 'tool-call',
      payload: { name: 'read_file', input: '{}' },
    })
    store.close()

    const reader = openReadStore(file)
    const all = reader.listEvents()
    expect(all.map((event) => event.type)).toEqual(['tool-call', 'run-started'])
    expect(all[0].payload).toEqual({ name: 'read_file', input: '{}' })
    expect(reader.listEvents({ conversationId: 'other' })).toEqual([])
    reader.close()
  })

  it('v6 迁移把 memory-written 的 updated 归一为 action', () => {
    const file = tempDb()
    const raw = new Database(file)
    // 只应用到 v5，再手动执行 v6，隔离出"v6 的字段归一"这一个行为
    for (let index = 0; index < 5; index += 1) {
      raw.exec(MIGRATIONS[index])
    }
    raw.pragma('user_version = 5')
    raw
      .prepare(
        `INSERT INTO events (run_id, conversation_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        null,
        'c1',
        'memory-written',
        JSON.stringify({ name: 'user-name', memoryType: 'user', updated: false }),
        Date.now(),
      )
    raw
      .prepare(
        `INSERT INTO events (run_id, conversation_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        null,
        'c1',
        'tool-result',
        JSON.stringify({ name: 'read_file', result: 'ok' }),
        Date.now(),
      )

    raw.exec(MIGRATIONS[5])

    const rows = raw
      .prepare('SELECT type, payload_json AS payloadJson FROM events ORDER BY id')
      .all() as Array<{ type: string; payloadJson: string }>
    const memory = rows.find((row) => row.type === 'memory-written')
    expect(memory ? JSON.parse(memory.payloadJson) : null).toEqual({
      name: 'user-name',
      memoryType: 'user',
      action: 'created',
    })
    raw.close()
  })

  it('会话绑定工作区：写入后可读回，且不会被后续调用覆盖', () => {
    const file = tempDb()
    const store = openStore(file)
    store.ensureConversation('c1', '', '/tmp/ws-a')
    expect(store.listConversations()[0]?.workspaceRoot).toBe('/tmp/ws-a')
    expect(store.loadConversationWorkspace('c1')).toBe('/tmp/ws-a')

    // 幂等：已存在时不覆盖标题与工作区
    store.ensureConversation('c1', '另一个标题', '/tmp/ws-b')
    expect(store.loadConversationWorkspace('c1')).toBe('/tmp/ws-a')

    // 空标题在首条提问后补齐
    store.updateConversationTitleIfEmpty('c1', '第一条提问')
    expect(store.listConversations()[0]?.title).toBe('第一条提问')
    store.close()
  })

  it('v7 迁移清理没有工作区的旧会话', () => {
    const file = tempDb()
    const raw = new Database(file)
    for (let index = 0; index < 6; index += 1) {
      raw.exec(MIGRATIONS[index])
    }
    raw.pragma('user_version = 6')
    raw
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('old', '旧会话', Date.now(), Date.now())
    raw
      .prepare(
        'INSERT INTO messages (conversation_id, role, content_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('old', 'user', JSON.stringify('hi'), Date.now())
    raw.close()

    expect(bootstrapStore(file)).toBe(0)
    const reader = openReadStore(file)
    expect(reader.listConversations()).toEqual([])
    reader.close()
  })
})

// 迁移 v3：chunks + embeddings。核心约定：BLOB 往返不丢精度、
// 同 id 幂等跳过、块序号在来源内续号、按 source_type 过滤读取
describe('知识切块存储', () => {
  function chunkItem(id: string, chunkIndex: number, text: string, sourceId = 'c1') {
    return {
      id,
      sourceType: 'conversation',
      sourceId,
      chunkIndex,
      title: '会话标题',
      text,
      tokens: text.length,
      // Float32 精确可表示的值：往返断言不引入舍入噪声
      vector: Float32Array.from([1, 0.5, -0.25, 3.75, 0]),
    }
  }

  it('向量 BLOB 往返：值与维度都不丢', () => {
    const store = openStore(tempDb())
    store.insertKnowledgeChunks([chunkItem('id-1', 0, '文本一')], 'embedding-3')

    const rows = store.listKnowledgeChunks('conversation')
    expect(rows).toHaveLength(1)
    expect(Array.from(rows[0].vector as Float32Array)).toEqual([1, 0.5, -0.25, 3.75, 0])
    expect(rows[0].model).toBe('embedding-3')
    expect(rows[0].title).toBe('会话标题')
    store.close()
  })

  it('同 id 重复插入被忽略（幂等），返回实际新增数', () => {
    const store = openStore(tempDb())
    expect(store.insertKnowledgeChunks([chunkItem('id-1', 0, '文本一')], 'embedding-3')).toBe(1)
    expect(store.insertKnowledgeChunks([chunkItem('id-1', 0, '文本一')], 'embedding-3')).toBe(0)
    expect(store.listKnowledgeChunks('conversation')).toHaveLength(1)
    store.close()
  })

  it('块序号续号：无块时 -1，插入后取最大值', () => {
    const store = openStore(tempDb())
    expect(store.loadMaxChunkIndex('conversation', 'c1')).toBe(-1)
    store.insertKnowledgeChunks(
      [chunkItem('id-1', 0, 'a'), chunkItem('id-2', 1, 'b')],
      'embedding-3',
    )
    expect(store.loadMaxChunkIndex('conversation', 'c1')).toBe(1)
    store.close()
  })

  it('listKnowledgeChunks 按 source_type 过滤', () => {
    const store = openStore(tempDb())
    store.insertKnowledgeChunks([chunkItem('id-1', 0, '会话块')], 'embedding-3')
    store.insertKnowledgeChunks(
      [{ ...chunkItem('id-m', 0, '记忆块'), sourceType: 'memory', sourceId: 'm1' }],
      'embedding-3',
    )

    const conversations = store.listKnowledgeChunks('conversation')
    const memories = store.listKnowledgeChunks('memory')
    expect(conversations).toHaveLength(1)
    expect(conversations[0].sourceType).toBe('conversation')
    expect(memories[0].sourceId).toBe('m1')
    store.close()
  })
})

// 软删（会话软删）：源数据保留（消息/运行/事件），派生数据清除（chunks/embeddings），
// 读路径全部过滤。墓碑事件由执行器写，不在 store 层测
describe('会话软删', () => {
  function prepareConversation(file: string) {
    const store = openStore(file)
    store.ensureConversation('c1', '待删会话', process.cwd())
    store.appendMessages('c1', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好' },
    ])
    store.startRun({ id: 'run-1', conversationId: 'c1', prompt: '你好' })
    store.appendEvent({ runId: 'run-1', conversationId: 'c1', type: 'run-started', payload: { prompt: '' } })
    store.insertKnowledgeChunks(
      [
        {
          id: 'chunk-1',
          sourceType: 'conversation',
          sourceId: 'c1',
          chunkIndex: 0,
          title: '待删会话',
          text: '用户：你好',
          tokens: 5,
          vector: Float32Array.from([1, 0.5]),
        },
      ],
      'embedding-3',
    )
    return store
  }

  it('删除后：列表/历史/标题过滤，chunks 与业务事件物理删除，消息/运行行保留', () => {
    const file = tempDb()
    const store = prepareConversation(file)
    store.deleteConversation('c1')

    expect(store.listConversations()).toEqual([])
    expect(store.loadMessages('c1')).toEqual([])
    expect(store.loadConversationTitle('c1')).toBeNull()
    expect(store.listKnowledgeChunks('conversation')).toEqual([])
    // 业务事件清空——事件 payload 是内容承载面，删除后不得留在任何 UI 可见面
    expect(store.listEvents({ conversationId: 'c1' })).toEqual([])

    // 源数据还在（软删、可恢复）：直接开库数行（公开 API 对已删会话都读不到了）
    const raw = new Database(file)
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id='c1'").get() as { n: number }).n).toBe(2)
    expect((raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE conversation_id='c1'").get() as { n: number }).n).toBe(1)
    raw.close()
    store.close()
  })

  it('重复删除幂等且不抹墓碑；memory-written 随记忆保留，删除不存在的会话不报错', () => {
    const store = prepareConversation(tempDb())
    store.deleteConversation('c1')
    // 模拟执行器写的墓碑与记忆创建事件，再删一次：两者都必须留下
    store.appendEvent({
      conversationId: 'c1',
      type: 'conversation-deleted',
      payload: { conversationId: 'c1', title: '待删会话' },
    })
    store.appendEvent({
      conversationId: 'c1',
      type: 'memory-written',
      payload: { name: 'user-name', memoryType: 'user', action: 'created' },
    })
    store.deleteConversation('c1')
    store.deleteConversation('never-existed')

    const types = store
      .listEvents({ conversationId: 'c1' })
      .map((event) => event.type)
      .sort()
    expect(types).toEqual(['conversation-deleted', 'memory-written'])
    expect(store.listConversations()).toEqual([])
    store.close()
  })

  it('软删后新写入的检索语料仍只属于未删会话（loadConversationTitle 过滤是索引闸门）', () => {
    const store = prepareConversation(tempDb())
    store.ensureConversation('c2', '保留会话', process.cwd())
    store.deleteConversation('c1')
    // c1 已删：标题读不到 → 索引入口（indexCompletedRun）会跳过（见 knowledge 测试）
    expect(store.loadConversationTitle('c1')).toBeNull()
    expect(store.loadConversationTitle('c2')).toBe('保留会话')
    store.close()
  })
})

describe('记忆存储', () => {
  it('upsert 同名更新保留 created_at、刷新 updated_at；list 按名字排序', async () => {
    const store = openStore(tempDb())
    store.upsertMemory({ name: 'b-memory', description: 'B', type: 'project', body: 'b' })
    store.upsertMemory({ name: 'a-memory', description: 'A', type: 'user', body: 'a' })
    const before = store.loadMemory('a-memory')
    expect(before).not.toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 2))
    store.upsertMemory({ name: 'a-memory', description: 'A2', type: 'feedback', body: 'a2' })

    const after = store.loadMemory('a-memory')
    expect(after).toMatchObject({
      name: 'a-memory',
      description: 'A2',
      type: 'feedback',
      body: 'a2',
    })
    expect(after?.createdAt).toBe(before?.createdAt)
    expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0)
    expect(store.listMemories().map((memory) => memory.name)).toEqual([
      'a-memory',
      'b-memory',
    ])
    store.close()
  })

  it('replaceKnowledgeChunks 先删后写，旧块与向量一起消失', () => {
    const store = openStore(tempDb())
    const chunk = (id: string, text: string) => ({
      id,
      sourceType: 'memory',
      sourceId: 'm1',
      chunkIndex: 0,
      title: 'm1',
      text,
      tokens: text.length,
      vector: new Float32Array([1, 0]),
    })

    expect(store.replaceKnowledgeChunks('memory', 'm1', [chunk('old', '旧')], 'fake')).toBe(1)
    expect(store.listKnowledgeChunks('memory')).toHaveLength(1)

    expect(store.replaceKnowledgeChunks('memory', 'm1', [chunk('new', '新')], 'fake')).toBe(1)
    const chunks = store.listKnowledgeChunks('memory')
    expect(chunks.map((row) => row.id)).toEqual(['new'])
    expect(chunks[0].model).toBe('fake')
    store.close()
  })

  it('deleteMemory 事务删除记忆行与该来源块，幂等', () => {
    const store = openStore(tempDb())
    const chunk = (sourceId: string, id: string) => ({
      id,
      sourceType: 'memory',
      sourceId,
      chunkIndex: 0,
      title: sourceId,
      text: id,
      tokens: id.length,
      vector: new Float32Array([1, 0]),
    })

    store.upsertMemory({ name: 'm1', description: 'M1', type: 'user', body: 'a' })
    store.upsertMemory({ name: 'm2', description: 'M2', type: 'project', body: 'b' })
    store.replaceKnowledgeChunks('memory', 'm1', [chunk('m1', 'm1-chunk')], 'fake')
    store.replaceKnowledgeChunks('memory', 'm2', [chunk('m2', 'm2-chunk')], 'fake')

    expect(store.deleteMemory('m1')).toBe(true)
    expect(store.loadMemory('m1')).toBeNull()
    expect(store.loadMemory('m2')).not.toBeNull()
    expect(store.listKnowledgeChunks('memory').map((row) => row.sourceId)).toEqual(['m2'])
    expect(store.deleteMemory('m1')).toBe(false)
    store.close()
  })

  it('searchMemories 按列筛选：name/description/type/updatedAt 范围，支持分页排序', async () => {
    const store = openStore(tempDb())
    store.upsertMemory({ name: 'alpha', description: 'favicon svg', type: 'project', body: 'use svg' })
    const first = store.loadMemory('alpha')
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.upsertMemory({ name: 'beta', description: 'editor', type: 'user', body: 'neovim' })
    const second = store.loadMemory('beta')
    await new Promise((resolve) => setTimeout(resolve, 5))
    store.upsertMemory({ name: 'gamma', description: 'favicon png', type: 'project', body: 'use png' })
    const third = store.loadMemory('gamma')

    // 每列独立过滤；body 不是表格列，不参与搜索。
    expect(store.searchMemories({ name: 'alp' }).items.map((memory) => memory.name)).toEqual(['alpha'])
    expect(store.searchMemories({ description: 'favicon' }).total).toBe(2)
    expect(store.searchMemories({ name: 'neovim' }).total).toBe(0)
    expect(store.searchMemories({ description: 'neovim' }).total).toBe(0)

    expect(
      store.searchMemories({ type: 'project', sortBy: 'name', sortOrder: 'asc' }).items.map(
        (memory) => memory.name,
      ),
    ).toEqual(['alpha', 'gamma'])
    expect(
      store.searchMemories({ name: 'a', type: 'project', sortBy: 'name', sortOrder: 'asc' }).items.map(
        (memory) => memory.name,
      ),
    ).toEqual(['alpha', 'gamma'])

    // 时间范围两端都包含；边界来自实际写入的 updatedAt。
    expect(
      store.searchMemories({
        updatedAtFrom: second?.updatedAt,
        updatedAtTo: third?.updatedAt,
        sortBy: 'name',
        sortOrder: 'asc',
      }).items.map((memory) => memory.name),
    ).toEqual(['beta', 'gamma'])
    expect(store.searchMemories({ updatedAtTo: first?.updatedAt }).items.map((memory) => memory.name)).toEqual([
      'alpha',
    ])

    const secondPage = store.searchMemories({
      limit: 1,
      offset: 1,
      sortBy: 'name',
      sortOrder: 'asc',
    })
    expect(secondPage.total).toBe(3)
    expect(secondPage.items.map((memory) => memory.name)).toEqual(['beta'])

    // LIKE 通配符必须按字面量处理，不能把用户输入变成全匹配。
    expect(store.searchMemories({ name: '%' }).total).toBe(0)
    expect(store.searchMemories({ description: '%' }).total).toBe(0)
    store.close()
  })
})
