import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chunkText } from '../src/harness/knowledge/chunker'
import { FakeEmbeddingProvider } from '../src/harness/knowledge/fake-embedding-provider'
import type { EmbeddingProvider } from '../src/harness/knowledge/embedding-provider'
import type { RerankProvider, RerankResult, RerankStage } from '../src/harness/knowledge/rerank-provider'
import { FakeRerankProvider } from '../src/harness/knowledge/fake-rerank-provider'
import {
  CONVERSATION_SOURCE_TYPE,
  indexCompletedRun,
  indexConversationRun,
  toConversationText,
} from '../src/harness/knowledge/conversation-documents'
import { indexDocument } from '../src/harness/knowledge/indexer'
import {
  cosineSimilarity,
  lexicalScore,
  scoreKnowledgeChunks,
  searchConversationHistory,
} from '../src/harness/knowledge/searcher'
import { ZhipuEmbeddingProvider } from '../src/harness/knowledge/zhipu-embedding-provider'
import { ZhipuRerankProvider } from '../src/harness/knowledge/zhipu-rerank-provider'
import { openReadStore, openStore } from '../src/harness/store'

const dirs: string[] = []

function tempDb(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentguard-knowledge-'))
  dirs.push(dir)
  return path.join(dir, 'test.db')
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

function fakeProvider(): FakeEmbeddingProvider {
  return new FakeEmbeddingProvider('fake-embedding', 64, 8)
}

describe('切块', () => {
  it('短文本一块；空文本零块', () => {
    expect(chunkText('你好世界')).toHaveLength(1)
    expect(chunkText('   ')).toEqual([])
  })

  it('长文本按 500/80 滑窗，重叠位置正确', () => {
    const text = '字'.repeat(1000)
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].text).toHaveLength(500)
    // 第二块从 500 - 80 = 420 处开始
    expect(chunks[1].text).toBe(text.slice(420, 920))
    expect(chunks[2].text).toBe(text.slice(840, 1000))
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2])
  })

  it('overlap 不小于 chunkSize 时直接报错，而不是死循环', () => {
    expect(() => chunkText('x', { chunkSize: 80, overlap: 80 })).toThrow(/不合法/)
  })
})

describe('fake embedding', () => {
  it('同文本同向量（确定性），维度正确', async () => {
    const provider = fakeProvider()
    const [a] = await provider.embed(['favicon 方案定了'])
    const [b] = await provider.embed(['favicon 方案定了'])
    expect(a).toHaveLength(64)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('共享字词的文本余弦更高（离线检索不是纯噪声）', async () => {
    const provider = fakeProvider()
    const [query] = await provider.embed(['favicon 方案'])
    const [related] = await provider.embed(['用户：favicon 方案用 svg 实现'])
    const [unrelated] = await provider.embed(['托盘菜单的实现细节'])
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated))
  })
})

describe('会话语料提取', () => {
  it('只取 text 块并带角色前缀；工具块不进语料', () => {
    const text = toConversationText([
      { role: 'user', content: 'favicon 用什么方案' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我查一下之前的讨论。' },
          { type: 'tool_use', id: 'tu-1', name: 'search_conversations', input: {} },
          { type: 'tool_result', toolUseId: 'tu-1', content: '文件内容与检索无关细节' },
          { type: 'text', text: '结论：用 svg。' },
        ],
      },
    ])
    expect(text).toContain('用户：favicon 用什么方案')
    expect(text).toContain('我查一下之前的讨论。')
    expect(text).toContain('结论：用 svg。')
    expect(text).not.toContain('文件内容与检索无关细节')
  })
})

describe('会话索引与检索（真实 store + fake provider）', () => {
  it('索引一轮：写入块数 > 0；同轮重放写 0（幂等）', async () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', 'favicon 讨论', process.cwd())
    const messages = [{ role: 'user' as const, content: 'favicon 方案用 svg' }]

    const first = await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      title: 'favicon 讨论',
      messages,
    })
    expect(first).toBeGreaterThan(0)

    const second = await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      title: 'favicon 讨论',
      messages,
    })
    expect(second).toBe(0)
    expect(store.listKnowledgeChunks(CONVERSATION_SOURCE_TYPE)).toHaveLength(1)
    store.close()
  })

  it('纯工具轮（无文本）不索引', async () => {
    const store = openStore(tempDb())
    const inserted = await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      title: '会话',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'read_file', input: {} }],
        },
      ],
    })
    expect(inserted).toBe(0)
    store.close()
  })

  it('块序号在会话内跨轮续号', async () => {
    const store = openStore(tempDb())
    for (const text of ['第一轮的话题甲', '第二轮的话题乙']) {
      await indexConversationRun({
        provider: fakeProvider(),
        store,
        conversationId: 'c1',
        title: '会话',
        messages: [{ role: 'user', content: text }],
      })
    }
    const indexes = store
      .listKnowledgeChunks(CONVERSATION_SOURCE_TYPE)
      .map((chunk) => chunk.chunkIndex)
      .sort((a, b) => a - b)
    expect(indexes).toEqual([0, 1])
    store.close()
  })

  it('indexCompletedRun 从库读标题；无会话行时跳过且不造默认标题', async () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', 'favicon 讨论', process.cwd())
    const inserted = await indexCompletedRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      messages: [{ role: 'user', content: 'favicon 方案' }],
    })
    expect(inserted).toBeGreaterThan(0)
    expect(store.listKnowledgeChunks(CONVERSATION_SOURCE_TYPE)[0].title).toBe('favicon 讨论')

    const skipped = await indexCompletedRun({
      provider: fakeProvider(),
      store,
      conversationId: 'missing',
      messages: [{ role: 'user', content: '内容' }],
    })
    expect(skipped).toBe(0)
    store.close()
  })

  it('软删后的会话不再进检索语料（标题读不到 → 索引闸门关闭）', async () => {
    const store = openStore(tempDb())
    store.ensureConversation('c1', '被删会话', process.cwd())
    store.deleteConversation('c1')

    const inserted = await indexCompletedRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      messages: [{ role: 'user', content: '迟到的索引' }],
    })
    expect(inserted).toBe(0)
    expect(store.listKnowledgeChunks(CONVERSATION_SOURCE_TYPE)).toEqual([])
    store.close()
  })
})

describe('索引写入模式', () => {
  it('replace 模式清空同来源旧块并从 0 重新编号', async () => {
    const store = openStore(tempDb())
    const provider = fakeProvider()
    const document = {
      sourceType: 'memory',
      sourceId: 'm1',
      title: 'm1',
    }
    try {
      await indexDocument({ ...document, text: '第一版内容' }, { provider, store })
      expect(store.listKnowledgeChunks('memory').map((chunk) => chunk.chunkIndex)).toEqual([0])

      await indexDocument(
        { ...document, text: '第二版内容' },
        { provider, store, mode: 'replace' },
      )
      const chunks = store.listKnowledgeChunks('memory')
      const text = chunks.map((chunk) => chunk.text).join('\n')
      expect(text).toContain('第二版内容')
      expect(text).not.toContain('第一版内容')
      expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0])
    } finally {
      store.close()
    }
  })
})

describe('会话检索', () => {
  async function prepareCorpus(file: string) {
    const store = openStore(file)
    store.ensureConversation('c1', 'favicon 讨论', process.cwd())
    store.ensureConversation('c2', '托盘实现', process.cwd())
    await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      title: 'favicon 讨论',
      messages: [
        { role: 'user', content: 'favicon 用什么方案' },
        { role: 'assistant', content: '用 svg，理由是缩放不失真。' },
      ],
    })
    await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c2',
      title: '托盘实现',
      messages: [{ role: 'user', content: '托盘菜单怎么加分隔线' }],
    })
    return store
  }

  it('向量模式：相关会话排第一，命中带来源与分数，写 retrieval 审计事件', async () => {
    const file = tempDb()
    const store = await prepareCorpus(file)

    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: fakeProvider(),
      store,
      runId: 'run-1',
      conversationId: 'c9',
    })

    expect(outcome.mode).toBe('vector')
    expect(outcome.hits[0].conversationId).toBe('c1')
    expect(outcome.hits[0].title).toBe('favicon 讨论')
    expect(outcome.hits[0].score).toBeGreaterThan(0)
    store.close()

    // 审计：retrieval 事件带 query / mode / 命中明细
    const reader = openReadStore(file)
    const retrieval = reader.listEvents().find((event) => event.type === 'retrieval')
    expect(retrieval).toBeDefined()
    expect(retrieval?.payload).toMatchObject({
      query: 'favicon 方案',
      topK: 2,
      mode: 'vector',
      hits: expect.arrayContaining([
        expect.objectContaining({
          conversationId: 'c1',
          title: 'favicon 讨论',
          // 命中原文必须随事件自包含（方案：经 retrieval 事件展开看原文）
          text: expect.stringContaining('favicon'),
        }),
      ]),
    })
    reader.close()
  })

  it('空语料库：无命中返回空数组，但审计事件照写', async () => {
    // fake 向量的 bigram 哈希在低维空间必然碰撞，"不相关的查询"也可能有非零余弦；
    // 无命中路径用空语料库断言才确定性
    const file = tempDb()
    const store = openStore(file)

    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: fakeProvider(),
      store,
      runId: 'run-1',
      conversationId: 'c9',
    })
    expect(outcome.hits).toEqual([])
    store.close()

    const reader = openReadStore(file)
    expect(reader.listEvents().some((event) => event.type === 'retrieval')).toBe(true)
    reader.close()
  })

  it('异模型向量被跳过：只有同模型的块参与余弦', async () => {
    // 场景：切换 embedding 提供方后，库里还留着旧模型的向量。
    // 旧模型的块即使向量相近也不该得分——两个向量空间不可比
    const file = tempDb()
    const store = openStore(file)
    const provider = fakeProvider()
    const [vector] = await provider.embed(['favicon 方案'])
    store.insertKnowledgeChunks(
      [
        {
          id: 'same-model',
          sourceType: CONVERSATION_SOURCE_TYPE,
          sourceId: 'c1',
          chunkIndex: 0,
          title: '同模型块',
          text: 'favicon 方案',
          tokens: 10,
          vector,
        },
        {
          id: 'other-model',
          sourceType: CONVERSATION_SOURCE_TYPE,
          sourceId: 'c2',
          chunkIndex: 0,
          title: '旧模型块',
          text: 'favicon 方案',
          tokens: 10,
          // 与查询同源向量，但 model 记的是别的模型——必须被跳过
          vector,
        },
      ],
      'zhipu-old-model',
    )
    // 同模型的块通过 indexConversationRun 写入（model = provider.model）
    await indexConversationRun({
      provider,
      store,
      conversationId: 'c3',
      title: '新模型块',
      messages: [{ role: 'user', content: 'favicon 方案' }],
    })

    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 5,
      provider,
      store,
      runId: 'run-1',
      conversationId: 'c9',
    })

    expect(outcome.hits.map((hit) => hit.conversationId)).not.toContain('c2')
    expect(outcome.hits.map((hit) => hit.conversationId)).toContain('c3')
    store.close()
  })

  it('向量失败时降级词法：仍有命中，事件 mode 记 lexical', async () => {
    const file = tempDb()
    const store = await prepareCorpus(file)

    const failingProvider: EmbeddingProvider = {
      model: 'failing',
      dimensions: 4,
      batchSize: 8,
      embed: () => Promise.reject(new Error('模拟限流')),
    }
    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: failingProvider,
      store,
      runId: 'run-1',
      conversationId: 'c9',
    })

    expect(outcome.mode).toBe('lexical')
    expect(outcome.hits[0].conversationId).toBe('c1')
    store.close()

    const reader = openReadStore(file)
    const retrieval = reader.listEvents().find((event) => event.type === 'retrieval')
    expect(retrieval?.payload).toMatchObject({ mode: 'lexical' })
    reader.close()
  })
})

describe('智谱 embedding（脚本化 fetch，不发真实请求）', () => {
  function zhipuProvider(responses: Array<() => Response>) {
    let callCount = 0
    const fetchImpl = vi.fn(async () => responses[Math.min(callCount++, responses.length - 1)]())
    const provider = new ZhipuEmbeddingProvider({
      apiKey: 'test-key',
      model: 'embedding-3',
      dimensions: 4,
      batchSize: 8,
      baseRetryDelayMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { provider, fetchImpl }
  }

  it('按 index 归位返回顺序', async () => {
    const { provider } = zhipuProvider([
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 0, 0, 2] },
              { index: 0, embedding: [1, 0, 0, 0] },
            ],
          }),
          { status: 200 },
        ),
    ])
    const vectors = await provider.embed(['a', 'b'])
    expect(Array.from(vectors[0])).toEqual([1, 0, 0, 0])
    expect(Array.from(vectors[1])).toEqual([0, 0, 0, 2])
  })

  it('429 退避重试后成功', async () => {
    const { provider, fetchImpl } = zhipuProvider([
      () => new Response(null, { status: 429 }),
      () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0, 0] }] }), {
          status: 200,
        }),
    ])
    const vectors = await provider.embed(['a'])
    expect(Array.from(vectors[0])).toEqual([1, 0, 0, 0])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('4xx（非 429）不重试，直接失败', async () => {
    const { provider, fetchImpl } = zhipuProvider([
      () => new Response(null, { status: 401 }),
    ])
    await expect(provider.embed(['a'])).rejects.toThrow(/401/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('错误信息携带响应体，且 1113（余额不足）不重试——充值不会发生在重试窗口内', async () => {
    const { provider, fetchImpl } = zhipuProvider([
      () =>
        new Response(JSON.stringify({ error: { code: '1113', message: '余额不足或无可用资源包' } }), {
          status: 429,
        }),
    ])
    await expect(provider.embed(['a'])).rejects.toThrow(/1113/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('返回维度与配置不符时报错', async () => {
    const { provider } = zhipuProvider([
      () =>
        new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2, 3] }] }), {
          status: 200,
        }),
    ])
    await expect(provider.embed(['a'])).rejects.toThrow(/维度不符/)
  })
})

describe('检索重排（重排）', () => {
  /** 四个会话的语料：候选池 4 > topK，重排阶段有事可做 */
  async function prepareRerankCorpus(file: string) {
    const store = openStore(file)
    const conversations = [
      ['c1', 'favicon 方案讨论', 'favicon 用什么方案？建议 svg，缩放不失真。'],
      ['c2', 'favicon 工具', '有没有自动生成 favicon 的在线工具？上传图片导出。'],
      ['c3', '托盘实现', '托盘菜单怎么加分隔线？用 Menu.buildFromTemplate。'],
      ['c4', '浏览器缓存', '浏览器 favicon 不刷新怎么办？清缓存。'],
    ] as const
    for (const [conversationId, title, text] of conversations) {
      store.ensureConversation(conversationId, title, process.cwd())
      await indexConversationRun({
        provider: fakeProvider(),
        store,
        conversationId,
        title,
        messages: [
          { role: 'user', content: text },
          { role: 'assistant', content: '好的。' },
        ],
      })
    }
    return store
  }

  /** 脚本化重排器：把候选顺序整个倒过来、给降序分数——验证检索阶段真的听重排器的 */
  function createReversingRerankProvider(): RerankProvider {
    return {
      model: 'stub-reverse',
      async rerank(query, documents) {
        const results: RerankResult[] = []
        for (let index = documents.length - 1; index >= 0; index -= 1) {
          results.push({ index, relevanceScore: 0.5 + index * 0.1 })
        }
        return results
      },
    }
  }

  function rerankStageOf(provider: RerankProvider, candidateCount = 20): RerankStage {
    return { provider, candidateCount }
  }

  it('重排生效：命中顺序跟随重排器，分数换成相关度，审计与结果都带重排观测', async () => {
    const file = tempDb()
    const store = await prepareRerankCorpus(file)
    const query = 'favicon 方案'
    const provider = fakeProvider()

    // 向量原序（全量），用于断言重排臂拿到的是「倒过来」的候选
    const { scored } = await scoreKnowledgeChunks({
      query,
      provider,
      chunks: store.listKnowledgeChunks(CONVERSATION_SOURCE_TYPE),
    })
    const vectorOrder = scored
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.chunk.sourceId)

    const outcome = await searchConversationHistory({
      query,
      topK: 2,
      provider,
      store,
      runId: 'run-rerank',
      conversationId: 'c9',
      rerank: rerankStageOf(createReversingRerankProvider(), 4),
    })

    expect(outcome.rerank).toMatchObject({
      model: 'stub-reverse',
      candidateCount: 4,
    })
    // 重排器把候选倒序：top-2 是向量序的第 4、3 名，分数是重排器的降序分
    expect(outcome.hits.map((hit) => hit.conversationId)).toEqual([
      vectorOrder[3],
      vectorOrder[2],
    ])
    expect(outcome.hits[0]?.score).toBe(0.8)
    expect(outcome.hits[1]?.score).toBe(0.7)
    store.close()

    const reader = openReadStore(file)
    const retrieval = reader.listEvents().find((event) => event.type === 'retrieval')
    expect(retrieval?.payload).toMatchObject({
      mode: 'vector',
      rerank: { model: 'stub-reverse', candidateCount: 4 },
    })
    reader.close()
  })

  it('重排失败退回向量排序：不抛错、rerank 为 null、顺序与不重排一致', async () => {
    const file = tempDb()
    const store = await prepareRerankCorpus(file)
    const failing: RerankProvider = {
      model: 'stub-fail',
      async rerank() {
        throw new Error('stub: 重排不可用')
      },
    }

    const plain = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: fakeProvider(),
      store,
      runId: 'run-plain',
      conversationId: 'c9',
    })
    const degraded = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: fakeProvider(),
      store,
      runId: 'run-degraded',
      conversationId: 'c9',
      rerank: rerankStageOf(failing, 4),
    })

    expect(degraded.rerank).toBeNull()
    expect(degraded.hits.map((hit) => hit.conversationId)).toEqual(
      plain.hits.map((hit) => hit.conversationId),
    )
    store.close()
  })

  it('词法降级路径不重排：rerank 恒为 null', async () => {
    const file = tempDb()
    const store = await prepareRerankCorpus(file)
    const failingEmbedding: EmbeddingProvider = {
      model: 'fake-embedding',
      dimensions: 64,
      batchSize: 8,
      async embed() {
        throw new Error('强制词法')
      },
    }

    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 2,
      provider: failingEmbedding,
      store,
      runId: 'run-lexical',
      conversationId: 'c9',
      rerank: rerankStageOf(createReversingRerankProvider(), 4),
    })

    expect(outcome.mode).toBe('lexical')
    expect(outcome.rerank).toBeNull()
    store.close()
  })

  it('候选池不大于 topK 时跳过重排（top-k 就是全池，无事可做）', async () => {
    const file = tempDb()
    const store = openStore(file)
    store.ensureConversation('c1', 'favicon 方案讨论', process.cwd())
    await indexConversationRun({
      provider: fakeProvider(),
      store,
      conversationId: 'c1',
      title: 'favicon 方案讨论',
      messages: [{ role: 'user', content: 'favicon 用什么方案？建议 svg。' }],
    })

    const outcome = await searchConversationHistory({
      query: 'favicon 方案',
      topK: 5,
      provider: fakeProvider(),
      store,
      runId: 'run-small',
      conversationId: 'c9',
      rerank: rerankStageOf(createReversingRerankProvider(), 20),
    })

    expect(outcome.rerank).toBeNull()
    expect(outcome.hits).toHaveLength(1)
    store.close()
  })

  it('fake 重排：确定性、按词法重合率降序', async () => {
    const reranker = new FakeRerankProvider('fake-rerank')
    const first = await reranker.rerank('favicon 方案', ['favicon 用 svg', '托盘菜单'])
    const second = await reranker.rerank('favicon 方案', ['favicon 用 svg', '托盘菜单'])

    expect(second).toEqual(first)
    expect(first[0]).toMatchObject({ index: 0, relevanceScore: lexicalScore('favicon 方案', 'favicon 用 svg') })
    expect(first[1]?.relevanceScore).toBeLessThanOrEqual(first[0]?.relevanceScore ?? 0)

    // 空候选不发请求
    expect(await reranker.rerank('q', [])).toEqual([])
  })
})

describe('智谱 rerank（脚本化 fetch，不发真实请求）', () => {
  function zhipuReranker(responses: Array<() => Response>) {
    let callCount = 0
    const fetchImpl = vi.fn(async () => responses[Math.min(callCount++, responses.length - 1)]())
    const provider = new ZhipuRerankProvider({
      apiKey: 'test-key',
      model: 'rerank',
      baseRetryDelayMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { provider, fetchImpl }
  }

  const okBody = (results: Array<{ index: number; relevance_score: number }>) =>
    new Response(JSON.stringify({ results }), { status: 200 })

  it('按分数降序返回，越界下标被丢弃', async () => {
    const { provider } = zhipuReranker([
      () =>
        okBody([
          { index: 0, relevance_score: 0.5 },
          { index: 9, relevance_score: 0.99 },
          { index: 1, relevance_score: 0.9 },
        ]),
    ])
    const results = await provider.rerank('q', ['a', 'b'])
    expect(results).toEqual([
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.5 },
    ])
  })

  it('429 退避重试后成功', async () => {
    const { provider, fetchImpl } = zhipuReranker([
      () => new Response(null, { status: 429 }),
      () => okBody([{ index: 0, relevance_score: 0.9 }]),
    ])
    const results = await provider.rerank('q', ['a'])
    expect(results).toEqual([{ index: 0, relevanceScore: 0.9 }])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('4xx（非 429）不重试，直接失败', async () => {
    const { provider, fetchImpl } = zhipuReranker([() => new Response(null, { status: 401 })])
    await expect(provider.rerank('q', ['a'])).rejects.toThrow(/401/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('1113（余额不足，包在 429 里）不重试', async () => {
    const { provider, fetchImpl } = zhipuReranker([
      () =>
        new Response(JSON.stringify({ error: { code: '1113', message: '余额不足' } }), {
          status: 429,
        }),
    ])
    await expect(provider.rerank('q', ['a'])).rejects.toThrow(/1113/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('输入超长直接抛错，不发请求（丢候选会破坏 index 映射）', async () => {
    const { provider, fetchImpl } = zhipuReranker([() => okBody([])])
    const longDocument = '长'.repeat(1_200)
    await expect(
      provider.rerank('q', Array.from({ length: 30 }, () => longDocument)),
    ).rejects.toThrow(/超长/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('空候选直接返回空数组，不发请求', async () => {
    const { provider, fetchImpl } = zhipuReranker([() => okBody([])])
    expect(await provider.rerank('q', [])).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
