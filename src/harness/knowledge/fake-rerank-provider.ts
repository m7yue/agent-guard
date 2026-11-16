// 离线重排：确定性的假实现，mock 评测与单元测试用。
//
// 打分复用检索的词法 bigram 重合率——不模拟语义，只保证两点：
// 共享字词多的候选排前；同输入永远同输出（可断言）。
// 它验证的是「重排阶段被正确接进管道」，不是重排质量；
// 质量结论只能来自真实模式（evals:real + 智谱 rerank），这条边界写进报告 limitations。
import { lexicalScore } from './searcher'
import type { RerankProvider, RerankResult } from './rerank-provider'

export class FakeRerankProvider implements RerankProvider {
  readonly model: string

  constructor(model: string) {
    this.model = model
  }

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (documents.length === 0) return []

    return documents
      .map((document, index) => ({
        index,
        relevanceScore: lexicalScore(query, document),
      }))
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
  }
}
