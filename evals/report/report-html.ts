// HTML 报告：把 EvalReport 渲染成一个自包含的静态页面。
//
// 设计目标：先看结论，再看失败，再看明细；完整 trace 仍以 JSON 为准。
// 所有动态文本都经过 escapeHtml，避免模型输出 / 工具结果把脚本注入页面。
import { formatDelta, formatMetric, formatMilliseconds, formatPercent, formatPoints } from './format'
import { METRIC_KEYS, METRIC_LABELS } from './metric-labels'
import type {
  ApprovalTraceEvent,
  EvalMetrics,
  EvalReport,
  MemoryCaseResult,
  MemoryUsedTraceEvent,
  MemoryWrittenTraceEvent,
  MetricScope,
  PolicyCaseResult,
  RetrievalCaseResult,
  RetrievalTraceEvent,
  TraceEvent,
  TrialResult,
} from '../core/types'

const STYLES = `
:root {
  --paper: #f4f6f8;
  --panel: #ffffff;
  --ink: #18212b;
  --muted: #5f6b7a;
  --line: #d8dee6;
  --line-strong: #aeb9c6;
  --pass: #1f6b5a;
  --pass-bg: #e7f2ee;
  --fail: #b23a1f;
  --fail-bg: #fbebe6;
  --warn: #7a5600;
  --warn-bg: #faf1dc;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0e141a;
    --panel: #151d25;
    --ink: #e6ebf1;
    --muted: #9aa7b5;
    --line: #26323e;
    --line-strong: #3a4857;
    --pass: #6fcfb3;
    --pass-bg: #122a24;
    --fail: #ff9a7a;
    --fail-bg: #2e1915;
    --warn: #e0b45c;
    --warn-bg: #2a2212;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.55;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 32px 24px 72px; }
.masthead {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 460px);
  gap: 32px;
  padding-bottom: 24px;
  border-bottom: 2px solid var(--ink);
}
.brand { font-family: var(--mono); font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }
h1 { font-family: var(--serif); font-size: clamp(34px, 5vw, 56px); line-height: 1; font-weight: 500; margin: 8px 0 10px; letter-spacing: -0.02em; }
.run-id { font-family: var(--mono); font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin: 0; }
.meta div { border-top: 1px solid var(--line); padding-top: 8px; }
.meta dt { font-size: 11px; color: var(--muted); }
.meta dd { margin: 2px 0 0; font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.verdict {
  display: flex;
  gap: 20px;
  align-items: center;
  margin: 24px 0;
  padding: 18px 20px;
  border: 1px solid var(--line);
  border-left: 6px solid var(--line-strong);
  background: var(--panel);
}
.verdict.pass { border-left-color: var(--pass); }
.verdict.fail { border-left-color: var(--fail); }
.verdict-mark { font-family: var(--mono); font-size: clamp(28px, 4vw, 46px); font-weight: 700; line-height: 1; letter-spacing: -0.04em; }
.verdict.pass .verdict-mark { color: var(--pass); }
.verdict.fail .verdict-mark { color: var(--fail); }
.verdict h2 { margin: 0; font-size: 18px; }
.verdict p { margin: 4px 0 0; color: var(--muted); max-width: 72ch; }
.verdict ul { margin: 8px 0 0; padding-left: 18px; color: var(--fail); }
.banner { margin: 0 0 12px; padding: 10px 14px; border-left: 4px solid var(--line-strong); background: var(--panel); color: var(--muted); font-size: 14px; }
.banner.warn { border-left-color: var(--warn); background: var(--warn-bg); color: var(--ink); }
.banner.info { border-left-color: var(--muted); }
.banner strong { color: var(--ink); }
.section { margin: 32px 0 0; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line-strong); padding-bottom: 8px; margin-bottom: 12px; }
.section-head h2 { margin: 0; font-family: var(--serif); font-size: 24px; font-weight: 500; }
.section-head p { margin: 0; color: var(--muted); font-size: 13px; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); background: var(--panel); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 11px; letter-spacing: 0.03em; padding: 8px 10px; border-bottom: 1px solid var(--line-strong); white-space: nowrap; }
td { padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: top; }
td.num, .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
code { font-family: var(--mono); font-size: 0.92em; }
.metric-row.fail td { background: var(--fail-bg); }
.metric-value { font-family: var(--mono); font-size: 15px; font-weight: 600; }
.meter { display: block; width: 120px; height: 4px; background: var(--line); margin-top: 4px; }
.meter > span { display: block; height: 100%; background: var(--pass); }
.fail .meter > span { background: var(--fail); }
.chip { display: inline-block; padding: 1px 6px; border: 1px solid var(--line-strong); border-radius: 2px; font-family: var(--mono); font-size: 11px; white-space: nowrap; }
.chip.pass { color: var(--pass); border-color: var(--pass); background: var(--pass-bg); }
.chip.fail { color: var(--fail); border-color: var(--fail); background: var(--fail-bg); }
.chip.neutral { color: var(--muted); }
.metric-hint { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.scope { font-size: 11px; color: var(--muted); }
.scripted { display: block; font-size: 10px; color: var(--warn); }
.failure { border: 1px solid var(--fail); border-left: 5px solid var(--fail); background: var(--panel); padding: 12px 14px; margin: 10px 0; }
.failure h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
.failure ul { margin: 0 0 8px; padding-left: 18px; }
.trial { border: 1px solid var(--line); background: var(--panel); margin: 10px 0; }
.trial > summary { cursor: pointer; padding: 10px 12px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.trial[open] > summary { border-bottom: 1px solid var(--line); }
.trial-title { font-family: var(--mono); font-weight: 600; }
.trial-meta { color: var(--muted); font-size: 12px; }
.trial-body { padding: 12px; }
.subhead { margin: 14px 0 6px; font-size: 12px; font-weight: 600; color: var(--muted); }
pre { margin: 0; padding: 10px 12px; background: var(--paper); border: 1px solid var(--line); font-family: var(--mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.error { color: var(--fail); }
.muted { color: var(--muted); }
.mark { font-family: var(--mono); font-weight: 600; }
.mark.pass { color: var(--pass); }
.mark.fail { color: var(--fail); }
.footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--fail); outline-offset: 2px; }
@media (max-width: 720px) {
  .wrap { padding: 20px 14px 48px; }
  .masthead { grid-template-columns: 1fr; gap: 18px; }
  .meta { grid-template-columns: 1fr 1fr; }
  .verdict { align-items: flex-start; flex-direction: column; }
  .section-head { display: block; }
  .section-head p { margin-top: 4px; }
}
@media print {
  body { background: #fff; }
  .wrap { max-width: none; padding: 0; }
  .trial { break-inside: avoid; }
}
`

/** 一次评测报告的 HTML 页面；page 是完整文档，可直接用浏览器打开。 */
export function renderHtmlReport(report: EvalReport, baseline?: EvalReport | null): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${h(`Eval Report · ${report.runId}`)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    '<main class="wrap">',
    renderMasthead(report),
    renderBanners(report),
    renderVerdict(report),
    renderMetrics(report),
    renderFailures(report),
    renderTaskSummary(report),
    renderTrialList(report),
    renderRetrieval(report),
    renderComparison(report),
    renderMemory(report),
    renderPolicy(report),
    baseline ? renderBaseline(report, baseline) : '',
    renderLimitations(report),
    renderFooter(report),
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}

function renderMasthead(report: EvalReport): string {
  return `
<header class="masthead">
  <div>
    <div class="brand">AgentGuard / evals</div>
    <h1>Eval Report</h1>
    <div class="run-id">${h(report.runId)}</div>
  </div>
  <dl class="meta">
    ${metaItem('模式', report.mode)}
    ${metaItem('模型', report.modelName)}
    ${metaItem('裁判', report.judgeName)}
    ${metaItem('Embedding', report.embedding)}
    ${metaItem('开始时间', report.startedAt)}
    ${metaItem('总耗时', formatMilliseconds(report.durationMs))}
    ${metaItem('任务', `${report.tasks.tasks.length} 个`)}
    ${metaItem('Trials', String(report.tasks.summary.totalTrials))}
  </dl>
</header>`
}

function renderBanners(report: EvalReport): string {
  const lines: string[] = []
  if (report.mode === 'mock') {
    lines.push(
      '<p class="banner warn"><strong>mock 演示：</strong>模型输出来自任务脚本，验证的是评测链路，不是模型能力结论。</p>',
    )
  } else {
    lines.push('<p class="banner info"><strong>真实模式：</strong>指标只报告，不进 CI 门槛。</p>')
  }
  if (report.thresholds) {
    const baseline = report.thresholds.baseline
    lines.push(
      `<p class="banner info"><strong>门槛基线：</strong>${h(baseline.measuredAt)}（${h(baseline.mode)}，${baseline.taskCount} 任务 / ${baseline.retrievalCaseCount} 检索用例 / ${baseline.policyCaseCount} 策略用例 / ${baseline.memoryCaseCount} 记忆用例）</p>`,
    )
  }
  return lines.join('\n')
}

function renderVerdict(report: EvalReport): string {
  const gate = report.gate
  if (!gate) {
    return `
<section class="verdict">
  <div class="verdict-mark">REPORT</div>
  <div>
    <h2>仅报告，不设 CI 门槛</h2>
    <p>真实模式：指标用于趋势与排查，不参与自动失败判定。</p>
  </div>
</section>`
  }

  const tone = gate.passed ? 'pass' : 'fail'
  const label = gate.passed ? 'PASS' : 'FAIL'
  const title = gate.passed ? 'CI 门槛通过' : 'CI 门槛未通过'
  const failures = gate.failures
    .map((failure) => {
      return `<li>${h(METRIC_LABELS[failure.metric])}：实际 ${h(formatMetric(failure.metric, failure.actual))}，门槛 ${h(formatMetric(failure.metric, failure.threshold))}</li>`
    })
    .join('')
  return `
<section class="verdict ${tone}">
  <div class="verdict-mark">${label}</div>
  <div>
    <h2>${title}</h2>
    <p>${gate.passed ? '门槛内指标均达到基线。' : '至少一项门槛指标低于基线。'}</p>
    ${gate.passed ? '' : `<ul>${failures}</ul>`}
  </div>
</section>`
}

function renderMetrics(report: EvalReport): string {
  const rows = METRIC_KEYS.map((key) => renderMetricRow(report, key)).join('\n')
  return `
<section class="section">
  <div class="section-head">
    <h2>指标</h2>
    <p>门槛内指标参与 CI；模型指标只报告。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>指标</th><th>值</th><th>口径</th><th>门槛</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <p class="metric-hint">recall@k：前 k 条结果里，期望来源被找到的比例（k 即用例的 topK）。</p>
</section>`
}

function renderMetricRow(report: EvalReport, key: keyof EvalMetrics): string {
  const value = report.metrics[key]
  const threshold = report.thresholds?.thresholds[key]
  const isGated = threshold !== undefined
  const failed = isGated && (value === null || !Number.isFinite(value) || value < threshold)
  const tone = isGated ? (failed ? 'fail' : 'pass') : 'neutral'
  const status = isGated ? (failed ? '低于门槛' : '达标') : '报告'
  const scope = report.scopes[key]
  const scopeText = scopeLabel(scope)
  const scripted = report.mode === 'mock' && scope === 'model' ? '<span class="scripted">mock 脚本值</span>' : ''
  const meter = renderMeter(key, value)
  return `<tr class="metric-row ${tone}">
    <td>${h(METRIC_LABELS[key])}</td>
    <td class="num"><span class="metric-value">${h(formatMetric(key, value))}</span>${meter}</td>
    <td><span class="scope">${h(scopeText)}</span>${scripted}</td>
    <td class="num">${threshold === undefined ? '—' : h(formatMetric(key, threshold))}</td>
    <td><span class="chip ${tone}">${h(status)}</span></td>
  </tr>`
}

/** 0..1 的比例指标画一条细条；耗时和增益不画。 */
function renderMeter(key: keyof EvalMetrics, value: number | null): string {
  if (key === 'averageDurationMs' || key === 'parallelQueryGain') return ''
  if (value === null || !Number.isFinite(value)) return ''
  const width = Math.max(0, Math.min(1, value)) * 100
  return `<span class="meter" aria-hidden="true"><span style="width:${width.toFixed(1)}%"></span></span>`
}

function renderFailures(report: EvalReport): string {
  const failed = report.tasks.trials.filter((trial) => !trial.passed)
  if (failed.length === 0) return ''
  const items = failed
    .map((trial) => {
      const failedChecks = trial.checks.filter((check) => check.required && !check.passed)
      return `<article class="failure">
        <h3><span class="mono">${h(trial.taskId)} / trial ${trial.trial}</span> <span class="chip fail">FAIL</span></h3>
        <ul>${failedChecks.map((check) => `<li><span class="mono">${h(check.id)}</span>：${h(check.message)}</li>`).join('') || '<li class="muted">没有 required 检查失败；看 status 与最终回答。</li>'}</ul>
        ${trial.error ? `<p class="error">agent 错误：${h(trial.error)}</p>` : ''}
        <pre class="answer">${h(excerpt(trial.finalAnswer || '（空回答）', 240))}</pre>
      </article>`
    })
    .join('\n')
  return `
<section class="section">
  <div class="section-head">
    <h2>失败明细</h2>
    <p>${failed.length} 个 trial 未通过；完整检查与轨迹在下方逐 trial 展开。</p>
  </div>
  ${items}
</section>`
}

function renderTaskSummary(report: EvalReport): string {
  if (report.tasks.tasks.length === 0) return ''
  const rows = report.tasks.tasks
    .map(
      (task) => `<tr>
        <td class="mono">${h(task.taskId)}</td>
        <td>${h(task.title)}</td>
        <td class="num">${task.passed}/${task.trials}</td>
        <td class="num">${h(formatPercent(task.successRate))}</td>
        <td class="num">${h(formatMilliseconds(task.averageDurationMs))}</td>
        <td>${task.failures.length === 0 ? '—' : task.failures.map((failure) => h(failure)).join('<br>')}</td>
      </tr>`,
    )
    .join('\n')
  return `
<section class="section">
  <div class="section-head">
    <h2>任务</h2>
    <p>通过条件：run.status 为 ok 且所有 required 检查通过。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>任务</th><th>标题</th><th>通过</th><th>成功率</th><th>平均耗时</th><th>失败检查</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`
}

function renderTrialList(report: EvalReport): string {
  if (report.tasks.trials.length === 0) return ''
  return `
<section class="section">
  <div class="section-head">
    <h2>逐 trial</h2>
    <p>失败项默认展开；完整轨迹见同名 JSON。</p>
  </div>
  ${report.tasks.trials.map((trial) => renderTrial(trial, !trial.passed)).join('\n')}
</section>`
}

function renderTrial(trial: TrialResult, open: boolean): string {
  const tone = trial.passed ? 'pass' : 'fail'
  return `
<details class="trial" ${open ? 'open' : ''}>
  <summary>
    <span class="trial-title">${h(trial.taskId)} / trial ${trial.trial}</span>
    <span class="chip ${tone}">${trial.passed ? 'PASS' : 'FAIL'}</span>
    <span class="trial-meta">status=${h(trial.status)} · ${h(formatMilliseconds(trial.durationMs))}${trial.truncated ? ' · truncated' : ''}</span>
  </summary>
  <div class="trial-body">
    ${renderChecks(trial)}
    <div class="subhead">工具</div>
    <p><span class="muted">请求：</span>${renderToolChips(trial.requestedTools, 'neutral')}</p>
    <p><span class="muted">执行：</span>${renderToolChips(trial.executedTools, 'pass')}</p>
    ${renderApprovals(trial.trace)}
    ${renderRetrievalEvents(trial.trace)}
    <div class="subhead">最终回答</div>
    <pre>${h(trial.finalAnswer || '（空）')}</pre>
    ${trial.error ? `<p class="error">agent 错误：${h(trial.error)}</p>` : ''}
    <details class="trace">
      <summary>完整轨迹（${trial.trace.length} 条）</summary>
      ${renderTrace(trial.trace)}
    </details>
  </div>
</details>`
}

function renderChecks(trial: TrialResult): string {
  const rows = trial.checks
    .map(
      (check) => `<tr>
        <td class="mono">${h(check.id)}</td>
        <td>${h(check.type)}</td>
        <td>${check.required ? '是' : '否'}</td>
        <td>${mark(check.passed)}</td>
        <td>${h(check.message)}</td>
      </tr>`,
    )
    .join('\n')
  return `
<div class="subhead">检查</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>检查</th><th>类型</th><th>必需</th><th>结果</th><th>说明</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
}

function renderToolChips(names: string[], tone: 'pass' | 'neutral'): string {
  if (names.length === 0) return '<span class="muted">无</span>'
  return names.map((name) => `<span class="chip ${tone}">${h(name)}</span>`).join(' ')
}

function renderApprovals(trace: TraceEvent[]): string {
  const approvals = trace.filter((event): event is ApprovalTraceEvent => event.type === 'approval')
  if (approvals.length === 0) return ''
  const rows = approvals
    .map(
      (event) => `<tr>
        <td class="mono">${h(event.toolName)}</td>
        <td>${mark(event.approved)}</td>
        <td>${h(event.reason)}</td>
      </tr>`,
    )
    .join('\n')
  return `
<div class="subhead">审批</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>工具</th><th>放行</th><th>原因</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
}

function renderRetrievalEvents(trace: TraceEvent[]): string {
  const retrievals = trace.filter((event): event is RetrievalTraceEvent => event.type === 'retrieval')
  if (retrievals.length === 0) return ''
  const rows = retrievals
    .map(
      (event) => `<tr>
        <td>${h(event.query)}</td>
        <td>${h(event.mode)}</td>
        <td class="num">${event.topK}</td>
        <td>${event.hits.map((hit) => `${h(hit.source)} <span class="muted">(${hit.score.toFixed(4)})</span>`).join('<br>') || '—'}</td>
      </tr>`,
    )
    .join('\n')
  return `
<div class="subhead">检索</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>查询</th><th>模式</th><th>topK</th><th>命中</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
}

function renderTrace(trace: TraceEvent[]): string {
  if (trace.length === 0) return '<p class="muted">没有轨迹事件。</p>'
  const rows = trace
    .map((event) => {
      if (event.type === 'model') {
        return `<tr><td class="mono">model #${event.turn}</td><td>${h(event.stopReason)} · 请求 ${event.requestedTools.map((name) => h(name)).join(' / ') || '—'}</td><td class="num">${h(formatMilliseconds(event.durationMs))}</td></tr>`
      }
      if (event.type === 'tool') {
        return `<tr><td class="mono">tool</td><td>${h(event.name)} · ${h(excerpt(JSON.stringify(event.args), 120))}<br><span class="muted">${h(excerpt(event.result, 200))}</span></td><td class="num">${h(formatMilliseconds(event.durationMs))}</td></tr>`
      }
      if (event.type === 'tool-denied') {
        return `<tr><td class="mono">tool-denied</td><td>${h(event.name)} · ${h(event.stage)} · ${h(event.reason)}</td><td class="num">—</td></tr>`
      }
      if (event.type === 'approval') {
        return `<tr><td class="mono">approval</td><td>${h(event.toolName)} · ${mark(event.approved)} ${h(event.reason)}</td><td class="num">—</td></tr>`
      }
      if (event.type === 'retrieval') {
        return `<tr><td class="mono">retrieval</td><td>${h(event.query)} · ${h(event.mode)} · ${event.hits.map((hit) => h(hit.source)).join(' / ') || '无命中'}</td><td class="num">—</td></tr>`
      }
      if (event.type === 'memory-used') {
        return `<tr><td class="mono">memory-used</td><td>${h(event.reason)} · ${event.names.map((name) => h(name)).join(' / ') || '无'}${event.mode ? ` · ${h(event.mode)}` : ''}</td><td class="num">—</td></tr>`
      }
      if (event.type === 'memory-written') {
        return `<tr><td class="mono">memory-written</td><td>${h(event.name)} · ${h(event.memoryType)}${event.action === 'updated' ? ' · 更新' : ' · 新增'}</td><td class="num">—</td></tr>`
      }
      return `<tr><td class="mono">log</td><td>${h(event.message)}</td><td class="num">—</td></tr>`
    })
    .join('\n')
  return `
<div class="table-wrap">
  <table>
    <thead><tr><th>事件</th><th>内容</th><th>耗时</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
}

function renderRetrieval(report: EvalReport): string {
  if (report.retrieval.cases.length === 0) return ''
  const rows = report.retrieval.cases.map((testCase) => renderRetrievalCase(testCase)).join('\n')
  const parallel = report.retrieval.cases.find((testCase) => testCase.unionRecall !== undefined)
  const parallelNote = parallel
    ? `<p class="muted">并行双查：单查 recall ${h(formatPercent(parallel.singleQueryRecall ?? null))}，并集 recall ${h(formatPercent(parallel.unionRecall ?? null))}，增益 ${h(formatPoints(report.metrics.parallelQueryGain))}，额外 embedding 调用 ${parallel.extraEmbeddingCalls ?? 0} 次/用例。</p>`
    : ''
  return `
<section class="section">
  <div class="section-head">
    <h2>检索用例</h2>
    <p>期望来源用 <code>会话标题#块序号</code> 表示。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>用例</th><th>查询</th><th>topK</th><th>模式</th><th>recall</th><th>期望来源名次</th><th>审计</th><th>耗时</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${parallelNote}
</section>`
}

function renderRetrievalCase(testCase: RetrievalCaseResult): string {
  const ranks = testCase.expectedSources
    .map((source) => {
      const hit = testCase.hits.find((item) => item.source === source)
      return `${h(source)} <span class="muted">${hit?.rank == null ? '未命中' : `#${hit.rank}`}</span>`
    })
    .join('<br>')
  return `<tr>
    <td class="mono">${h(testCase.id)}</td>
    <td>${testCase.queries.map((query) => h(query)).join('<br>')}</td>
    <td class="num">${testCase.topK}</td>
    <td>${h(testCase.mode)}</td>
    <td class="num">${h(formatPercent(testCase.recall))}</td>
    <td>${ranks || '—'}</td>
    <td class="num">${testCase.auditEvents}/${testCase.queries.length}</td>
    <td class="num">${h(formatMilliseconds(testCase.durationMs))}</td>
  </tr>`
}

function renderComparison(report: EvalReport): string {
  const comparison = report.comparison
  const scaleRows = comparison.scales
    .flatMap((scale) =>
      scale.paths.map(
        (path) => `<tr>
        <td class="num">${scale.corpusChunks}</td>
        <td class="mono">${h(path.path)}</td>
        <td class="num">${h(formatPercent(path.recallAtK))}</td>
        <td class="num">${h(formatMilliseconds(path.medianLatencyMs))}</td>
        <td class="num">${path.medianScanMs === null ? '—' : h(formatMilliseconds(path.medianScanMs))}</td>
        <td class="num">${h(formatMilliseconds(path.medianScoreMs))}</td>
      </tr>`,
      ),
    )
    .join('\n')
  const buildNote = comparison.scales
    .map((scale) => `${scale.corpusChunks} 块 ${h(formatMilliseconds(scale.vec0IndexBuildMs))}`)
    .join('；')
  const rerankBlock =
    comparison.rerankComparison !== null
      ? `<div class="subhead">重排 A/B（重排臂: ${h(comparison.rerankLabel)}，同一查询集）</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>臂</th><th>recall@k</th><th>期望来源平均名次</th><th>重排耗时中位</th><th>查询数</th></tr></thead>
    <tbody>
      ${comparison.rerankComparison
        .map(
          (arm) => `<tr>
        <td class="mono">${h(arm.label)}</td>
        <td class="num">${h(formatPercent(arm.recallAtK))}</td>
        <td class="num">${arm.meanExpectedRank === null ? '—' : `#${arm.meanExpectedRank.toFixed(1)}`}</td>
        <td class="num">${arm.medianRerankMs === null ? '—' : h(formatMilliseconds(arm.medianRerankMs))}</td>
        <td class="num">${arm.queryCount}</td>
      </tr>`,
        )
        .join('\n')}
    </tbody>
  </table>
</div>
<p class="muted">重排增益: ${h(formatPoints(report.metrics.rerankRecallGain))}。</p>`
      : '<p class="muted">重排 A/B 未运行（重排未配置）。</p>'
  const methodology = comparison.methodology.map((item) => `<li>${h(item)}</li>`).join('')
  return `
<section class="section">
  <div class="section-head">
    <h2>检索对比（重排）</h2>
    <p>词法 / 暴力 / vec0 × 规模；重排 A/B。规模对比用离线 embedding（${h(comparison.embeddingLabel)}）。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>语料块数</th><th>路径</th><th>recall@k</th><th>端到端中位</th><th>扫描中位</th><th>打分中位</th></tr></thead>
      <tbody>${scaleRows}</tbody>
    </table>
  </div>
  <p class="muted">vec0 建索引（一次性）: ${buildNote}。</p>
  ${rerankBlock}
  <div class="subhead">方法与口径</div>
  <ul class="muted">${methodology}</ul>
</section>`
}

function renderMemory(report: EvalReport): string {
  if (report.memory.cases.length === 0) return ''
  const rows = report.memory.cases.map((testCase) => renderMemoryCase(testCase)).join('\n')
  return `
<section class="section">
  <div class="section-head">
    <h2>记忆用例</h2>
    <p>删会话隔离 / 噪声隔离 / 纠正；向量降级只报告。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>用例</th><th>类别</th><th>结果</th><th>选择 recall</th><th>降级 recall</th><th>索引</th><th>隔离</th><th>耗时</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`
}

function renderMemoryCase(testCase: MemoryCaseResult): string {
  const flag = (value: boolean | null): string => (value === null ? '—' : value ? '是' : '否')
  return `<tr>
    <td class="mono">${h(testCase.id)}</td>
    <td>${h(testCase.kind)}</td>
    <td>${testCase.passed ? '<span class="chip pass">PASS</span>' : '<span class="chip fail">FAIL</span>'} <span class="muted">${h(testCase.detail)}</span></td>
    <td class="num">${h(formatPercent(testCase.selectionRecall))}</td>
    <td class="num">${h(formatPercent(testCase.vectorFallbackRecall))}</td>
    <td>${flag(testCase.indexed)}</td>
    <td>${flag(testCase.isolated)}</td>
    <td class="num">${h(formatMilliseconds(testCase.durationMs))}</td>
  </tr>`
}

function renderPolicy(report: EvalReport): string {
  if (report.policy.cases.length === 0) return ''
  const rows = report.policy.cases.map((testCase) => renderPolicyCase(testCase)).join('\n')
  return `
<section class="section">
  <div class="section-head">
    <h2>策略用例</h2>
    <p>allow / ask / deny 的审批请求与工具执行是否符合期望。</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>用例</th><th>工具</th><th>决策</th><th>审批 expected/actual</th><th>执行 expected/actual</th><th>结果</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`
}

function renderPolicyCase(testCase: PolicyCaseResult): string {
  const decisionMatches = testCase.actualDecision === testCase.expectedDecision
  const approvalMatches = testCase.hasAskedApproval === testCase.shouldAskApproval
  const executionMatches = testCase.hasExecutedTool === testCase.shouldExecuteTool
  return `<tr>
    <td class="mono">${h(testCase.id)}</td>
    <td class="mono">${h(testCase.tool)}</td>
    <td>${h(testCase.expectedDecision)} → ${h(testCase.actualDecision)} ${decisionMatches ? '' : mark(false)}</td>
    <td>${testCase.shouldAskApproval ? '是' : '否'} / ${testCase.hasAskedApproval ? '是' : '否'} ${approvalMatches ? '' : mark(false)}</td>
    <td>${testCase.shouldExecuteTool ? '是' : '否'} / ${testCase.hasExecutedTool ? '是' : '否'} ${executionMatches ? '' : mark(false)}</td>
    <td>${testCase.passed ? '<span class="chip pass">PASS</span>' : '<span class="chip fail">FAIL</span>'} <span class="muted">${h(testCase.message)}</span></td>
  </tr>`
}

function renderBaseline(report: EvalReport, baseline: EvalReport): string {
  const rows = METRIC_KEYS.map((key) => {
    const before = baseline.metrics[key]
    const current = report.metrics[key]
    return `<tr>
      <td>${h(METRIC_LABELS[key])}</td>
      <td class="num">${h(formatMetric(key, before))}</td>
      <td class="num">${h(formatMetric(key, current))}</td>
      <td class="num">${h(formatDelta(key, before, current))}</td>
    </tr>`
  }).join('\n')
  const mismatch =
    baseline.mode !== report.mode ||
    baseline.modelName !== report.modelName ||
    baseline.tasks.tasks.length !== report.tasks.tasks.length ||
    baseline.retrieval.cases.length !== report.retrieval.cases.length ||
    baseline.policy.cases.length !== report.policy.cases.length ||
    baseline.memory.cases.length !== report.memory.cases.length
  return `
<section class="section">
  <div class="section-head">
    <h2>与基线对比</h2>
    <p>基线：${h(baseline.runId)}</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>指标</th><th>基线</th><th>候选</th><th>变化</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  ${mismatch ? '<p class="banner warn">基线与候选的模式、模型或用例集不同，对比只能作参考。</p>' : ''}
  <p class="muted">样本小，变化可能只是波动；先看任务通过率，再看检索与延迟。</p>
</section>`
}

function renderLimitations(report: EvalReport): string {
  if (report.limitations.length === 0) return ''
  return `
<section class="section">
  <div class="section-head"><h2>限制</h2></div>
  <ul>${report.limitations.map((limitation) => `<li>${h(limitation)}</li>`).join('')}</ul>
</section>`
}

function renderFooter(report: EvalReport): string {
  return `
<footer class="footer">
  <span>AgentGuard · schemaVersion ${report.schemaVersion}</span>
  <span>完整轨迹见同目录的同名 .json 文件</span>
</footer>`
}

function metaItem(label: string, value: string): string {
  return `<div><dt>${h(label)}</dt><dd>${h(value)}</dd></div>`
}

function scopeLabel(scope: MetricScope): string {
  return scope === 'pipeline' ? '管道 / CI' : '模型能力'
}

function mark(value: boolean): string {
  return `<span class="mark ${value ? 'pass' : 'fail'}">${value ? '✓' : '✗'}</span>`
}

function excerpt(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine
}

function h(value: unknown): string {
  return escapeHtml(String(value))
}

/** 转义动态文本；HTML 报告里最终回答、工具结果、检索原文都不可信。 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
