// 重排提供方：对「向量检索已选出的候选池」按与查询的相关度重新打分排序。
//
// 定位（重排）：向量召回负责「从全库捞出大概相关的一池」（top-N，N 默认 20），
// 重排负责「在这一池里精排出最终 top-k」——用一次更重的在线调用换更准的排序。
// 与 embedding 的分工：embedding 离线、批量、便宜，负责「能不能被捞到」；
// 重排在线、逐查询、贵，负责「捞到的谁更相关」，因此只喂小候选池。
//
// 工厂与 embedding-provider 同一思路：AGENTGUARD_RERANK_PROVIDER 未配置（默认 off）
// 返回 null——检索行为与 会话检索 完全一致；配置了但缺 key 时降级为 null 而不是抛错，
// 重排是回答质量的增强，配置疏漏不应该让对话挂掉（与词法降级同一哲学）。
import { getLogger } from '../logging/logger'
import { loadEnvOnce } from '../model/config'
import { FakeRerankProvider } from './fake-rerank-provider'
import { ZhipuRerankProvider } from './zhipu-rerank-provider'

export type RerankProviderKind = 'zhipu' | 'fake'

/** 一条重排结果：下标指回调用方传入的 documents，分数只保证可用于排序 */
export interface RerankResult {
  /** 候选在输入 documents 数组里的下标 */
  index: number
  /** 相关度分数（智谱 rerank 实测落在 0..1，见设计文档；用于排序与审计展示，不跨模型可比） */
  relevanceScore: number
}

export interface RerankProvider {
  /** 模型名（进审计 payload 与报告） */
  readonly model: string
  /**
   * 重排一批候选：返回按相关度降序的 RerankResult，index 指回输入位置。
   * documents 为空时直接返回空数组，不发请求。
   * 实现自带超时与重试；抛错由调用方降级（退回原排序），不让检索失败。
   */
  rerank(query: string, documents: string[]): Promise<RerankResult[]>
}

/** 检索管道的重排阶段：提供方 + 喂给它多大的候选池（top-N 的 N） */
export interface RerankStage {
  provider: RerankProvider
  /** 向量排序后取前多少条进重排；最终 top-k 从重排结果里取 */
  candidateCount: number
}

/** 默认候选池大小：500 字/块 × 20 ≈ 10k 字符，在智谱 32k 字符上限内留足余量 */
const DEFAULT_CANDIDATE_COUNT = 20

/**
 * 工厂：按 .env 的 AGENTGUARD_RERANK_PROVIDER 组装重排阶段（zhipu | fake；未配置或 off → null）。
 *
 * off 是默认值：重排让每次检索多一次在线调用，是否启用由使用者按 重排 的对比数字明确决定。
 */
export function createRerankStage(): RerankStage | null {
  loadEnvOnce()

  const kind = process.env.AGENTGUARD_RERANK_PROVIDER?.trim()
  if (!kind || kind === 'off') return null

  const model = (process.env.AGENTGUARD_RERANK_MODEL || 'rerank').trim()
  const candidateCount = Math.max(
    1,
    Number(process.env.AGENTGUARD_RERANK_CANDIDATES) || DEFAULT_CANDIDATE_COUNT,
  )

  if (kind === 'zhipu') {
    const apiKey = (process.env.AGENTGUARD_ZHIPU_API_KEY || '').trim()
    if (!apiKey) {
      getLogger('knowledge').warn('AGENTGUARD_RERANK_PROVIDER=zhipu 但缺少 AGENTGUARD_ZHIPU_API_KEY，不重排')
      return null
    }
    return { provider: new ZhipuRerankProvider({ apiKey, model }), candidateCount }
  }

  if (kind === 'fake') {
    return { provider: new FakeRerankProvider(model), candidateCount }
  }

  getLogger('knowledge').warn(
    `AGENTGUARD_RERANK_PROVIDER 未识别：${kind}，不重排（可选值 zhipu | fake | off）`,
  )
  return null
}
