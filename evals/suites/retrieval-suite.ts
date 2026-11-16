// 检索套件：固定语料 → 切块 + embedding → search_conversation_history → recall@k。
//
// 与 agent 套件分开的原因：这里评的是检索管道本身（排序、降级、并行双查收益），
// 不经过模型，也不依赖子进程；fake embedding 下结果是确定性的。
import type { EmbeddingProvider } from '../../src/harness/knowledge/embedding-provider'
import { searchConversationHistory } from '../../src/harness/knowledge/searcher'
import { openStore, type Store } from '../../src/harness/store'
import { average } from '../core/aggregate'
import { RETRIEVAL_CASES, type RetrievalCase } from './retrieval/cases'
import { indexRetrievalCorpus } from './retrieval/index-corpus'
import type { RetrievalCaseResult, RetrievalHitReport, RetrievalSuiteReport } from '../core/types'

export interface RetrievalSuiteOptions {
  /** 索引与查询共用的 embedding 提供方。 */
  provider: EmbeddingProvider
  /** 报告里展示的 embedding 标识，例如 fake-embedding/1024。 */
  embeddingLabel: string
}

export async function runRetrievalSuite(
  options: RetrievalSuiteOptions,
): Promise<RetrievalSuiteReport> {
  const store = openStore(':memory:')
  try {
    await indexRetrievalCorpus(options.provider, store)

    const cases: RetrievalCaseResult[] = []
    for (const testCase of RETRIEVAL_CASES) {
      cases.push(await runRetrievalCase(testCase, options.provider, store))
    }

    return { cases, metrics: aggregateMetrics(cases), embedding: options.embeddingLabel }
  } finally {
    store.close()
  }
}

async function runRetrievalCase(
  testCase: RetrievalCase,
  provider: EmbeddingProvider,
  store: Store,
): Promise<RetrievalCaseResult> {
  const startedAt = performance.now()
  const auditBefore = countRetrievalEvents(store)
  const perQueryHits: Array<Map<string, { score: number; rank: number }>> = []
  let mode: 'vector' | 'lexical' = 'vector'

  for (const query of testCase.queries) {
    const outcome = await searchConversationHistory({
      query,
      topK: testCase.topK,
      // 词法降级用例故意让 query 的 embedding 失败；索引仍用正常 provider。
      provider: testCase.shouldForceLexical ? createFailingProvider(provider) : provider,
      store,
      runId: `retrieval-${testCase.id}`,
      conversationId: `retrieval-${testCase.id}`,
    })
    if (outcome.mode === 'lexical') mode = 'lexical'

    const hitMap = new Map<string, { score: number; rank: number }>()
    outcome.hits.forEach((hit, index) => {
      const source = `${hit.title}#${hit.chunkIndex}`
      const previous = hitMap.get(source)
      if (!previous || index + 1 < previous.rank) {
        hitMap.set(source, { score: hit.score, rank: index + 1 })
      }
    })
    perQueryHits.push(hitMap)
  }

  const durationMs = performance.now() - startedAt
  const auditEvents = countRetrievalEvents(store) - auditBefore
  const union = unionHits(perQueryHits)
  const recall = recallOf(new Set(union.keys()), testCase.expectedSources)

  const result: RetrievalCaseResult = {
    id: testCase.id,
    queries: testCase.queries,
    topK: testCase.topK,
    expectedSources: testCase.expectedSources,
    hits: buildHitReport(union, testCase.expectedSources),
    recall,
    mode,
    durationMs,
    auditEvents,
  }

  if (testCase.shouldMeasureParallelGain) {
    const firstQueryHits = perQueryHits[0] ?? new Map()
    result.singleQueryRecall = recallOf(new Set(firstQueryHits.keys()), testCase.expectedSources)
    result.unionRecall = recall
    result.extraEmbeddingCalls = testCase.queries.length - 1
  }

  return result
}

/** 把多次查询的命中取并集；同一来源保留最好的名次与对应分数。 */
function unionHits(
  perQueryHits: Array<Map<string, { score: number; rank: number }>>,
): Map<string, { score: number; rank: number }> {
  const union = new Map<string, { score: number; rank: number }>()
  for (const hitMap of perQueryHits) {
    for (const [source, hit] of hitMap) {
      const previous = union.get(source)
      if (!previous || hit.rank < previous.rank) union.set(source, hit)
    }
  }
  return union
}

function buildHitReport(
  union: Map<string, { score: number; rank: number }>,
  expectedSources: string[],
): RetrievalHitReport[] {
  const hits: RetrievalHitReport[] = [...union.entries()]
    .map(([source, hit]) => ({ source, score: hit.score, rank: hit.rank }))
    .sort((left, right) => left.rank - right.rank)

  // 未命中的期望来源也列出来（rank=null），报告里能直接看到漏了哪一块
  for (const source of expectedSources) {
    if (!union.has(source)) hits.push({ source, score: 0, rank: null })
  }
  return hits
}

function recallOf(actualSources: Set<string>, expectedSources: string[]): number {
  if (expectedSources.length === 0) return 0
  const matched = expectedSources.filter((source) => actualSources.has(source)).length
  return matched / expectedSources.length
}

function countRetrievalEvents(store: Store): number {
  return store.listEvents({ limit: 10_000 }).filter((event) => event.type === 'retrieval').length
}

/** 同 model / dimensions / batchSize，但 query 时抛错；用于强制词法降级。 */
function createFailingProvider(provider: EmbeddingProvider): EmbeddingProvider {
  return {
    model: provider.model,
    dimensions: provider.dimensions,
    batchSize: provider.batchSize,
    async embed() {
      throw new Error('eval: 强制词法降级')
    },
  }
}

function aggregateMetrics(cases: RetrievalCaseResult[]): RetrievalSuiteReport['metrics'] {
  const recalls = cases.map((testCase) => testCase.recall)
  const gains = cases
    .filter(
      (testCase) =>
        testCase.singleQueryRecall !== undefined && testCase.unionRecall !== undefined,
    )
    .map((testCase) => (testCase.unionRecall as number) - (testCase.singleQueryRecall as number))
  const lexicalRecalls = cases
    .filter((testCase) => testCase.mode === 'lexical')
    .map((testCase) => testCase.recall)
  const auditHits = cases.filter((testCase) => testCase.auditEvents === testCase.queries.length)

  return {
    retrievalRecallAtK: average(recalls),
    parallelQueryGain: average(gains),
    lexicalFallbackRecall: average(lexicalRecalls),
    retrievalAuditRate: cases.length === 0 ? null : auditHits.length / cases.length,
    averageDurationMs: average(cases.map((testCase) => testCase.durationMs)),
  }
}

