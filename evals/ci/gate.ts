// CI 门槛：只比较 GATED_METRICS；缺失指标或低于门槛都判失败。
import type { EvalMetrics, GateFailure, GateResult, Thresholds } from '../core/types'
import { GATED_METRICS } from '../core/types'

export function evaluateGate(thresholds: Thresholds, metrics: EvalMetrics): GateResult {
  const failures: GateFailure[] = []
  for (const metric of GATED_METRICS) {
    const threshold = thresholds.thresholds[metric]
    if (typeof threshold !== 'number') {
      throw new Error(`门槛配置缺少指标或类型错误: ${metric}`)
    }
    const actual = metrics[metric]
    // 缺字段 / null / NaN 都按失败处理，避免 undefined < threshold 静默通过
    if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < threshold) {
      failures.push({ metric, actual: typeof actual === 'number' ? actual : null, threshold })
    }
  }
  return { passed: failures.length === 0, failures }
}
