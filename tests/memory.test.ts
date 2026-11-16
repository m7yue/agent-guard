// 记忆模块：文档渲染、写入/替换、选择（LLM + 向量降级）、启动对账、run-agent 注入。
//
// 语料用 FakeEmbeddingProvider：bigram 哈希是词法信号，向量降级用例的查询
// 必须与记忆正文有字面重叠（同义改写是真实 embedding 才能覆盖的边界，这是已知边界）。
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message, Model, ModelInput, ModelTurn } from '../src/harness/core/types'
import type { EmbeddingProvider } from '../src/harness/knowledge/embedding-provider'
import { FakeEmbeddingProvider } from '../src/harness/knowledge/fake-embedding-provider'
import {
  toMemoryIndexText,
  toMemoryMarkdown,
  toMemoryRelevantText,
} from '../src/harness/memory/memory-document'
import type { MemoryTextModel } from '../src/harness/memory/memory-text-model'
import { selectMemories, toMemoryQueryText } from '../src/harness/memory/memory-selector'
import { createMemoryRuntime } from '../src/harness/memory/runtime'
import { createMemoryManagement } from '../src/harness/memory/management'
import {
  reconcileMemoryIndex,
  deleteMemoryDocument,
  updateMemoryDocument,
  writeMemoryDocument,
} from '../src/harness/memory/memory-writer'
import { checkPermission } from '../src/harness/permission'
import { runAgentTask } from '../src/harness/run-agent'
import { openStore, type MemoryDocument, type Store } from '../src/harness/store'
import { readMemoryTool } from '../src/harness/tools/read-memory'
import { writeMemoryTool } from '../src/harness/tools/write-memory'

const dirs: string[] = []

function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentguard-memory-'))
  dirs.push(dir)
  return path.join(dir, 'test.db')
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function fakeProvider(model = 'fake-embedding'): FakeEmbeddingProvider {
  return new FakeEmbeddingProvider(model, 64, 8)
}

function memoryInput(overrides: Partial<Parameters<Store['upsertMemory']>[0]> = {}) {
  return {
    name: 'favicon-plan',
    description: 'favicon 方案',
    type: 'project' as const,
    body: 'favicon 方案使用 svg 图标。',
    ...overrides,
  }
}

function scriptedSelector(response: string): MemoryTextModel {
  return { completeText: async () => response }
}

function throwingProvider(): EmbeddingProvider {
  return {
    model: 'fake-embedding',
    dimensions: 64,
    batchSize: 8,
    async embed() {
      throw new Error('embedding 不可用')
    },
  }
}

class RecordingModel implements Model {
  readonly mode = 'mock' as const
  readonly systems: string[] = []

  async complete(input: ModelInput): Promise<ModelTurn> {
    this.systems.push(input.system)
    return { stopReason: 'end', content: '好' }
  }
}

const searchStub = async () => ({ mode: 'vector' as const, hits: [], rerank: null })

describe('记忆文档', () => {
  it('目录为空时返回空串；有记忆时带 name/type/description', () => {
    expect(toMemoryIndexText([])).toBe('')
    const document: MemoryDocument = {
      name: 'user-name',
      description: '用户叫 7yue',
      type: 'user',
      body: '用户的名字是 7yue。',
      createdAt: 1,
      updatedAt: 1,
    }
    const index = toMemoryIndexText([document])
    expect(index).toContain('记忆目录')
    expect(index).toContain('- user-name [user] — 用户叫 7yue')
  })

  it('正文渲染成 frontmatter；name/description 里的换行折成单行', () => {
    const document: MemoryDocument = {
      name: 'user-name',
      description: '第一行\n第二行',
      type: 'user',
      body: '正文\n保留换行',
      createdAt: 1,
      updatedAt: 1,
    }
    const markdown = toMemoryMarkdown(document)
    expect(markdown).toContain('name: user-name')
    expect(markdown).toContain('description: 第一行 第二行')
    expect(markdown).toContain('type: user')
    expect(markdown).toContain('正文\n保留换行')
  })

  it('相关记忆块带 记忆:name 引用坐标', () => {
    const document: MemoryDocument = {
      name: 'user-name',
      description: '用户叫 7yue',
      type: 'user',
      body: '用户的名字是 7yue。',
      createdAt: 1,
      updatedAt: 1,
    }
    expect(toMemoryRelevantText([])).toBe('')
    expect(toMemoryRelevantText([document])).toContain('## 记忆:user-name')
  })
})

describe('记忆存储', () => {
  it('upsert 保留 created_at、刷新 updated_at、按名字排序', async () => {
    const store = openStore(tempDb())
    try {
      store.upsertMemory(memoryInput({ name: 'b-memory' }))
      store.upsertMemory(memoryInput({ name: 'a-memory' }))
      const before = store.loadMemory('a-memory')
      expect(before).not.toBeNull()

      await new Promise((resolve) => setTimeout(resolve, 2))
      store.upsertMemory(memoryInput({ name: 'a-memory', body: '更新后的正文' }))

      const after = store.loadMemory('a-memory')
      expect(after?.body).toBe('更新后的正文')
      expect(after?.createdAt).toBe(before?.createdAt)
      expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0)
      expect(store.listMemories().map((memory) => memory.name)).toEqual([
        'a-memory',
        'b-memory',
      ])
    } finally {
      store.close()
    }
  })

  it('replaceKnowledgeChunks 删除旧块与向量、写入新块', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    try {
      await writeMemoryDocument(memoryInput(), { store, provider })
      const first = store.listKnowledgeChunks('memory')
      expect(first.length).toBeGreaterThan(0)

      await writeMemoryDocument(
        memoryInput({ body: 'favicon 方案改为 png 图标。' }),
        { store, provider },
      )
      const second = store.listKnowledgeChunks('memory')
      expect(second.length).toBeGreaterThan(0)
      const ids = new Set(second.map((chunk) => chunk.id))
      for (const chunk of first) {
        expect(ids.has(chunk.id)).toBe(false)
      }
      expect(second.map((chunk) => chunk.text).join('\n')).toContain('png')
      expect(second.map((chunk) => chunk.text).join('\n')).not.toContain('svg')
    } finally {
      store.close()
    }
  })
})

describe('记忆写入', () => {
  it('新建返回 action=created 并建立 source_type=memory 的块', async () => {
    const store = openStore(tempDb())
    try {
      const result = await writeMemoryDocument(memoryInput(), {
        store,
        provider: fakeProvider(),
      })
      expect(result.action).toBe('created')
      expect(store.loadMemory('favicon-plan')?.body).toContain('svg')
      expect(store.listKnowledgeChunks('memory').length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('同名更新返回 action=updated，旧正文块被替换', async () => {
    const store = openStore(tempDb())
    try {
      await writeMemoryDocument(memoryInput(), { store, provider: fakeProvider() })
      const result = await writeMemoryDocument(
        memoryInput({ body: 'favicon 方案改为 png 图标。' }),
        { store, provider: fakeProvider() },
      )
      expect(result.action).toBe('updated')
      const text = store
        .listKnowledgeChunks('memory')
        .map((chunk) => chunk.text)
        .join('\n')
      expect(text).toContain('png')
      expect(text).not.toContain('svg')
    } finally {
      store.close()
    }
  })

  it('索引失败仍保存记忆本体，并清空旧块', async () => {
    const store = openStore(tempDb())
    try {
      await writeMemoryDocument(memoryInput(), { store, provider: fakeProvider() })
      expect(store.listKnowledgeChunks('memory').length).toBeGreaterThan(0)

      const result = await writeMemoryDocument(
        memoryInput({ body: 'favicon 方案改为 png 图标。' }),
        { store, provider: throwingProvider() },
      )
      expect(result.action).toBe('updated')
      expect(store.loadMemory('favicon-plan')?.body).toContain('png')
      expect(store.listKnowledgeChunks('memory')).toEqual([])
    } finally {
      store.close()
    }
  })

  it('管理更新检查 expectedUpdatedAt；冲突返回当前文档', async () => {
    const store = openStore(tempDb())
    try {
      const provider = fakeProvider()
      const created = await writeMemoryDocument(memoryInput(), { store, provider })
      const conflict = await updateMemoryDocument(
        {
          ...memoryInput({ body: 'favicon 方案改为 png 图标。' }),
          expectedUpdatedAt: created.document.updatedAt + 1,
        },
        { store, provider },
      )
      expect(conflict.status).toBe('conflict')
      if (conflict.status !== 'conflict') throw new Error('expected conflict')
      expect(conflict.current.body).toContain('svg')

      const updated = await updateMemoryDocument(
        {
          ...memoryInput({ body: 'favicon 方案改为 png 图标。' }),
          expectedUpdatedAt: created.document.updatedAt,
        },
        { store, provider },
      )
      expect(updated.status).toBe('updated')
      if (updated.status !== 'updated') throw new Error('expected updated')
      expect(updated.document.body).toContain('png')
      const text = store
        .listKnowledgeChunks('memory')
        .map((chunk) => chunk.text)
        .join('\n')
      expect(text).toContain('png')
      expect(text).not.toContain('svg')
    } finally {
      store.close()
    }
  })

  it('管理删除检查 expectedUpdatedAt；删除记忆行与块且幂等', async () => {
    const store = openStore(tempDb())
    try {
      const provider = fakeProvider()
      const created = await writeMemoryDocument(memoryInput(), { store, provider })

      const conflict = await deleteMemoryDocument(
        'favicon-plan',
        created.document.updatedAt + 1,
        { store, provider },
      )
      expect(conflict.status).toBe('conflict')
      expect(store.loadMemory('favicon-plan')).not.toBeNull()

      const deleted = await deleteMemoryDocument(
        'favicon-plan',
        created.document.updatedAt,
        { store, provider },
      )
      expect(deleted.status).toBe('deleted')
      expect(store.loadMemory('favicon-plan')).toBeNull()
      expect(store.listKnowledgeChunks('memory')).toEqual([])

      await expect(
        deleteMemoryDocument('favicon-plan', created.document.updatedAt, { store, provider }),
      ).resolves.toMatchObject({ status: 'not-found' })
    } finally {
      store.close()
    }
  })

  it('审计回调失败不把已完成的更新报告为失败', async () => {
    const store = openStore(tempDb())
    try {
      const provider = fakeProvider()
      const created = await writeMemoryDocument(memoryInput(), { store, provider })
      const manager = createMemoryManagement({
        store,
        provider,
        onWritten: () => {
          throw new Error('审计不可用')
        },
      })

      const result = await manager.update({
        ...memoryInput({ body: 'favicon 方案改为 png 图标。' }),
        expectedUpdatedAt: created.document.updatedAt,
      })

      expect(result.status).toBe('updated')
      expect(store.loadMemory('favicon-plan')?.body).toContain('png')
    } finally {
      store.close()
    }
  })
})

describe('记忆选择', () => {
  it('空库不调用选择模型', async () => {
    const store = openStore(tempDb())
    const completeText = vi.fn(async () => '[0]')
    try {
      const selection = await selectMemories({
        context: '任何问题',
        model: { completeText },
        store,
        provider: fakeProvider(),
      })
      expect(selection).toEqual({ mode: 'none', selected: [] })
      expect(completeText).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('LLM 返回下标时选中对应记忆；[] 是合法空结果', async () => {
    const store = openStore(tempDb())
    try {
      store.upsertMemory(memoryInput({ name: 'a-memory', description: 'A 记忆' }))
      store.upsertMemory(memoryInput({ name: 'b-memory', description: 'B 记忆' }))

      const picked = await selectMemories({
        context: '问题',
        model: scriptedSelector('[0, 1]'),
        store,
        provider: fakeProvider(),
      })
      expect(picked.mode).toBe('llm')
      expect(picked.selected.map((item) => item.document.name)).toEqual([
        'a-memory',
        'b-memory',
      ])

      const empty = await selectMemories({
        context: '问题',
        model: scriptedSelector('[]'),
        store,
        provider: fakeProvider(),
      })
      expect(empty).toEqual({ mode: 'llm', selected: [] })
    } finally {
      store.close()
    }
  })

  it('模型失败/坏 JSON/全越界下标时降级向量检索', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    try {
      await writeMemoryDocument(memoryInput(), { store, provider })

      for (const response of ['不是 JSON', '[99]', '[1.2]']) {
        const selection = await selectMemories({
          context: 'favicon 方案是什么',
          model: scriptedSelector(response),
          store,
          provider,
        })
        expect(selection.mode).toBe('vector-fallback')
        if (selection.mode !== 'vector-fallback') throw new Error('expected vector-fallback')
        expect(selection.selected.map((item) => item.document.name)).toContain(
          'favicon-plan',
        )
        expect(selection.selected[0].score).toBeGreaterThan(0)
      }
    } finally {
      store.close()
    }
  })

  it('maxItems 限制返回条数', async () => {
    const store = openStore(tempDb())
    try {
      for (let index = 0; index < 4; index += 1) {
        store.upsertMemory(memoryInput({ name: `memory-${index}`, description: `记忆 ${index}` }))
      }
      const selection = await selectMemories({
        context: '问题',
        maxItems: 2,
        model: scriptedSelector('[0, 1, 2, 3]'),
        store,
        provider: fakeProvider(),
      })
      expect(selection.selected).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('选择上下文保留当前问题并最多带 3 条历史 user 文本', () => {
    const history: Message[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '答一' },
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '答二' },
      { role: 'user', content: '第三句' },
      { role: 'assistant', content: '答三' },
      { role: 'user', content: '第四句' },
    ]
    const text = toMemoryQueryText('当前问题', history)
    expect(text).toContain('当前问题')
    expect(text).toContain('第二句')
    expect(text).toContain('第三句')
    expect(text).toContain('第四句')
    expect(text).not.toContain('第一句')
  })
})

describe('启动对账', () => {
  it('索引齐全时零重建、零 embedding 调用', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    try {
      await writeMemoryDocument(memoryInput(), { store, provider })
      const embed = vi.spyOn(provider, 'embed')
      const reindexed = await reconcileMemoryIndex({ store, provider })
      expect(reindexed).toBe(0)
      expect(embed).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('缺块时重建', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    try {
      await writeMemoryDocument(memoryInput(), { store, provider })
      store.replaceKnowledgeChunks('memory', 'favicon-plan', [], provider.model)
      expect(store.listKnowledgeChunks('memory')).toEqual([])

      const reindexed = await reconcileMemoryIndex({ store, provider })
      expect(reindexed).toBe(1)
      expect(store.listKnowledgeChunks('memory').length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('正文被直接更新（绕过写入器）时重建', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    try {
      await writeMemoryDocument(memoryInput(), { store, provider })
      store.upsertMemory(memoryInput({ body: 'favicon 方案改为 png 图标。' }))

      const reindexed = await reconcileMemoryIndex({ store, provider })
      expect(reindexed).toBe(1)
      const text = store
        .listKnowledgeChunks('memory')
        .map((chunk) => chunk.text)
        .join('\n')
      expect(text).toContain('png')
      expect(text).not.toContain('svg')
    } finally {
      store.close()
    }
  })

  it('向量模型与当前 provider 不符时重建', async () => {
    const store = openStore(tempDb())
    try {
      await writeMemoryDocument(memoryInput(), { store, provider: fakeProvider('old-model') })
      const reindexed = await reconcileMemoryIndex({
        store,
        provider: fakeProvider('new-model'),
      })
      expect(reindexed).toBe(1)
      expect(
        store.listKnowledgeChunks('memory').every((chunk) => chunk.model === 'new-model'),
      ).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe('记忆工具与权限', () => {
  function memoryContext(store: Store) {
    const provider = fakeProvider()
    return {
      workspaceRoot: os.tmpdir(),
      searchConversationHistory: searchStub,
      memory: createMemoryRuntime({
        store,
        provider,
        selectorModel: scriptedSelector('[0]'),
      }),
    }
  }

  it('write_memory 写入并入索引；非法 name/type 被拒绝', async () => {
    const store = openStore(tempDb())
    try {
      const writeMemory = writeMemoryTool.createHandler(memoryContext(store))
      const raw = await writeMemory({
        type: 'WriteMemory',
        input: memoryInput({ name: 'user-name', type: 'user', body: '用户叫 7yue。' }),
      })
      expect(JSON.parse(raw)).toMatchObject({ saved: true, name: 'user-name', action: 'created' })
      expect(store.loadMemory('user-name')?.body).toContain('7yue')

      await expect(
        writeMemory({
          type: 'WriteMemory',
          input: memoryInput({ name: 'Bad Name' }),
        }),
      ).rejects.toThrow(/入参不合法/)
      await expect(
        writeMemory({
          type: 'WriteMemory',
          input: { ...memoryInput(), type: 'nope' },
        }),
      ).rejects.toThrow(/入参不合法/)
    } finally {
      store.close()
    }
  })

  it('read_memory 命中返回正文、未命中返回 found=false', async () => {
    const store = openStore(tempDb())
    try {
      store.upsertMemory(memoryInput({ name: 'user-name', type: 'user', body: '用户叫 7yue。' }))
      const readMemory = readMemoryTool.createHandler(memoryContext(store))
      const hit = await readMemory({
        type: 'ReadMemory',
        input: { name: 'user-name' },
      })
      expect(hit).toContain('name: user-name')
      expect(hit).toContain('用户叫 7yue')

      const miss = await readMemory({
        type: 'ReadMemory',
        input: { name: 'missing' },
      })
      expect(JSON.parse(miss)).toEqual({ found: false, name: 'missing' })
    } finally {
      store.close()
    }
  })

  it('权限：write_memory 需审批，read/select 放行', () => {
    const root = '/tmp/agentguard-ws'
    expect(checkPermission('write_memory', memoryInput(), root).decision).toBe('ask')
    expect(checkPermission('read_memory', { name: 'user-name' }, root).decision).toBe('allow')
    expect(checkPermission('select_memory', { context: '问题' }, root).decision).toBe('allow')
  })
})

describe('run-agent 记忆注入', () => {
  it('有记忆时系统提示词含目录与选中正文，并发出 memory-used', async () => {
    const store = openStore(tempDb())
    try {
      store.upsertMemory(
        memoryInput({ name: 'user-name', type: 'user', description: '用户叫 7yue', body: '用户的名字是 7yue。' }),
      )
      const model = new RecordingModel()
      const memoryUsed: Array<{ reason: string; names: string[]; mode?: string }> = []

      await runAgentTask({
        runId: 'run-memory',
        prompt: '我叫什么？',
        history: [],
        workspaceRoot: os.tmpdir(),
        emit: () => {},
        requestApproval: async () => ({ decision: 'approved' as const }),
        searchConversationHistory: searchStub,
        model,
        memory: createMemoryRuntime({
          store,
          provider: fakeProvider(),
          selectorModel: scriptedSelector('[0]'),
          onMemoryUsed: (payload) => memoryUsed.push(payload),
        }),
      })

      expect(model.systems[0]).toContain('记忆目录')
      expect(model.systems[0]).toContain('- user-name [user]')
      expect(model.systems[0]).toContain('<relevant_memories>')
      expect(model.systems[0]).toContain('记忆:user-name')
      expect(memoryUsed).toEqual([
        { reason: 'selected', names: ['user-name'], mode: 'llm' },
      ])
    } finally {
      store.close()
    }
  })

  it('没有记忆时不注入任何记忆段', async () => {
    const model = new RecordingModel()
    await runAgentTask({
      runId: 'run-no-memory',
      prompt: '你好',
      history: [],
      workspaceRoot: os.tmpdir(),
      emit: () => {},
      requestApproval: async () => ({ decision: 'approved' as const }),
      searchConversationHistory: searchStub,
      model,
    })
    expect(model.systems[0]).not.toContain('记忆目录')
    expect(model.systems[0]).not.toContain('<relevant_memories>')
  })
})
