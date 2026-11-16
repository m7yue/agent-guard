// 智谱 embedding-3：POST /api/paas/v4/embeddings，OpenAI 风格的批量接口。
//
// 与参照项目 runtime/embedding.ts 的差别（也是它没有的能力）：
// 批量 input（一次最多 64 条）、429/5xx/网络错误指数退避、单请求超时。
// 批量不是优化：索引一轮对话就是一批 chunk，逐条请求既慢又容易撞限流。
import { getLogger } from '../logging/logger'
import type { EmbeddingProvider } from './embedding-provider'

const ZHIPU_EMBEDDINGS_URL = 'https://open.bigmodel.cn/api/paas/v4/embeddings'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 4
const DEFAULT_BASE_RETRY_DELAY_MS = 500

/** 带 HTTP 状态码的错误：重试策略要区分"可重试的状态码"与"配置错误" */
class EmbeddingHttpError extends Error {
  /** 响应体里的业务错误码（如智谱的 '1113'）；解析不出为 null */
  readonly errorCode: string | null

  constructor(readonly status: number, readonly body: string) {
    // 智谱把"余额不足"也用 429 返回（body 里 code=1113）：状态码不足以诊断，body 必须带进错误。
    // 实测：仅凭 429 会误判为限流并空转重试（2026-11-09 实测）。
    super(`HTTP ${status}${body ? `：${body}` : ''}`)
    this.errorCode = parseErrorCode(body)
  }
}

/** 从响应体解析 { error: { code } }；不是这个形状返回 null */
function parseErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string } }
    return parsed.error?.code ?? null
  } catch {
    return null
  }
}

export interface ZhipuEmbeddingOptions {
  /** 智谱 API 密钥（Bearer 头） */
  apiKey: string
  /** 模型名（写入 embeddings.model，换模型即换存量的判据） */
  model: string
  /** 向量维度（256–2048，随模型配置） */
  dimensions: number
  /** 单次请求的批量上限（智谱接口最多 64） */
  batchSize: number
  /** 单请求超时（毫秒） */
  timeoutMs?: number
  /** 退避基准延迟（毫秒）；测试里调小，避免真等 */
  baseRetryDelayMs?: number
  /** 请求实现；默认全局 fetch，测试注入脚本化应答 */
  fetchImpl?: typeof fetch
}

interface ZhipuEmbeddingResponse {
  /** 嵌入结果；返回顺序不保证与 input 一致，按每项的 index 归位 */
  data: Array<{ embedding: number[]; index: number }>
}

export class ZhipuEmbeddingProvider implements EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  readonly batchSize: number

  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly baseRetryDelayMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: ZhipuEmbeddingOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.dimensions = options.dimensions
    this.batchSize = options.batchSize
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    // 批与批之间串行：撞限流时并行只会让退避更挤
    const batches: Float32Array[][] = []
    for (let start = 0; start < texts.length; start += this.batchSize) {
      batches.push(await this.embedBatch(texts.slice(start, start + this.batchSize)))
    }
    return batches.flat()
  }

  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(batch)
      } catch (error) {
        lastError = error
        // 4xx（429 除外）是调用方的问题，重试不会有不同结果
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break

        const delayMs = this.baseRetryDelayMs * 2 ** (attempt - 1)
        getLogger('knowledge').warn('embedding 请求失败，退避后重试', {
          attempt,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
        })
        await sleep(delayMs)
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`embedding 请求失败（共尝试 ${MAX_ATTEMPTS} 次）：${detail}`)
  }

  private async requestOnce(batch: string[]): Promise<Float32Array[]> {
    const response = await this.fetchImpl(ZHIPU_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: batch, dimensions: this.dimensions }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new EmbeddingHttpError(response.status, body.slice(0, 200))
    }

    const json = (await response.json()) as ZhipuEmbeddingResponse
    // 返回顺序不保证与 input 一致，按 index 归位（OpenAI 风格接口的惯例）
    const sorted = [...json.data].sort((a, b) => a.index - b.index)
    if (sorted.length !== batch.length) {
      throw new Error(`返回条数不符：期望 ${batch.length}，得到 ${sorted.length}`)
    }

    return sorted.map((item) => {
      if (item.embedding.length !== this.dimensions) {
        throw new Error(`返回维度不符：期望 ${this.dimensions}，得到 ${item.embedding.length}`)
      }
      return Float32Array.from(item.embedding)
    })
  }
}

/** 网络层错误（超时/断连）落在 EmbeddingHttpError 之外，默认可重试 */
function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError) {
    // 智谱 1113 = 余额不足（包在 429 里）：充值不会发生在重试窗口内，重试是纯空转
    if (error.errorCode === '1113') return false
    return error.status === 429 || error.status >= 500
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
