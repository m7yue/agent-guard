// 真实模型的配置：baseUrl / token / model / 预算。
//
// 放在 model/ 下，因为它只描述"模型怎么连"；运行模式（mock/real）由 createModel() 根据"有没有配置"直接推导。
export interface ModelConfig {
  baseUrl: string
  apiKey: string
  authHeader: 'apiKey' | 'authToken'
  model: string
  maxTokens: number
  timeoutMs: number
}

let envLoaded = false

export function loadEnvOnce(): void {
  if (envLoaded) return
  envLoaded = true
  try {
    process.loadEnvFile()
  } catch {
    // 没有 .env 是正常情况
  }
}

// SDK 会自行追加 /v1/messages，这里去掉尾部 / 与 /v1，避免路径重复
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

// 缺少 token 或 AGENTGUARD_MODEL_ID 时返回 null，表示"未配置真实模型"，调用方回落到脚本模型
//
// 变量一律带 AGENTGUARD_ 前缀（与 AGENTGUARD_WORKSPACE / AGENTGUARD_STATE_DIR 同一约定）。
// 不用 ANTHROPIC_* 这类生态名的原因：它们是 Claude 工具链的事实保留名，终端里常见的
// 导出会压过 .env（process.loadEnvFile() 不覆盖已存在的变量），形成静默的混合配置——
// 实测踩过，见 `.env.example` 的命名说明（2026-11-09 改名根治）。
export function getModelConfig(): ModelConfig | null {
  loadEnvOnce()

  const authToken = (process.env.AGENTGUARD_MODEL_AUTH_TOKEN || '').trim()
  const apiKey = (process.env.AGENTGUARD_MODEL_API_KEY || '').trim()
  const token = authToken || apiKey
  const model = (process.env.AGENTGUARD_MODEL_ID || '').trim()
  if (!token || !model) return null

  return {
    baseUrl: (process.env.AGENTGUARD_MODEL_BASE_URL || 'https://api.anthropic.com').trim(),
    apiKey: token,
    authHeader: authToken ? 'authToken' : 'apiKey',
    model,
    maxTokens: Number(process.env.AGENTGUARD_MODEL_MAX_TOKENS) || 512,
    timeoutMs: Number(process.env.AGENTGUARD_MODEL_TIMEOUT_MS) || 60_000,
  }
}
