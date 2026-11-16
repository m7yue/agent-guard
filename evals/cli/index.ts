// Evals CLI：装配 AgentRunner、策略套件、检索套件，跑任务并写报告。
//
//   npm run evals        # mock + 策略 + 检索 + 任务脚本；CI 门槛
//   npm run evals:check  # 评测器自检：correct 必过、wrong 必败
//   npm run evals:real   # 真实模型；指标只报告，不进 CI
//
// 模式只由 --real 决定，不读 .env 里的运行模式；.env 只提供端点与 token。
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { FakeEmbeddingProvider } from '../../src/harness/knowledge/fake-embedding-provider'
import { createEmbeddingProvider } from '../../src/harness/knowledge/embedding-provider'
import { FakeRerankProvider } from '../../src/harness/knowledge/fake-rerank-provider'
import { ZhipuRerankProvider } from '../../src/harness/knowledge/zhipu-rerank-provider'
import type { RerankStage } from '../../src/harness/knowledge/rerank-provider'
import { getModelConfig } from '../../src/harness/model/config'
import { HarnessAgentRunner } from '../core/agent-runner'
import { formatMilliseconds, formatPercent, formatPoints } from '../report/format'
import { evaluateGate } from '../ci/gate'
import { EVALS_ROOT } from '../core/paths'
import { runPolicySuite } from '../suites/policy-suite'
import { runMemorySuite } from '../suites/memory-suite'
import { loadReport, writeReport } from '../report/report'
import { runRetrievalSuite } from '../suites/retrieval-suite'
import { runRetrievalComparisonSuite } from '../suites/retrieval-comparison/comparison-suite'
import { runEvals } from '../core/runner'
import { loadTasks } from '../core/task-loader'
import { THRESHOLDS } from '../ci/thresholds'
import type { EvalMetrics, EvalReport, LoadedTask, RunMode, RunOptions } from '../core/types'
import { METRIC_SCOPES } from '../core/types'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      real: { type: 'boolean', default: false },
      tasks: { type: 'string' },
      trials: { type: 'string' },
      baseline: { type: 'string' },
      out: { type: 'string' },
      'keep-workspace': { type: 'boolean', default: false },
      'keep-io': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })

  if (values.help) {
    printUsage()
    return
  }

  if (values.check && (values.real || values.trials !== undefined || values.baseline !== undefined)) {
    throw new Error('--check 不支持与 --real / --trials / --baseline 组合')
  }

  const tasks = loadTasks(parseTaskIds(values.tasks))
  if (tasks.length === 0) throw new Error('没有可运行的任务')

  if (values.check) {
    await runSelfCheck(tasks)
    return
  }

  const mode: RunMode = values.real ? 'real' : 'mock'
  const trials = parseTrials(values.trials)
  const modelConfig = getModelConfig()
  if (mode === 'real' && !modelConfig) {
    throw new Error('real 模式需要 AGENTGUARD_MODEL_AUTH_TOKEN / AGENTGUARD_MODEL_ID，请先配置 .env')
  }

  const baseline = values.baseline ? loadReport(values.baseline) : null
  const thresholds = mode === 'mock' ? THRESHOLDS : null
  const runId = createRunId(mode)
  const outputBase = values.out ?? join(EVALS_ROOT, 'results', runId, 'report')
  const startedAt = new Date()
  const startedMs = performance.now()

  const provider =
    mode === 'mock'
      ? new FakeEmbeddingProvider('fake-embedding', 1024, 32)
      : createEmbeddingProvider()
  // createEmbeddingProvider 在缺 key / 配错 provider 时会回退 fake；
  // 报告标实际类型，避免把 bigram 假向量写成 embedding-3。
  const isFakeEmbedding = provider instanceof FakeEmbeddingProvider
  const embeddingLabel = isFakeEmbedding
    ? `fake-embedding/${provider.dimensions}`
    : `${provider.model}/${provider.dimensions}`
  if (mode === 'real' && isFakeEmbedding) {
    console.warn('[evals] 真实模式未拿到真实 embedding provider，报告标为 fake-embedding。')
  }

  // 策略用例失败进报告；policyDecisionAccuracy / hardDenyInterceptionRate 进门槛。
  // 检索套件异常会让整次运行退出。
  const policyReport = await runPolicySuite()
  const retrievalReport = await runRetrievalSuite({ provider, embeddingLabel })
  const memoryReport = await runMemorySuite({ provider, embeddingLabel })

  // 重排 对比套件。规模对比固定用离线 fake embedding（测的是管道开销曲线，不是语义质量，
  // 也让 real 模式不必为 20k 块付 embedding 费用）；重排臂 mock 用 fake 重排验证管道，
  // real 用智谱 rerank 出真实数字（只报告）——评测测的是能力，不受 AGENTGUARD_RERANK_PROVIDER
  // 的产品开关约束。
  const comparisonRerankStage = createComparisonRerankStage(mode)
  const comparisonReport = await runRetrievalComparisonSuite({
    scaleProvider: new FakeEmbeddingProvider('fake-embedding', 1024, 32),
    scaleEmbeddingLabel: 'fake-embedding/1024',
    rerank: comparisonRerankStage.stage,
    rerankLabel: comparisonRerankStage.label,
    rerankProvider: provider,
  })
  const rerankRecallGain =
    comparisonReport.rerankComparison !== null
      ? (comparisonReport.rerankComparison[1]?.recallAtK ?? 0) -
        (comparisonReport.rerankComparison[0]?.recallAtK ?? 0)
      : null

  const runOptions: RunOptions = {
    mode,
    script: 'correct',
    trials,
    modelName: mode === 'mock' ? 'mock' : modelConfig?.model ?? 'unknown',
    judgeName: 'keyword',
    keepWorkspace: values['keep-workspace'] ?? false,
    keepIo: values['keep-io'] ?? false,
    onWorkspaceKept: (workspacePath) => console.log(`[evals] 保留工作区: ${workspacePath}`),
    onIoKept: (trialFilesPath) => console.log(`[evals] 保留 trial 文件: ${trialFilesPath}`),
  }
  const taskReport = await runEvals(tasks, new HarnessAgentRunner(), runOptions)

  const metrics: EvalMetrics = {
    retrievalRecallAtK: retrievalReport.metrics.retrievalRecallAtK,
    parallelQueryGain: retrievalReport.metrics.parallelQueryGain,
    lexicalFallbackRecall: retrievalReport.metrics.lexicalFallbackRecall,
    retrievalAuditRate: retrievalReport.metrics.retrievalAuditRate,
    policyDecisionAccuracy: policyReport.metrics.policyDecisionAccuracy,
    hardDenyInterceptionRate: policyReport.metrics.hardDenyInterceptionRate,
    approvalBehaviorAccuracy: policyReport.metrics.approvalBehaviorAccuracy,
    pipelineSuccessRate: taskReport.summary.successRate,
    toolSelectionAccuracy: taskReport.metrics.toolSelectionAccuracy,
    answerKeyPointHitRate: taskReport.metrics.answerKeyPointHitRate,
    citationHitRate: taskReport.metrics.citationHitRate,
    memorySuitePassRate: memoryReport.metrics.memorySuitePassRate,
    memorySelectionRecallAtK: memoryReport.metrics.memorySelectionRecallAtK,
    memoryVectorFallbackRecallAtK: memoryReport.metrics.memoryVectorFallbackRecallAtK,
    memoryWriteIndexRate: memoryReport.metrics.memoryWriteIndexRate,
    memoryPersistenceRate: memoryReport.metrics.memoryPersistenceRate,
    rerankRecallGain,
    averageDurationMs: taskReport.summary.averageDurationMs,
  }
  const gateResult = thresholds ? evaluateGate(thresholds, metrics) : null

  const report: EvalReport = {
    schemaVersion: 4,
    runId,
    mode,
    modelName: runOptions.modelName,
    judgeName: runOptions.judgeName,
    embedding: embeddingLabel,
    startedAt: startedAt.toISOString(),
    durationMs: performance.now() - startedMs,
    metrics,
    scopes: METRIC_SCOPES,
    tasks: taskReport,
    policy: policyReport,
    retrieval: retrievalReport,
    comparison: comparisonReport,
    memory: memoryReport,
    thresholds,
    gate: gateResult,
    limitations: buildLimitations(mode, trials, embeddingLabel),
  }

  const reportPaths = writeReport(report, outputBase, baseline)
  printSummary(report, reportPaths, trials)
  if (gateResult && !gateResult.passed) process.exitCode = 1
}

/** 对比套件的重排臂：mock 固定 fake（确定性）；real 用智谱（缺 key 时无重排臂，报告标 off） */
function createComparisonRerankStage(mode: RunMode): { stage: RerankStage | null; label: string } {
  if (mode === 'mock') {
    return { stage: { provider: new FakeRerankProvider('fake-rerank'), candidateCount: 20 }, label: 'fake-rerank' }
  }

  const apiKey = (process.env.AGENTGUARD_ZHIPU_API_KEY || '').trim()
  if (!apiKey) return { stage: null, label: 'off（缺 AGENTGUARD_ZHIPU_API_KEY）' }
  return { stage: { provider: new ZhipuRerankProvider({ apiKey, model: 'rerank' }), candidateCount: 20 }, label: 'rerank' }
}

/** 用同一套 Runner 与检查器跑 correct / wrong：correct 必过，wrong 必至少失败一项。 */
async function runSelfCheck(tasks: LoadedTask[]): Promise<void> {
  const agentRunner = new HarnessAgentRunner()
  let failures = 0

  for (const task of tasks) {
    const baseOptions: RunOptions = {
      mode: 'mock',
      script: 'correct',
      trials: 1,
      modelName: 'mock',
      judgeName: 'keyword',
      keepWorkspace: false,
      keepIo: false,
    }
    const correctReport = await runEvals([task], agentRunner, baseOptions)
    const wrongReport = await runEvals([task], agentRunner, { ...baseOptions, script: 'wrong' })

    const correctOk = correctReport.summary.passedTrials === 1
    const wrongOk = wrongReport.summary.passedTrials === 0
    if (!correctOk) failures += 1
    if (!wrongOk) failures += 1

    console.log(`${correctOk ? '✓' : '✗'} ${task.id} correct: ${correctReport.summary.passedTrials}/1 通过`)
    console.log(`${wrongOk ? '✓' : '✗'} ${task.id} wrong: ${wrongReport.summary.passedTrials}/1 通过（预期 0）`)

    if (!correctOk) {
      for (const trial of correctReport.trials) {
        for (const check of trial.checks.filter((item) => !item.passed)) {
          console.log(`    correct 失败: ${check.id}: ${check.message}`)
        }
        if (trial.error) console.log(`    correct 错误: ${trial.error}`)
      }
    }
    if (!wrongOk) {
      for (const trial of wrongReport.trials) {
        for (const check of trial.checks.filter((item) => item.passed)) {
          console.log(`    wrong 仍通过: ${check.id}`)
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`[evals:check] 有 ${failures} 项不符合预期`)
    process.exitCode = 1
    return
  }
  console.log(`[evals:check] 全部 ${tasks.length} 个任务的 correct/wrong 符合预期`)
}

function printSummary(
  report: EvalReport,
  reportPaths: { jsonPath: string; markdownPath: string; htmlPath: string },
  trials: number,
): void {
  const { summary } = report.tasks
  console.log(
    `[evals] 模式: ${report.mode} | 任务: ${report.tasks.tasks.length} | trials: ${trials}`,
  )
  console.log(
    `[evals] 任务通过率: ${summary.passedTrials}/${summary.totalTrials} (${formatPercent(
      summary.successRate,
    )})`,
  )
  console.log(
    `[evals] 记忆用例: ${report.memory.cases.filter((testCase) => testCase.passed).length}/${
      report.memory.cases.length
    }`,
  )
  const comparison = report.comparison
  if (comparison.rerankComparison !== null) {
    const [plainArm, rerankArm] = comparison.rerankComparison
    const rankText = (value: number | null | undefined): string =>
      value === null || value === undefined ? '—' : `名次 #${value.toFixed(1)}`
    console.log(
      `[evals] 重排对比（${comparison.rerankLabel}）: 向量 ${formatPercent(
        plainArm?.recallAtK ?? null,
      )}（${rankText(plainArm?.meanExpectedRank)}） → 重排 ${formatPercent(
        rerankArm?.recallAtK ?? null,
      )}（${rankText(rerankArm?.meanExpectedRank)}）（增益 ${formatPoints(
        report.metrics.rerankRecallGain,
      )}，重排中位 ${formatMilliseconds(rerankArm?.medianRerankMs ?? null)}/查询）`,
    )
  }
  const largestScale = comparison.scales[comparison.scales.length - 1]
  if (largestScale) {
    const brutePath = largestScale.paths.find((path) => path.path === 'vector-brute')
    const vec0Path = largestScale.paths.find((path) => path.path === 'vector-vec0')
    console.log(
      `[evals] 规模对比（${largestScale.corpusChunks} 块）: 暴力 ${formatMilliseconds(
        brutePath?.medianLatencyMs ?? null,
      )} vs vec0 ${formatMilliseconds(vec0Path?.medianLatencyMs ?? null)}（每查询中位）`,
    )
  }
  console.log(`[evals] 全部指标: ${formatAllMetrics(report.metrics)}`)
  if (report.mode === 'mock') {
    console.log('[evals] mock 演示：模型指标来自任务脚本，验证的是评测链路，不是模型能力。')
  } else {
    console.log('[evals] 真实模式：指标只报告，不进 CI 门槛。')
  }
  if (report.gate && !report.gate.passed) {
    console.error('[evals] CI 门槛未通过：')
    for (const failure of report.gate.failures) {
      console.error(
        `  - ${failure.metric}: 实际 ${formatPercent(failure.actual)}，门槛 ${formatPercent(
          failure.threshold,
        )}`,
      )
    }
  }
  console.log(`[evals] 报告: ${reportPaths.markdownPath}`)
  console.log(`[evals] HTML: ${reportPaths.htmlPath}`)
  console.log(`[evals] JSON: ${reportPaths.jsonPath}`)
}

function formatAllMetrics(metrics: EvalMetrics): string {
  return [
    `检索召回@k=${formatPercent(metrics.retrievalRecallAtK)}`,
    `并行双查=${formatPoints(metrics.parallelQueryGain)}`,
    `词法降级=${formatPercent(metrics.lexicalFallbackRecall)}`,
    `检索审计=${formatPercent(metrics.retrievalAuditRate)}`,
    `审批决策=${formatPercent(metrics.policyDecisionAccuracy)}`,
    `硬拒绝=${formatPercent(metrics.hardDenyInterceptionRate)}`,
    `审批行为=${formatPercent(metrics.approvalBehaviorAccuracy)}`,
    `任务通过=${formatPercent(metrics.pipelineSuccessRate)}`,
    `工具选择=${formatPercent(metrics.toolSelectionAccuracy)}`,
    `要点命中=${formatPercent(metrics.answerKeyPointHitRate)}`,
    `引用=${formatPercent(metrics.citationHitRate)}`,
    `记忆通过=${formatPercent(metrics.memorySuitePassRate)}`,
    `记忆选择=${formatPercent(metrics.memorySelectionRecallAtK)}`,
    `记忆降级=${formatPercent(metrics.memoryVectorFallbackRecallAtK)}`,
    `记忆索引=${formatPercent(metrics.memoryWriteIndexRate)}`,
    `记忆持久化=${formatPercent(metrics.memoryPersistenceRate)}`,
    `重排增益=${formatPoints(metrics.rerankRecallGain)}`,
    `平均耗时=${formatMilliseconds(metrics.averageDurationMs)}`,
  ].join(' | ')
}

function buildLimitations(mode: RunMode, trials: number, embedding: string): string[] {
  const usesFakeEmbedding = embedding.startsWith('fake-embedding')
  const limitations = [
    `检索 recall 是各用例 recall 的算术平均；并行双查用例按两次查询的并集计算。`,
    `耗时包含子进程启动与 tsx 解析；每个 trial 是单次观测，不是基准测试。`,
    `答案要点只做字面（大小写不敏感）匹配，没有 LLM 裁判；同义表达可能漏判。`,
    `command 检查用 sh -lc，Windows 兼容性留到 Windows 适配。`,
    `父进程超时只杀 agent 子进程，不保证清理其派生的 shell 子进程；run_command 自身另有 timeout。`,
    `本次每个任务 ${trials} 次 trial；真实模型有随机性，样本小时只看趋势。`,
    `记忆套件用脚本选择器验证管道（选择/写入/持久化/删会话隔离/纠正）；模型是否选中由真实模式验证。`,
    `记忆向量降级用例用 fake embedding 的 bigram 信号，只证明降级路径可用，不代表语义检索质量。`,
    `规模对比（词法/暴力/vec0）用合成语料与离线 embedding，延迟只做同机相对比较，不外推绝对值；vec0 建索引为一次性成本。`,
    mode === 'mock'
      ? `重排对比用 fake 重排（词法信号），只验证重排阶段接进管道，不是重排质量结论；质量数字看 real 模式。`
      : `重排对比用智谱 rerank，recall 为同一查询集 A/B；真实模型有随机性，单次观测只看趋势。`,
  ]
  if (usesFakeEmbedding) {
    limitations.push(
      `embedding=${embedding}；fake embedding 只做 bigram 哈希，recall 反映检索管道排序，不代表语义 embedding 质量。`,
    )
  } else {
    limitations.push(`embedding=${embedding}；语义召回质量受模型与语料影响，不能外推到其他语料。`)
  }
  if (mode === 'mock') {
    limitations.unshift('mock 模式的模型输出来自任务脚本，只验证评测链路，不构成模型能力结论。')
  }
  return limitations
}

function parseTaskIds(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const ids = value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (ids.length === 0) throw new Error('--tasks 不能为空')
  return ids
}

function parseTrials(value: string | undefined): number {
  if (value === undefined) return 1
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--trials 必须是正整数，收到: ${value}`)
  }
  return parsed
}

function createRunId(mode: RunMode): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  const random = Math.random().toString(36).slice(2, 8)
  return `${stamp}-${mode}-${random}`
}

function printUsage(): void {
  console.log(`用法: npm run evals [-- 选项]

  --real            真实模型（默认 mock；需要 AGENTGUARD_MODEL_*）
  --tasks a,b       只跑指定任务
  --trials N        每个任务跑 N 次（默认 1）
  --baseline PATH   与基线报告对比
  --out PATH        报告输出前缀（默认 evals/results/<runId>/report）
  --keep-workspace  保留 trial 工作区
  --keep-io         保留 prompt/trace/result
  --check           评测器自检：correct 必过、wrong 必败（忽略 --out / --keep-*）
  --help            显示本帮助`)
}

void main().catch((error) => {
  console.error(`[evals] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
