// 报告输出：JSON 给机器读，Markdown 给人读。
//
// 渲染函数是纯函数，不读磁盘、不发请求，测试里可以直接断言输出；
// 写文件与基线读取放在文件末尾。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { formatDelta, formatMetric, formatMilliseconds, formatPercent } from './format'
import { METRIC_KEYS, METRIC_LABELS } from './metric-labels'
import { renderHtmlReport } from './report-html'
import type { EvalReport, MetricScope } from '../core/types'

export function renderReport(report: EvalReport, baseline?: EvalReport | null): string {
  const lines: string[] = []
  lines.push(`# Eval Report: ${report.runId}`)
  lines.push('')
  lines.push(`- 模式: ${report.mode}`)
  lines.push(`- 模型: ${report.modelName}`)
  lines.push(`- 裁判: ${report.judgeName}`)
  lines.push(`- Embedding: ${report.embedding}`)
  lines.push(`- 开始时间: ${report.startedAt}`)
  lines.push(`- 总耗时: ${formatMilliseconds(report.durationMs)}`)
  if (report.thresholds) {
    lines.push(
      `- 门槛基线: ${report.thresholds.baseline.measuredAt}（${report.thresholds.baseline.mode}，${report.thresholds.baseline.taskCount} 任务 / ${report.thresholds.baseline.retrievalCaseCount} 检索用例 / ${report.thresholds.baseline.policyCaseCount} 策略用例 / ${report.thresholds.baseline.memoryCaseCount} 记忆用例）`,
    )
  }
  lines.push('')
  lines.push(
    `**一句话**: 任务通过率 ${formatPercent(report.metrics.pipelineSuccessRate)}，前 k 条召回率（recall@k） ${formatPercent(
      report.metrics.retrievalRecallAtK,
    )}，平均耗时 ${formatMilliseconds(report.metrics.averageDurationMs)}`,
  )

  if (report.mode === 'mock') {
    lines.push('')
    lines.push('> mock 演示：模型指标来自任务脚本，验证的是评测链路，不是模型能力结论。')
  }
  if (report.gate) {
    lines.push('')
    lines.push(
      report.gate.passed
        ? '> CI 门槛：通过。'
        : `> CI 门槛：未通过（${report.gate.failures
            .map((failure) => `${METRIC_LABELS[failure.metric]} ${formatMetric(failure.metric, failure.actual)} < ${formatMetric(failure.metric, failure.threshold)}`)
            .join('；')}）。`,
    )
  }

  lines.push('')
  lines.push('## 指标')
  lines.push('')
  lines.push('| 指标 | 值 | 口径 | 门槛 |')
  lines.push('| --- | --- | --- | --- |')
  for (const key of METRIC_KEYS) {
    const threshold = report.thresholds?.thresholds[key]
    lines.push(
      `| ${METRIC_LABELS[key]} | ${formatMetric(key, report.metrics[key])} | ${scopeLabel(
        report.scopes[key],
      )} | ${threshold === undefined ? '—' : formatMetric(key, threshold)} |`,
    )
  }

  lines.push('')
  lines.push('## 逐任务')
  lines.push('')
  lines.push('| 任务 | 通过 | 成功率 | 平均耗时 | 失败检查 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const task of report.tasks.tasks) {
    lines.push(
      `| ${task.taskId} | ${task.passed}/${task.trials} | ${formatPercent(task.successRate)} | ${formatMilliseconds(
        task.averageDurationMs,
      )} | ${task.failures.length === 0 ? '—' : task.failures.join('<br>')} |`,
    )
  }

  const failedTrials = report.tasks.trials.filter((trial) => !trial.passed)
  if (failedTrials.length > 0) {
    lines.push('')
    lines.push('## 失败明细')
    for (const trial of failedTrials) {
      lines.push('')
      lines.push(`### ${trial.taskId} / trial ${trial.trial}`)
      for (const check of trial.checks.filter((item) => item.required && !item.passed)) {
        lines.push(`- ${check.id}: ${check.message}`)
      }
      if (trial.error) lines.push(`- agent 错误: ${trial.error}`)
      if (trial.finalAnswer) lines.push(`- 最终回答摘录: ${excerpt(trial.finalAnswer)}`)
    }
  }

  lines.push('')
  lines.push('## 检索用例')
  lines.push('')
  lines.push('| 用例 | recall | 模式 | 期望来源名次 | 审计事件 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const testCase of report.retrieval.cases) {
    const rankText = testCase.expectedSources
      .map((source) => {
        const hit = testCase.hits.find((item) => item.source === source)
        return hit?.rank === null || hit?.rank === undefined ? `${source}: 未命中` : `${source}: #${hit.rank}`
      })
      .join('<br>')
    lines.push(
      `| ${testCase.id} | ${formatPercent(testCase.recall)} | ${testCase.mode} | ${rankText} | ${testCase.auditEvents}/${testCase.queries.length} |`,
    )
  }
  const parallelCase = report.retrieval.cases.find(
    (testCase) => testCase.unionRecall !== undefined,
  )
  if (parallelCase) {
    lines.push('')
    lines.push(
      `并行双查：单查 recall ${formatPercent(parallelCase.singleQueryRecall ?? null)}，并集 recall ${formatPercent(
        parallelCase.unionRecall ?? null,
      )}，增益 ${formatMetric('parallelQueryGain', report.metrics.parallelQueryGain)}，额外 embedding 调用 ${
        parallelCase.extraEmbeddingCalls ?? 0
      } 次/用例。`,
    )
  }

  lines.push('')
  lines.push('## 检索对比（重排：词法 / 暴力 / vec0 × 规模，重排 A/B）')
  lines.push('')
  lines.push(`规模对比 embedding: ${report.comparison.embeddingLabel}（离线，测管道开销曲线）`)
  lines.push('')
  lines.push('| 语料块数 | 路径 | recall@k | 端到端中位 | 扫描中位 | 打分中位 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const scale of report.comparison.scales) {
    for (const path of scale.paths) {
      lines.push(
        `| ${scale.corpusChunks} | ${path.path} | ${formatPercent(path.recallAtK)} | ${formatMilliseconds(
          path.medianLatencyMs,
        )} | ${path.medianScanMs === null ? '—' : formatMilliseconds(path.medianScanMs)} | ${formatMilliseconds(
          path.medianScoreMs,
        )} |`,
      )
    }
  }
  lines.push('')
  lines.push(
    `vec0 建索引（一次性）: ${report.comparison.scales
      .map((scale) => `${scale.corpusChunks} 块 ${formatMilliseconds(scale.vec0IndexBuildMs)}`)
      .join('；')}`,
  )

  if (report.comparison.rerankComparison !== null) {
    const [plainArm, rerankArm] = report.comparison.rerankComparison
    lines.push('')
    lines.push(`重排 A/B（重排臂: ${report.comparison.rerankLabel}，同一查询集）`)
    lines.push('')
    lines.push('| 臂 | recall@k | 期望来源平均名次 | 重排耗时中位 | 查询数 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const arm of [plainArm, rerankArm]) {
      if (!arm) continue
      lines.push(
        `| ${arm.label} | ${formatPercent(arm.recallAtK)} | ${
          arm.meanExpectedRank === null ? '—' : `#${arm.meanExpectedRank.toFixed(1)}`
        } | ${arm.medianRerankMs === null ? '—' : formatMilliseconds(arm.medianRerankMs)} | ${arm.queryCount} |`,
      )
    }
    lines.push('')
    lines.push(`重排增益: ${formatMetric('rerankRecallGain', report.metrics.rerankRecallGain)}`)
  }
  lines.push('')
  lines.push('方法与口径：')
  for (const item of report.comparison.methodology) lines.push(`- ${item}`)

  lines.push('')
  lines.push('## 记忆用例')
  lines.push('')
  lines.push('| 用例 | 类别 | 结果 | 选择 recall | 降级 recall | 索引 | 隔离 | 耗时 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const testCase of report.memory.cases) {
    lines.push(
      `| ${testCase.id} | ${testCase.kind} | ${testCase.passed ? '通过' : '失败'} | ${formatPercent(
        testCase.selectionRecall,
      )} | ${formatPercent(testCase.vectorFallbackRecall)} | ${formatFlag(
        testCase.indexed,
      )} | ${formatFlag(testCase.isolated)} | ${formatMilliseconds(testCase.durationMs)} |`,
    )
  }
  lines.push('')
  lines.push(
    '> 删会话隔离、噪声隔离与纠正用例断言的是 会话检索 结构上做不到的行为；向量降级 recall 只报告，不进门槛。',
  )

  const failedPolicyCases = report.policy.cases.filter((testCase) => !testCase.passed)
  if (failedPolicyCases.length > 0) {
    lines.push('')
    lines.push('## 策略用例失败')
    for (const testCase of failedPolicyCases) {
      lines.push(`- ${testCase.id}: ${testCase.message}`)
    }
  }

  if (baseline) {
    lines.push('')
    lines.push('## 与基线对比')
    lines.push('')
    lines.push(`基线: ${baseline.runId}`)
    lines.push('')
    lines.push('| 指标 | 基线 | 候选 | 变化 |')
    lines.push('| --- | --- | --- | --- |')
    for (const key of METRIC_KEYS) {
      const baselineValue = baseline.metrics[key]
      const currentValue = report.metrics[key]
      lines.push(
        `| ${METRIC_LABELS[key]} | ${formatMetric(key, baselineValue)} | ${formatMetric(
          key,
          currentValue,
        )} | ${formatDelta(key, baselineValue, currentValue)} |`,
      )
    }
    const sameTaskSet = sameIds(
      baseline.tasks.tasks.map((task) => task.taskId),
      report.tasks.tasks.map((task) => task.taskId),
    )
    const sameRetrievalSet = sameIds(
      baseline.retrieval.cases.map((testCase) => testCase.id),
      report.retrieval.cases.map((testCase) => testCase.id),
    )
    const samePolicySet = sameIds(
      baseline.policy.cases.map((testCase) => testCase.id),
      report.policy.cases.map((testCase) => testCase.id),
    )
    const sameMemorySet = sameIds(
      baseline.memory.cases.map((testCase) => testCase.id),
      report.memory.cases.map((testCase) => testCase.id),
    )
    const sameShape =
      baseline.mode === report.mode &&
      baseline.modelName === report.modelName &&
      sameTaskSet &&
      sameRetrievalSet &&
      samePolicySet &&
      sameMemorySet
    if (!sameShape) {
      lines.push('')
      lines.push('> 注意：基线与候选的模式、模型或用例集不同，对比只能作参考。')
    }
    lines.push('')
    lines.push('> 样本小，变化可能只是波动；先看任务通过率，再看检索与延迟。')
  }

  lines.push('')
  lines.push('## 限制')
  for (const limitation of report.limitations) lines.push(`- ${limitation}`)
  lines.push('')
  return lines.join('\n')
}

export function writeReport(
  report: EvalReport,
  outputBase: string,
  baseline?: EvalReport | null,
): { jsonPath: string; markdownPath: string; htmlPath: string } {
  mkdirSync(dirname(outputBase), { recursive: true })
  const jsonPath = `${outputBase}.json`
  const markdownPath = `${outputBase}.md`
  const htmlPath = `${outputBase}.html`
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  writeFileSync(markdownPath, renderReport(report, baseline), 'utf8')
  writeFileSync(htmlPath, renderHtmlReport(report, baseline), 'utf8')
  return { jsonPath, markdownPath, htmlPath }
}

export function loadReport(path: string): EvalReport {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as EvalReport
  if (raw.schemaVersion !== 4) {
    throw new Error(`基线报告 schemaVersion 不是 4: ${path}`)
  }
  return raw
}

function scopeLabel(scope: MetricScope): string {
  return scope === 'pipeline' ? '管道 / CI' : '模型能力'
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

/** 记忆用例里的布尔列：不适用显示 — */
function formatFlag(value: boolean | null): string {
  if (value === null) return '—'
  return value ? '是' : '否'
}

const EXCERPT_LIMIT = 200

function excerpt(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > EXCERPT_LIMIT ? `${oneLine.slice(0, EXCERPT_LIMIT)}…` : oneLine
}
