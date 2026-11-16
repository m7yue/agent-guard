// 智谱文本重排序：POST /api/paas/v4/rerank，query + documents → 相关度分数。
//
// 实测规格（2026-11-11，命令与输出见设计文档）：
// - 请求体 { model, query, documents: string[], top_n? }；top_n 缺省返回全部候选。
// - 约束是字符数不是条数：query + documents 总长 ≤ 32k 字符，超限 HTTP 400 / code 1210。
//   本项目按 500 字/块 × 20 候选 ≈ 10k 字符，余量充足；这里再按条截断兜底。
// - 响应 results: [{ index, relevance_score }]，实测按分数降序返回；这里仍自行排序，
//   不把正确性押在服务端的返回顺序上。
//
// 重试与错误分类和 zhipu-embedding-provider 同形状（429/5xx/网络错误指数退避；
// 4xx 不重试；1113 余额不足不重试）。两处近似重复是刻意为之：两个实例先复制，
// 出现第三处再抽公共层——提前抽象会让两个调用点的差异（批量/单查询、归位逻辑）糊进同一层。
import { getLogger } from '../logging/logger'
import type { RerankProvider, RerankResult } from './rerank-provider'

const ZHIPU_RERANK_URL = 'https://open.bigmodel.cn/api/paas/v4/rerank'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 4
const DEFAULT_BASE_RETRY_DELAY_MS = 500
/**
 * 单条候选送出的字符上限：20 条 × 1200 = 24k，加上查询（检索词量级）仍在 32k 之内。
 * 截断只影响送出去的文本，不影响候选数量——index 必须与输入一一对应，否则调用方映射错位。
 */
const MAX_DOCUMENT_CHARS = 1_200
/** query + documents 的接口字符上限（实测超限返回 400 / code 1210） */
const MAX_TOTAL_CHARS = 30_000

/** 带 HTTP 状态码的错误：重试策略要区分「可重试的状态码」与「调用方的问题」 */
class RerankHttpError extends Error {
  /** 响应体里的业务错误码（如 '1210'）；解析不出为 null */
  readonly errorCode: string | null

  constructor(readonly status: number, readonly body: string) {
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

export interface ZhipuRerankOptions {
  /** 智谱 API 密钥（Bearer 头） */
  apiKey: string
  /** 模型名（实测可用值 rerank；随配置更新） */
  model: string
  /** 单请求超时（毫秒） */
  timeoutMs?: number
  /** 退避基准延迟（毫秒）；测试里调小，避免真等 */
  baseRetryDelayMs?: number
  /** 请求实现；默认全局 fetch，测试注入脚本化应答 */
  fetchImpl?: typeof fetch
}

interface ZhipuRerankResponse {
  results: Array<{ index: number; relevance_score: number }>
}

export class ZhipuRerankProvider implements RerankProvider {
  readonly model: string

  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly baseRetryDelayMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: ZhipuRerankOptions) {
    this.apiKey = options.apiKey
    this.model = options.model
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    if (documents.length === 0) return []

    let lastError: unknown = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.requestOnce(query, documents)
      } catch (error) {
        lastError = error
        // 4xx（429 除外）是调用方的问题，重试不会有不同结果
        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break

        const delayMs = this.baseRetryDelayMs * 2 ** (attempt - 1)
        getLogger('knowledge').warn('rerank 请求失败，退避后重试', {
          attempt,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
        })
        await sleep(delayMs)
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`rerank 请求失败（共尝试 ${MAX_ATTEMPTS} 次）：${detail}`)
  }

  private async requestOnce(query: string, documents: string[]): Promise<RerankResult[]> {
    const truncated = documents.map((document) => document.slice(0, MAX_DOCUMENT_CHARS))
    const totalChars = query.length + truncated.reduce((sum, text) => sum + text.length, 0)
    // 超限直接抛而不是丢候选：丢候选会破坏 index 映射，让调用方拿到错位的重排结果
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new Error(`rerank 输入超长：${totalChars} 字符 > ${MAX_TOTAL_CHARS} 上限`)
    }

    const response = await this.fetchImpl(ZHIPU_RERANK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, query, documents: truncated }),
      signal: AbortSignal.timeout(this.timeoutMs),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new RerankHttpError(response.status, body.slice(0, 200))
    }

    const json = (await response.json()) as ZhipuRerankResponse
    if (!Array.isArray(json.results)) {
      throw new Error('rerank 返回缺少 results 数组')
    }

    // 自行按分数降序，不依赖服务端排序；越界 index（响应异常）直接丢弃而不是报错——
    // 其余候选的重排结果仍然有效，错一条不该让整次重排作废
    return json.results
      .filter(
        (item) =>
          Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length,
      )
      .map((item) => ({ index: item.index, relevanceScore: item.relevance_score }))
      .sort((left, right) => right.relevanceScore - left.relevanceScore)
  }
}

/** 网络层错误（超时/断连）落在 RerankHttpError 之外，默认可重试 */
function isRetryable(error: unknown): boolean {
  if (error instanceof RerankHttpError) {
    // 智谱 1113 = 余额不足：充值不会发生在重试窗口内，重试是纯空转（与 embedding 实测一致）
    if (error.errorCode === '1113') return false
    return error.status === 429 || error.status >= 500
  }
  return true
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
