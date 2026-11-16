// 重排 检索对比套件：两部分测量，回答「什么时候值得换索引 / 重排买到了什么」。
//
// A. 规模对比（离线 fake embedding）：词法降级 / 向量暴力（JS 余弦）/ vec0 虚拟表
//    三条路在同一合成语料上按 1k / 5k / 20k 块测 recall@k 与延迟曲线。
//    三条路都是精确检索，recall 理论一致（有差异即管道 bug）；差异在延迟：
//    暴力路每查询把全部向量解码进 JS 堆再算余弦，vec0 把扫描留在 SQLite C 层。
//
// B. 重排 A/B（mock 用 fake 重排验证管道；真实数字来自 evals:real + 智谱 rerank）：
//    同一查询集跑两臂——向量 top-k，与 向量 top-N(20) → 重排 → top-k。
//    语料 = 会话检索 检索语料 + 噪声语料（表面相似、不含答案），后者制造重排才有收益的条件。
//
// 采样与聚合方法写进报告 methodology（R12）：每规模固定查询集，预热一轮后逐条计时，
// 报中位数；延迟不含审计写入（各路径公共开销）。
import type { EmbeddingProvider } from '../../../src/harness/knowledge/embedding-provider'
import type { RerankStage } from '../../../src/harness/knowledge/rerank-provider'
import {
  lexicalScore,
  scoreKnowledgeChunks,
  searchConversationHistory,
} from '../../../src/harness/knowledge/searcher'
import { indexConversationRun } from '../../../src/harness/knowledge/conversation-documents'
import { openStore, type Store } from '../../../src/harness/store'
import { average } from '../../core/aggregate'
import type {
  ComparisonPathMeasurement,
  ComparisonScaleMeasurement,
  RetrievalComparisonReport,
  RerankArmMeasurement,
} from '../../core/types'
import { indexRetrievalCorpus } from '../retrieval/index-corpus'
import { RETRIEVAL_CASES } from '../retrieval/cases'
import { generateSyntheticCorpus, toSyntheticChunkInserts } from './synthetic-corpus'
import { RERANK_NOISE_CORPUS } from './noise-corpus'
import { openVec0Index } from './vec0-index'

/** 规模对比的固定 top-k（对齐检索工具的默认返回量级） */
const SCALE_TOP_K = 5

export interface RetrievalComparisonOptions {
  /** 规模对比的 embedding：调用方固定传离线 fake——对比的是管道开销曲线，不是语义质量 */
  scaleProvider: EmbeddingProvider
  /** 报告里展示的规模对比 embedding 标识 */
  scaleEmbeddingLabel: string
  /** 重排阶段；null = 跳过重排 A/B（报告 rerankComparison 为 null） */
  rerank: RerankStage | null
  /** 重排臂标识（fake-rerank / rerank 模型名 / off） */
  rerankLabel: string
  /** 重排 A/B 的 embedding 与语料索引提供方（mock 传 fake，real 传智谱） */
  rerankProvider: EmbeddingProvider
  /** 规模档位（块数）；默认 1000 / 5000 / 20000 */
  sizes?: number[]
  /** 固定查询集的查询数；默认 20 */
  queryCount?: number
}

export async function runRetrievalComparisonSuite(
  options: RetrievalComparisonOptions,
): Promise<RetrievalComparisonReport> {
  const sizes = options.sizes ?? [1_000, 5_000, 20_000]
  const queryCount = options.queryCount ?? 20

  const scales: ComparisonScaleMeasurement[] = []
  for (const size of sizes) {
    scales.push(await measureScale(size, queryCount, options.scaleProvider))
  }

  const rerankComparison = await measureRerank(options.rerank, options.rerankProvider)

  return {
    scales,
    rerankComparison,
    rerankLabel: options.rerankLabel,
    embeddingLabel: options.scaleEmbeddingLabel,
    methodology: [
      `规模对比固定用离线 embedding（${options.scaleEmbeddingLabel}）：测的是扫描/打分/排序的管道开销曲线，不是语义召回质量。`,
      `每规模 ${queryCount} 条查询（从目标块派生的签名查询），预热一轮后逐条计时，报告取中位数；分量中位数各自独立计算，不一定来自同一条查询。`,
      'recall@k 的判定目标是构造签名块，衡量管道保真（三条路都精确，recall 应一致）；延迟不含审计写入与 embedding 网络调用。',
      'vec0 建表并灌入全部向量的耗时单独报告（一次性成本），不计入每查询延迟。',
      `重排 A/B 在 会话检索 检索语料 + ${RERANK_NOISE_CORPUS.length} 篇噪声语料上跑同一查询集；recall 按查询计（期望来源进 top-k 的比例），两臂同查询集可比。`,
    ],
  }
}

/** 单个规模的三路测量 */
async function measureScale(
  size: number,
  queryCount: number,
  provider: EmbeddingProvider,
): Promise<ComparisonScaleMeasurement> {
  const corpus = generateSyntheticCorpus(size, queryCount)
  const store = openStore(':memory:')
  let index = null as ReturnType<typeof openVec0Index> | null
  try {
    const vectors = await provider.embed(corpus.chunks.map((chunk) => chunk.text))
    store.insertKnowledgeChunks(toSyntheticChunkInserts(corpus.chunks, vectors), provider.model)

    index = openVec0Index(provider.dimensions)
    const buildStartedAtMs = performance.now()
    index.insert(corpus.chunks.map((chunk, position) => ({ id: chunk.id, vector: vectors[position]! })))
    const vec0IndexBuildMs = performance.now() - buildStartedAtMs

    // 词法路的打分核心见 measureScanPath：直接调用 lexicalScore（与产品降级分支同一函数）
    const lexical = { totals: [] as number[], scans: [] as number[], scores: [] as number[], hits: 0 }
    const brute = { totals: [] as number[], scans: [] as number[], scores: [] as number[], hits: 0 }
    const vec0 = { totals: [] as number[], scans: null, scores: [] as number[], hits: 0 }

    // 预热一轮（JIT 与语句缓存）：只热身，不计时也不计命中，否则样本多出一条、recall 会超 1
    await measureOnce(
      { query: corpus.queries[0]!.query, targetChunkId: corpus.queries[0]!.targetChunkId, record: false },
      { store, index, provider, lexical, brute, vec0 },
    )

    for (const { query, targetChunkId } of corpus.queries) {
      await measureOnce(
        { query, targetChunkId, record: true },
        { store, index, provider, lexical, brute, vec0 },
      )
    }

    const toMeasurement = (
      path: ComparisonPathMeasurement['path'],
      bucket: { totals: number[]; scans: number[] | null; scores: number[]; hits: number },
    ): ComparisonPathMeasurement => ({
      path,
      recallAtK: bucket.hits / queryCount,
      medianLatencyMs: median(bucket.totals),
      medianScanMs: bucket.scans === null ? null : median(bucket.scans),
      medianScoreMs: median(bucket.scores),
    })

    return {
      corpusChunks: size,
      queryCount,
      paths: [
        toMeasurement('lexical', lexical),
        toMeasurement('vector-brute', brute),
        toMeasurement('vector-vec0', vec0),
      ],
      vec0IndexBuildMs,
    }
  } finally {
    index?.close()
    store.close()
  }
}

interface MeasureOnceContext {
  store: Store
  index: ReturnType<typeof openVec0Index>
  provider: EmbeddingProvider
  lexical: ScanPathBucket
  brute: ScanPathBucket
  vec0: PathBucket
}

interface PathBucket {
  totals: number[]
  scans: number[] | null
  scores: number[]
  hits: number
}

/** 词法 / 暴力两条「先全量读块」路径的累加桶（扫描分量必有） */
interface ScanPathBucket {
  totals: number[]
  scans: number[]
  scores: number[]
  hits: number
}

/** 三条路各跑一次同一条查询；record=false 为预热轮，不累计任何测量 */
async function measureOnce(
  measurement: { query: string; targetChunkId: string; record: boolean },
  context: MeasureOnceContext,
): Promise<void> {
  const { query, targetChunkId, record } = measurement
  const { store, index, provider, lexical, brute, vec0 } = context

  // 词法与暴力共用形状：全量读块（含向量 BLOB 解码）→ 打分排序 → top-k。
  // 每查询都重新读库——这是产品现状的真实成本，也是规模对比要暴露的项。
  await measureScanPath(query, targetChunkId, 'lexical', lexical, provider, store, record)
  await measureScanPath(query, targetChunkId, 'vector-brute', brute, provider, store, record)

  // vec0：查询 embedding 后整条 KNN 留在 SQLite（不把全量向量读进 JS）
  const vec0StartedAtMs = performance.now()
  const [queryVector] = await provider.embed([query])
  const knnStartedAtMs = performance.now()
  const hits = index.search(queryVector, SCALE_TOP_K)
  const knnMs = performance.now() - knnStartedAtMs
  if (record) {
    vec0.totals.push(performance.now() - vec0StartedAtMs)
    vec0.scores.push(knnMs)
    if (hits.some((hit) => hit.id === targetChunkId)) vec0.hits += 1
  }
}

/** 词法 / 暴力共用的测量形状：全量读块 → 打分排序 → top-k，计时分扫描与打分两段 */
async function measureScanPath(
  query: string,
  targetChunkId: string,
  path: 'lexical' | 'vector-brute',
  bucket: ScanPathBucket,
  provider: EmbeddingProvider,
  store: Store,
  record: boolean,
): Promise<void> {
  const startedAtMs = performance.now()
  const scanStartedAtMs = performance.now()
  const chunks = store.listKnowledgeChunks('conversation')
  const scanMs = performance.now() - scanStartedAtMs

  const scoreStartedAtMs = performance.now()
  // 词法路直接用与产品降级分支同一个打分函数，而不是故意让 embedding 失败——
  // 预期内的降级不该刷几十行「向量检索失败」告警，那会把真实告警淹掉
  const scored =
    path === 'lexical'
      ? chunks.map((chunk) => ({ chunk, score: lexicalScore(query, chunk.text) }))
      : (await scoreKnowledgeChunks({ query, provider, chunks })).scored
  const top = scored
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, SCALE_TOP_K)
  const scoreMs = performance.now() - scoreStartedAtMs

  if (record) {
    bucket.scans.push(scanMs)
    bucket.scores.push(scoreMs)
    bucket.totals.push(performance.now() - startedAtMs)
    if (top.some((item) => item.chunk.id === targetChunkId)) bucket.hits += 1
  }
}

/** 重排 A/B：同一查询集跑「向量 top-k」与「向量 top-N → 重排 → top-k」两臂 */
async function measureRerank(
  rerank: RerankStage | null,
  provider: EmbeddingProvider,
): Promise<RerankArmMeasurement[] | null> {
  if (rerank === null) return null

  const store = openStore(':memory:')
  try {
    await indexRetrievalCorpus(provider, store)
    for (const document of RERANK_NOISE_CORPUS) {
      store.ensureConversation(document.conversationId, document.title, process.cwd())
      await indexConversationRun({
        provider,
        store,
        conversationId: document.conversationId,
        title: document.title,
        messages: document.messages,
      })
    }

    const plainRecalls: number[] = []
    const rerankRecalls: number[] = []
    const plainRanks: number[] = []
    const rerankRanks: number[] = []
    const rerankDurations: number[] = []

    for (const testCase of RETRIEVAL_CASES) {
      // 重排只对向量路径生效；词法降级用例评的是降级本身，不参与 A/B
      if (testCase.shouldForceLexical) continue

      for (const query of testCase.queries) {
        // recall：期望来源进 top-k 的比例；rank：最早命中的期望来源的名次（未进记 topK+1）
        const gradeHits = (
          hits: Array<{ title: string; chunkIndex: number }>,
        ): { recall: number; rank: number } => {
          const expected = testCase.expectedSources
          if (expected.length === 0) return { recall: 0, rank: testCase.topK + 1 }
          const actual = hits.map((hit) => `${hit.title}#${hit.chunkIndex}`)
          const matched = expected.filter((source) => actual.includes(source))
          const firstPosition = actual.findIndex((source) => expected.includes(source))
          return {
            recall: matched.length / expected.length,
            rank: firstPosition === -1 ? testCase.topK + 1 : firstPosition + 1,
          }
        }

        const plain = await searchConversationHistory({
          query,
          topK: testCase.topK,
          provider,
          store,
          runId: 'rerank-comparison',
          conversationId: 'rerank-comparison',
          rerank: null,
        })
        const plainGrade = gradeHits(plain.hits)
        plainRecalls.push(plainGrade.recall)
        plainRanks.push(plainGrade.rank)

        const reranked = await searchConversationHistory({
          query,
          topK: testCase.topK,
          provider,
          store,
          runId: 'rerank-comparison',
          conversationId: 'rerank-comparison',
          rerank,
        })
        const rerankGrade = gradeHits(reranked.hits)
        rerankRecalls.push(rerankGrade.recall)
        rerankRanks.push(rerankGrade.rank)
        if (reranked.rerank !== null) rerankDurations.push(reranked.rerank.durationMs)
      }
    }

    return [
      {
        label: 'vector',
        recallAtK: average(plainRecalls),
        meanExpectedRank: average(plainRanks),
        medianRerankMs: null,
        queryCount: plainRecalls.length,
      },
      {
        label: 'vector+rerank',
        recallAtK: average(rerankRecalls),
        meanExpectedRank: average(rerankRanks),
        medianRerankMs: rerankDurations.length === 0 ? null : median(rerankDurations),
        queryCount: rerankRecalls.length,
      },
    ]
  } finally {
    store.close()
  }
}

/** 中位数；空数组返回 NaN（调用方保证非空） */
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
