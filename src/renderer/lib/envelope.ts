import type { Envelope } from '../../shared/contracts'

// 统一的 envelope 文案：成功/失败都是同一种外层结构，页面用一条路径处理
export function describe<T>(label: string, result: Envelope<T>): string {
  return result.ok
    ? `[${label}] 成功：${JSON.stringify(result.data)}`
    : `[${label}] 失败：${result.error.code} — ${result.error.message}`
}
