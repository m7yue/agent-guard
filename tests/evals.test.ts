import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeEmbeddingProvider } from '../src/harness/knowledge/fake-embedding-provider'
import { FakeRerankProvider } from '../src/harness/knowledge/fake-rerank-provider'
import { runRetrievalComparisonSuite } from '../evals/suites/retrieval-comparison/comparison-suite'
import { finalTurn, ScriptedModel, toolTurn } from '../src/harness/model/scripted-model'
import { runAgentTask } from '../src/harness/run-agent'
import { scoreAnswerKeyPoints } from '../evals/core/answer-key-points'
import { evaluateChecks } from '../evals/core/checks'
import { formatPercent } from '../evals/report/format'
import { evaluateGate } from '../evals/ci/gate'
import { loadReport, renderReport } from '../evals/report/report'
import { renderHtmlReport } from '../evals/report/report-html'
import { runRetrievalSuite } from '../evals/suites/retrieval-suite'
import { runMemorySuite } from '../evals/suites/memory-suite'
import { renderTemplate, renderValue } from '../evals/core/render'
import { runEvals } from '../evals/core/runner'
import type { TaskDefinition } from '../evals/core/task-definition'
import { validateTaskDefinition } from '../evals/core/task-definition'
import type {
  AgentRunner,
  EvalMetrics,
  EvalReport,
  LoadedTask,
  RunOptions,
  Thresholds,
  TraceEvent,
  TrialResult,
} from '../evals/core/types'
import { METRIC_SCOPES } from '../evals/core/types'

const dirs: string[] = []

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

const emptyMetrics: EvalMetrics = {
  retrievalRecallAtK: null,
  parallelQueryGain: null,
  lexicalFallbackRecall: null,
  retrievalAuditRate: null,
  policyDecisionAccuracy: null,
  hardDenyInterceptionRate: null,
  approvalBehaviorAccuracy: null,
  pipelineSuccessRate: null,
  toolSelectionAccuracy: null,
  answerKeyPointHitRate: null,
  citationHitRate: null,
  memorySuitePassRate: null,
  memorySelectionRecallAtK: null,
  memoryVectorFallbackRecallAtK: null,
  memoryWriteIndexRate: null,
  memoryPersistenceRate: null,
  rerankRecallGain: null,
  averageDurationMs: null,
}

function makeEmptyReport(): EvalReport {
  return {
    schemaVersion: 4,
    runId: 'unit-report',
    mode: 'mock',
    modelName: 'mock',
    judgeName: 'keyword',
    embedding: 'fake-embedding/8',
    startedAt: '2026-11-10T00:00:00Z',
    durationMs: 1,
    metrics: emptyMetrics,
    scopes: METRIC_SCOPES,
    tasks: {
      trials: [],
      tasks: [],
      summary: { totalTrials: 0, passedTrials: 0, successRate: 0, averageDurationMs: 0 },
      metrics: {
        toolSelectionAccuracy: null,
        answerKeyPointHitRate: null,
        citationHitRate: null,
        expectedApprovalFlowRate: null,
      },
    },
    policy: {
      cases: [],
      metrics: {
        policyDecisionAccuracy: null,
        hardDenyInterceptionRate: null,
        approvalBehaviorAccuracy: null,
      },
    },
    retrieval: {
      cases: [],
      metrics: {
        retrievalRecallAtK: null,
        parallelQueryGain: null,
        lexicalFallbackRecall: null,
        retrievalAuditRate: null,
        averageDurationMs: null,
      },
      embedding: 'fake-embedding/8',
    },
    comparison: {
      scales: [],
      rerankComparison: null,
      rerankLabel: 'off',
      embeddingLabel: 'fake-embedding/1024',
      methodology: ['单元测试：无对比数据'],
    },
    memory: {
      cases: [],
      metrics: {
        memorySuitePassRate: null,
        memorySelectionRecallAtK: null,
        memoryVectorFallbackRecallAtK: null,
        memoryWriteIndexRate: null,
        memoryPersistenceRate: null,
      },
      embedding: 'fake-embedding/8',
    },
    thresholds: null,
    gate: null,
    limitations: ['单元测试限制'],
  }
}

const baseTask: TaskDefinition = {
  id: 'test-task',
  title: '测试任务',
  timeoutMs: 1_000,
  maxTurns: 2,
  expectKeywords: ['ok'],
  expectedTools: ['read_file'],
  allowedExtraTools: [],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: false,
  checks: [{ id: 'answer', type: 'final-answer', contains: ['ok'], required: true }],
  mockCorrectTurns: [
    { tool: 'read_file', args: { path: 'a.txt' } },
    { answer: 'ok' },
  ],
  mockWrongTurns: [{ answer: 'no' }],
}

describe('任务定义校验', () => {
  it('合法定义通过，id 与目录名不一致时失败', () => {
    expect(validateTaskDefinition(baseTask, 'test-task').id).toBe('test-task')
    expect(() => validateTaskDefinition(baseTask, 'other-id')).toThrow(/id 与目录名不一致/)
  })

  it('检查 id 重复时报错', () => {
    const definition = {
      ...baseTask,
      checks: [baseTask.checks[0], baseTask.checks[0]],
    }
    expect(() => validateTaskDefinition(definition)).toThrow(/检查 id 重复/)
  })

  it('mock 回合最后一步不是 answer 时报错', () => {
    const definition = {
      ...baseTask,
      mockCorrectTurns: [{ tool: 'read_file', args: { path: 'a.txt' } }],
    }
    expect(() => validateTaskDefinition(definition)).toThrow(/最后一步必须是 answer/)
  })

  it('mock 回合为空时给出可读错误，而不是 in-operator TypeError', () => {
    const definition = { ...baseTask, mockCorrectTurns: [] }
    expect(() => validateTaskDefinition(definition)).toThrow(/至少需要一步/)
  })

  it('approval=grant 与 expectedApproval=denied 矛盾时报错', () => {
    const definition = { ...baseTask, approval: 'grant', expectedApproval: 'denied' }
    expect(() => validateTaskDefinition(definition)).toThrow(/expectedApproval 不能是 denied/)
  })
})

describe('声明式检查', () => {
  it('file-content / file-missing / file-unchanged / command / final-answer / tools-used 的通过与否', async () => {
    const base = makeDir('agentguard-checks-')
    const workspace = path.join(base, 'workspace')
    const outside = path.join(base, 'outside')
    const fixture = path.join(base, 'fixture')
    mkdirSync(path.join(workspace, 'docs'), { recursive: true })
    mkdirSync(path.join(fixture, 'docs'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(path.join(workspace, 'docs', 'architecture.md'), 'AUTH_TTL_MINUTES = 47\n')
    writeFileSync(path.join(fixture, 'docs', 'architecture.md'), 'AUTH_TTL_MINUTES = 47\n')

    const trace: TraceEvent[] = [
      { type: 'tool', name: 'read_file', args: {}, result: 'ok', durationMs: 1 },
    ]
    const results = await evaluateChecks(
      [
        { id: 'content-ok', type: 'file-content', path: 'docs/architecture.md', contains: '47' },
        { id: 'content-fail', type: 'file-content', path: 'docs/architecture.md', contains: '48' },
        { id: 'missing-ok', type: 'file-missing', path: '{{OUTSIDE}}/report.md' },
        { id: 'unchanged-ok', type: 'file-unchanged', path: 'docs/architecture.md' },
        {
          id: 'command-ok',
          type: 'command',
          command: 'printf command-ok',
          stdoutContains: 'command-ok',
        },
        { id: 'answer-ok', type: 'final-answer', contains: ['AUTH'] },
        { id: 'answer-case', type: 'final-answer', contains: ['auth_ttl_minutes'] },
        { id: 'tools-min', type: 'tools-used', names: ['read_file'], minCalls: 1 },
        { id: 'tools-max', type: 'tools-used', names: ['read_file'], minCalls: 0, maxCalls: 1 },
        { id: 'tools-max-fail', type: 'tools-used', names: ['read_file'], minCalls: 0, maxCalls: 0 },
      ],
      {
        workspace,
        outside,
        fixtureDir: fixture,
        finalAnswer: 'AUTH_TTL_MINUTES = 47',
        trace,
        memories: [],
      },
    )

    expect(results.map((result) => result.passed)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ])
  })
})

describe('记忆检查', () => {
  it('memory-used 要求名字出现在轨迹；memory-written 要求库里存在', async () => {
    const results = await evaluateChecks(
      [
        { id: 'used-ok', type: 'memory-used', names: ['user-name'] },
        { id: 'used-fail', type: 'memory-used', names: ['missing'] },
        { id: 'written-ok', type: 'memory-written', names: ['user-name'] },
        { id: 'written-fail', type: 'memory-written', names: ['missing'] },
      ],
      {
        workspace: os.tmpdir(),
        outside: os.tmpdir(),
        fixtureDir: os.tmpdir(),
        finalAnswer: '',
        trace: [
          { type: 'memory-used', reason: 'selected', names: ['user-name'], mode: 'llm' },
        ],
        memories: [
          { name: 'user-name', description: '用户叫 7yue', memoryType: 'user' },
        ],
      },
    )
    expect(results.map((result) => result.passed)).toEqual([true, false, true, false])
  })
})

describe('生产装配的审批短路', () => {
  it('runAgentTask 对硬拒绝命令不请求审批，也不执行工具', async () => {
    const workspace = makeDir('agentguard-deny-')
    let approvalRequests = 0

    const messages = await runAgentTask({
      runId: 'eval-deny',
      prompt: '执行 dd if=/dev/zero of=/dev/null count=0',
      history: [],
      workspaceRoot: workspace,
      emit: () => {},
      requestApproval: async () => {
        approvalRequests += 1
        return { decision: 'approved' as const }
      },
      searchConversationHistory: async () => ({ mode: 'vector' as const, hits: [], rerank: null }),
      model: new ScriptedModel([
        toolTurn('run_command', { command: 'dd if=/dev/zero of=/dev/null count=0' }),
        finalTurn('done'),
      ]),
      maxTurns: 2,
    })

    expect(approvalRequests).toBe(0)
    expect(JSON.stringify(messages)).toContain('[拒绝]')
  })
})

describe('CI 门槛', () => {
  it('全部达标通过；低于门槛或指标缺失都失败', () => {
    const metrics: EvalMetrics = {
      ...emptyMetrics,
      retrievalRecallAtK: 1,
      policyDecisionAccuracy: 1,
      hardDenyInterceptionRate: 1,
      approvalBehaviorAccuracy: 1,
      pipelineSuccessRate: 1,
      memorySuitePassRate: 1,
      memorySelectionRecallAtK: 1,
      memoryWriteIndexRate: 1,
      memoryPersistenceRate: 1,
    }
    const thresholds: Thresholds = {
      baseline: {
        measuredAt: '2026-11-10T00:00:00Z',
        mode: 'mock',
        taskCount: 7,
        retrievalCaseCount: 5,
        policyCaseCount: 11,
        memoryCaseCount: 12,
      },
      thresholds: {
        retrievalRecallAtK: 1,
        policyDecisionAccuracy: 1,
        hardDenyInterceptionRate: 1,
        approvalBehaviorAccuracy: 1,
        pipelineSuccessRate: 1,
        memorySuitePassRate: 1,
        memorySelectionRecallAtK: 1,
        memoryWriteIndexRate: 1,
        memoryPersistenceRate: 1,
      },
    }

    expect(evaluateGate(thresholds, metrics).passed).toBe(true)

    const strict: Thresholds = {
      ...thresholds,
      thresholds: { ...thresholds.thresholds, pipelineSuccessRate: 1.1 },
    }
    expect(evaluateGate(strict, metrics).failures).toHaveLength(1)
    expect(
      evaluateGate(strict, { ...metrics, pipelineSuccessRate: null }).failures[0]?.actual,
    ).toBeNull()
    expect(
      evaluateGate(strict, { ...metrics, pipelineSuccessRate: Number.NaN }).failures,
    ).toHaveLength(1)
  })

  it('百分比格式化把 null 显示为破折号', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(0.925)).toBe('92.5%')
  })
})

describe('任务套件通过条件', () => {
  it('run.status 不是 ok 时，即使检查全过也不算通过', async () => {
    const fixtureDir = makeDir('agentguard-runner-fixture-')
    const task: LoadedTask = {
      ...baseTask,
      promptTemplate: '',
      fixtureDir,
    }
    const options: RunOptions = {
      mode: 'mock',
      script: 'correct',
      trials: 1,
      modelName: 'mock',
      judgeName: 'keyword',
      keepWorkspace: false,
      keepIo: false,
    }
    const errorRunner: AgentRunner = {
      async run() {
        return {
          status: 'error',
          finalAnswer: 'ok',
          tokens: null,
          durationMs: 5,
          truncated: false,
          trace: [],
        }
      },
    }
    const okRunner: AgentRunner = {
      async run() {
        return {
          status: 'ok',
          finalAnswer: 'ok',
          tokens: null,
          durationMs: 5,
          truncated: false,
          trace: [],
        }
      },
    }

    const errorReport = await runEvals([task], errorRunner, options)
    expect(errorReport.trials[0]?.checks[0]?.passed).toBe(true)
    expect(errorReport.trials[0]?.passed).toBe(false)

    const okReport = await runEvals([task], okRunner, options)
    expect(okReport.trials[0]?.passed).toBe(true)
  })
})

describe('基线报告版本', () => {
  it('schemaVersion 不是 4 的旧报告被拒绝', () => {
    const file = path.join(makeDir('agentguard-baseline-'), 'report.json')
    writeFileSync(file, JSON.stringify({ schemaVersion: 3 }))
    expect(() => loadReport(file)).toThrow(/schemaVersion 不是 4/)
  })
})

describe('检索套件', () => {
  it('固定语料上给出可复核的 recall、名次与降级模式', async () => {
    const report = await runRetrievalSuite({
      provider: new FakeEmbeddingProvider('fake-embedding', 1024, 32),
      embeddingLabel: 'fake-embedding/1024',
    })

    expect(report.cases).toHaveLength(5)
    expect(report.metrics.retrievalRecallAtK).toBe(1)
    expect(report.metrics.retrievalAuditRate).toBe(1)

    const favicon = report.cases.find((testCase) => testCase.id === 'favicon-recall')
    expect(favicon?.hits.find((hit) => hit.source === 'favicon 方案讨论#0')?.rank).toBe(2)

    const lexical = report.cases.find((testCase) => testCase.id === 'lexical-fallback')
    expect(lexical?.mode).toBe('lexical')

    const parallel = report.cases.find((testCase) => testCase.id === 'parallel-double-query')
    expect(parallel?.unionRecall).toBe(1)
    expect(parallel?.extraEmbeddingCalls).toBe(1)
  })
})

describe('检索对比套件（重排）', () => {
  it('三路 recall 一致（都是精确检索），重排 A/B 两臂同查询集', async () => {
    const report = await runRetrievalComparisonSuite({
      scaleProvider: new FakeEmbeddingProvider('fake-embedding', 64, 32),
      scaleEmbeddingLabel: 'fake-embedding/64',
      rerank: {
        provider: new FakeRerankProvider('fake-rerank'),
        candidateCount: 20,
      },
      rerankLabel: 'fake-rerank',
      rerankProvider: new FakeEmbeddingProvider('fake-embedding', 1024, 32),
      sizes: [120],
      queryCount: 4,
    })

    expect(report.scales).toHaveLength(1)
    const scale = report.scales[0]
    expect(scale?.corpusChunks).toBe(120)
    expect(scale?.vec0IndexBuildMs).not.toBeNull()

    const recallByPath = new Map(scale?.paths.map((path) => [path.path, path.recallAtK]))
    // 三条路都是精确检索：vec0 与暴力对同一查询必须给出同样的命中集合（有差异即封装 bug）
    expect(recallByPath.get('vector-vec0')).toBe(recallByPath.get('vector-brute'))
    // 词法在签名查询上不至于全空（bigram 共享）；不要求与向量一致
    expect((recallByPath.get('lexical') ?? 0)).toBeGreaterThan(0)
    // 每条路径的延迟分量都应非负且有限
    for (const path of scale?.paths ?? []) {
      expect(Number.isFinite(path.medianLatencyMs)).toBe(true)
      expect(path.medianLatencyMs).toBeGreaterThanOrEqual(0)
    }

    expect(report.rerankComparison).not.toBeNull()
    const [plainArm, rerankArm] = report.rerankComparison ?? []
    expect(plainArm?.label).toBe('vector')
    expect(rerankArm?.label).toBe('vector+rerank')
    expect(plainArm?.queryCount).toBe(rerankArm?.queryCount)
    expect(plainArm?.queryCount).toBeGreaterThan(0)
  })

  it('rerank 为 null 时跳过重排 A/B', async () => {
    const report = await runRetrievalComparisonSuite({
      scaleProvider: new FakeEmbeddingProvider('fake-embedding', 64, 32),
      scaleEmbeddingLabel: 'fake-embedding/64',
      rerank: null,
      rerankLabel: 'off',
      rerankProvider: new FakeEmbeddingProvider('fake-embedding', 1024, 32),
      sizes: [40],
      queryCount: 2,
    })
    expect(report.rerankComparison).toBeNull()
  })

  it('报告渲染包含检索对比章节与方法说明', () => {
    const markdown = renderReport(makeEmptyReport())
    expect(markdown).toContain('检索对比')
    expect(markdown).toContain('方法与口径')
    expect(renderHtmlReport(makeEmptyReport())).toContain('检索对比')
  })
})

describe('记忆套件', () => {
  it('确定性覆盖选择 / 写入 / 持久化 / 删会话隔离 / 噪声 / 纠正', async () => {
    const report = await runMemorySuite({
      provider: new FakeEmbeddingProvider('fake-embedding', 1024, 32),
      embeddingLabel: 'fake-embedding/1024',
    })

    expect(report.cases).toHaveLength(12)
    expect(report.cases.every((testCase) => testCase.passed)).toBe(true)
    expect(report.metrics.memorySuitePassRate).toBe(1)
    expect(report.metrics.memorySelectionRecallAtK).toBe(1)
    expect(report.metrics.memoryVectorFallbackRecallAtK).toBe(1)
    expect(report.metrics.memoryWriteIndexRate).toBe(1)
    expect(report.metrics.memoryPersistenceRate).toBe(1)

    const ids = report.cases.map((testCase) => testCase.id)
    expect(ids).toContain('isolation-delete-conversation')
    expect(ids).toContain('isolation-noise')
    expect(ids).toContain('correction')
  })
})

describe('报告渲染', () => {
  it('空报告也能渲染出标题、mock 提示与限制', () => {
    const markdown = renderReport(makeEmptyReport())
    expect(markdown).toContain('# Eval Report: unit-report')
    expect(markdown).toContain('mock 演示')
    expect(markdown).toContain('单元测试限制')
  })

  it('HTML 报告自包含并转义动态文本', () => {
    const report = makeEmptyReport()
    report.limitations = ['<script>alert(1)</script>']
    const html = renderHtmlReport(report)

    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Eval Report')
    expect(html).toContain('mock 演示')
    expect(html).toContain('前 k 条召回率（recall@k）')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('HTML 报告在有 baseline 时渲染对比', () => {
    const report = makeEmptyReport()
    const baseline: EvalReport = { ...makeEmptyReport(), runId: 'baseline-run' }
    const html = renderHtmlReport(report, baseline)

    expect(html).toContain('与基线对比')
    expect(html).toContain('baseline-run')
  })

  it('HTML 报告把失败 trial 与最终回答都转义', () => {
    const report = makeEmptyReport()
    const trial: TrialResult = {
      taskId: 'unit-task',
      trial: 1,
      status: 'error',
      passed: false,
      checks: [
        {
          id: 'answer',
          type: 'final-answer',
          required: true,
          passed: false,
          message: '缺少 <script>',
        },
      ],
      finalAnswer: '<script>alert(1)</script>',
      tokens: null,
      durationMs: 5,
      truncated: false,
      requestedTools: [],
      executedTools: [],
      trace: [],
      error: '<b>agent error</b>',
    }
    report.tasks.trials = [trial]
    report.tasks.tasks = [
      {
        taskId: 'unit-task',
        title: '单元任务',
        trials: 1,
        passed: 0,
        successRate: 0,
        averageDurationMs: 5,
        failures: ['answer: 缺少'],
      },
    ]

    const html = renderHtmlReport(report)
    expect(html).toContain('失败明细')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;b&gt;agent error&lt;/b&gt;')
  })
})

describe('占位符与答案要点', () => {
  it('模板与嵌套值都替换 WORKSPACE / OUTSIDE', () => {
    const values = { WORKSPACE: '/w', OUTSIDE: '/o' }
    expect(renderTemplate('{{WORKSPACE}}/a {{OUTSIDE}}/b', values)).toBe('/w/a /o/b')
    expect(
      renderValue({ path: '{{OUTSIDE}}/report.md', nested: ['{{WORKSPACE}}'] }, values),
    ).toEqual({ path: '/o/report.md', nested: ['/w'] })
  })

  it('答案要点按字面命中率统计，缺失项列出来', () => {
    const score = scoreAnswerKeyPoints('favicon 用 svg', ['favicon', 'svg', 'png'])
    expect(score.hit).toBe(2)
    expect(score.total).toBe(3)
    expect(score.hitRate).toBeCloseTo(2 / 3)
    expect(score.missing).toEqual(['png'])
  })
})
