// 报告与 CLI 共用的格式化函数。
import type { EvalMetrics } from '../core/types'

export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(1)}%`
}

export function formatPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`
}

export function formatMilliseconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}ms`
}

/** 按指标类型选择百分比 / 百分点 / 毫秒。 */
export function formatMetric(key: keyof EvalMetrics, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (key === 'averageDurationMs') return formatMilliseconds(value)
  if (key === 'parallelQueryGain' || key === 'rerankRecallGain') return formatPoints(value)
  return formatPercent(value)
}

/** 两个指标值之间的变化；耗时用 ms，其余用百分点。 */
export function formatDelta(
  key: keyof EvalMetrics,
  baseline: number | null,
  current: number | null,
): string {
  if (
    baseline === null ||
    current === null ||
    !Number.isFinite(baseline) ||
    !Number.isFinite(current)
  ) {
    return '—'
  }
  const delta = current - baseline
  if (key === 'averageDurationMs') {
    return `${delta >= 0 ? '+' : ''}${Math.round(delta)}ms`
  }
  return `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}pp`
}
