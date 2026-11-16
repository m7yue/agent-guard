// 离线 embedding：字符二元组（bigram）哈希入桶的确定性向量。
//
// 两个设计要求：
// 1. 确定性——同一段文本永远得到同一个向量，测试可以写死断言；
// 2. 不是纯噪声——共享字词的文本余弦更高。bigram 入桶给出的是词法信号，
//    没有 embedding-3 的语义能力（"换个说法"搜不到），这是已知边界。
import type { EmbeddingProvider } from './embedding-provider'

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  readonly batchSize: number

  constructor(model: string, dimensions: number, batchSize: number) {
    this.model = model
    this.dimensions = dimensions
    this.batchSize = batchSize
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text))
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions)
    const normalized = text.toLowerCase()

    for (let index = 0; index < normalized.length - 1; index += 1) {
      const bucket = fnv1aBucket(normalized.slice(index, index + 2), this.dimensions)
      vector[bucket] += 1
    }
    return vector
  }
}

/**
 * FNV-1a 32 位哈希：实现只有几行、无依赖、跨进程稳定。
 * 这里只用来把 bigram 均匀撒进向量维度，不需要密码学强度。
 */
function fnv1aBucket(value: string, bucketCount: number): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % bucketCount
}
