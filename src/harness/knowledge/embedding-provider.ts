// embedding 提供方：把一段文本变成一个定长向量（一串浮点数）。
//
// 与 model/ 的 createModel() 同一思路：配置了才联网，没配置走离线实现，
// 测试与无 key 环境永远不因缺密钥而挂掉。
//
// 铁律（继承自参照项目 runtime/embedding.ts）：存向量与查向量必须用同一个
// 模型与维度，否则两边的余弦相似度没有意义。model / dimensions / batchSize
// 因此是提供方的只读属性，索引与检索共用同一个实例。
import { getLogger } from '../logging/logger'
import { loadEnvOnce } from '../model/config'
import { FakeEmbeddingProvider } from './fake-embedding-provider'
import { ZhipuEmbeddingProvider } from './zhipu-embedding-provider'

export type EmbeddingProviderKind = 'zhipu' | 'fake'

export interface EmbeddingProvider {
  /** 模型名（写入 embeddings.model，是"存量向量还能不能比"的判据） */
  readonly model: string
  /** 向量维度（256–2048，随模型配置） */
  readonly dimensions: number
  /** 单次请求的批量上限；调用方不自己分批，embed 内部处理 */
  readonly batchSize: number
  /**
   * 批量嵌入：内部按 batchSize 分批请求，返回顺序与输入一致。
   * texts 为空时直接返回空数组，不发请求。
   */
  embed(texts: string[]): Promise<Float32Array[]>
}

/** 智谱接口单次最多 64 条 input，环境变量配大了也按这个上限收口 */
const ZHIPU_BATCH_LIMIT = 64

/**
 * 工厂：按 .env 的 AGENTGUARD_EMBEDDING_PROVIDER 选实现（zhipu | fake，默认 fake）。
 *
 * 配了 zhipu 但缺 AGENTGUARD_ZHIPU_API_KEY 时不抛错：降级到 fake 并记日志——
 * 检索是回答质量的增强，配置疏漏不应该让对话挂掉（降级链的第一环）。
 * 变量名带 AGENTGUARD_ 前缀的原因见 model/config.ts 的注释（E-07）。
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  loadEnvOnce()

  const kind = (process.env.AGENTGUARD_EMBEDDING_PROVIDER || 'fake').trim() as EmbeddingProviderKind
  const model = (process.env.AGENTGUARD_EMBEDDING_MODEL || 'embedding-3').trim()
  const dimensions = Number(process.env.AGENTGUARD_EMBEDDING_DIMENSIONS) || 1024
  const batchSize = Math.min(
    ZHIPU_BATCH_LIMIT,
    Math.max(1, Number(process.env.AGENTGUARD_EMBEDDING_BATCH) || 32),
  )

  if (kind === 'zhipu') {
    const apiKey = (process.env.AGENTGUARD_ZHIPU_API_KEY || '').trim()
    if (!apiKey) {
      getLogger('knowledge').warn('AGENTGUARD_EMBEDDING_PROVIDER=zhipu 但缺少 AGENTGUARD_ZHIPU_API_KEY，回退 fake')
      return new FakeEmbeddingProvider(model, dimensions, batchSize)
    }
    return new ZhipuEmbeddingProvider({ apiKey, model, dimensions, batchSize })
  }

  // 配错值（如 zhihu）：与"缺 key 回退"同等透明——先告警再按 fake 运行，不让对话挂掉
  if (kind !== 'fake') {
    getLogger('knowledge').warn(`AGENTGUARD_EMBEDDING_PROVIDER 未识别：${kind}，按 fake 运行（可选值 zhipu | fake）`)
  }
  return new FakeEmbeddingProvider(model, dimensions, batchSize)
}
