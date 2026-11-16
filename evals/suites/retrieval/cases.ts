// 检索用例：期望来源用「会话标题#块序号」表示，与工具返回的 source 格式一致。
export interface RetrievalCase {
  /** 用例 id，报告里用它定位失败项。 */
  id: string
  /** 一个或多个查询；多个查询模拟模型的并行双查。 */
  queries: string[]
  /** 返回条数上限。 */
  topK: number
  /** 期望出现在 top-k 的来源，格式为 `会话标题#块序号`。 */
  expectedSources: string[]
  /** 用抛错的 provider 强制走词法降级。 */
  shouldForceLexical?: boolean
  /** 计算单查 recall 与并集 recall 的差值。 */
  shouldMeasureParallelGain?: boolean
}

export const RETRIEVAL_CASES: RetrievalCase[] = [
  {
    id: 'favicon-recall',
    queries: ['上次说的 favicon 方案是什么'],
    topK: 3,
    expectedSources: ['favicon 方案讨论#0'],
  },
  {
    id: 'proper-noun-interference',
    queries: ['7yue 下午有什么安排'],
    topK: 3,
    expectedSources: ['下午的安排#0'],
  },
  {
    id: 'noise-denial',
    queries: ['之前讨论过的 favicon 方案是什么'],
    topK: 3,
    expectedSources: ['favicon 方案讨论#0'],
  },
  {
    id: 'parallel-double-query',
    queries: ['7yue 下午的安排 日程', '7yue 下午要去做的事 待办'],
    topK: 3,
    expectedSources: ['下午的安排#0'],
    shouldMeasureParallelGain: true,
  },
  {
    id: 'lexical-fallback',
    queries: ['favicon 方案'],
    topK: 3,
    expectedSources: ['favicon 方案讨论#0'],
    shouldForceLexical: true,
  },
]
