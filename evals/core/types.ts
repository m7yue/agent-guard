// 评测层公共类型：任务、轨迹、运行结果、报告。
//
// 依赖方向：本文件只依赖 task-definition（任务 schema）与 harness 的 core 类型；
// runner / checks / report / cli 都依赖本文件，避免互相 import 形成环。
import type { Usage } from '../../src/harness/core/types'
import type { MemoryType } from '../../src/harness/store'
import type { CheckSpec, TaskDefinition } from './task-definition'

/** 评测模式：mock 用脚本模型，real 用真实模型。 */
export type RunMode = 'mock' | 'real'
/** mock 模式回放哪套回合序列：correct 是正确回合，wrong 是错误回合。 */
export type ScriptName = 'correct' | 'wrong'

// ── 任务 ────────────────────────────────────────────────────────────────

/** 加载后的任务：task.ts 的定义 + prompt.md 正文 + fixture 目录。 */
export interface LoadedTask extends TaskDefinition {
  /** prompt.md 的正文；运行时替换 {{WORKSPACE}} / {{OUTSIDE}}。 */
  promptTemplate: string
  /** 任务 fixture 的绝对路径；trial 开始时复制到临时 workspace。 */
  fixtureDir: string
}

// ── 轨迹 ────────────────────────────────────────────────────────────────

/** 一次模型调用。requestedTools 是模型这一轮请求的工具名（未过权限）。 */
export interface ModelTraceEvent {
  /** 事件类型判别字段。 */
  type: 'model'
  /** 第几次模型调用，从 1 开始。 */
  turn: number
  /** 模型停止原因：end、tool_use 或 max_tokens。 */
  stopReason: string
  /** 这一轮模型输出的文本。 */
  content: string
  /** 这一轮请求的工具名；未过权限，可能被拒绝。 */
  requestedTools: string[]
  /** 真实模型的 token 用量；mock 或接口未返回时没有。 */
  usage?: Usage
  /** 这次模型调用花了多久。 */
  durationMs: number
}

/**
 * 一次实际执行的工具调用；被审批拒绝的调用不会产生这个事件。
 * 工具失败时仍会产生，`isError` 为 true。
 */
export interface ToolTraceEvent {
  /** 事件类型判别字段。 */
  type: 'tool'
  /** 工具名。 */
  name: string
  /** 工具入参。 */
  args: Record<string, unknown>
  /** 工具返回的文本；失败时是回灌给模型的错误文本。 */
  result: string
  /** 工具是否失败；历史 trace 没有该字段。 */
  isError?: boolean
  /** 工具执行耗时。 */
  durationMs: number
}

/**
 * 一次审批请求；非交互评测里 approved 由任务的 approval 字段决定。
 * runAgentTask 只对 ask 调用 requestApproval；deny 直接短路，allow 不产生事件，
 * 所以 decision 恒为 'ask'。
 */
export interface ApprovalTraceEvent {
  /** 事件类型判别字段。 */
  type: 'approval'
  /** 权限管线的结论；当前只会是 ask。 */
  decision: 'ask'
  /** 被审批的工具名。 */
  toolName: string
  /** 工具入参。 */
  args: Record<string, unknown>
  /** 是否放行；评测里的“用户”由任务 approval 字段决定。 */
  approved: boolean
  /** 权限管线给出的原因。 */
  reason: string
}

/** 检索命中的一块：来源、分数与原文。 */
export interface RetrievalTraceHit {
  /** 引用来源，格式为 `会话标题#块序号`。 */
  source: string
  /** 0..1 的相似度。 */
  score: number
  /** 命中块的原文。 */
  text: string
}

/** 一次历史会话检索；search_conversations 工具执行时写入。 */
export interface RetrievalTraceEvent {
  /** 事件类型判别字段。 */
  type: 'retrieval'
  /** 实际发出的查询词。 */
  query: string
  /** 请求返回的条数上限。 */
  topK: number
  /** 本次实际走的检索路径：向量或词法降级。 */
  mode: 'vector' | 'lexical'
  /** 命中块列表，按分数排序。 */
  hits: RetrievalTraceHit[]
}

/** 一次记忆使用；run-agent 的 onMemoryUsed 回调写入。 */
export interface MemoryUsedTraceEvent {
  /** 事件类型判别字段。 */
  type: 'memory-used'
  /** selected = 每轮开始自动选择；read = read_memory；tool = select_memory。 */
  reason: 'selected' | 'read' | 'tool'
  /** 命中的记忆名。 */
  names: string[]
  /** 选择路径；read 没有选择过程，故可缺省。 */
  mode?: 'llm' | 'vector-fallback' | 'none'
  /** 向量降级的相似度分数（name → score）。 */
  scores?: Record<string, number>
}

/** 一次记忆写入；run-agent 的 onMemoryWritten 回调写入。 */
export interface MemoryWrittenTraceEvent {
  /** 事件类型判别字段。 */
  type: 'memory-written'
  /** 记忆标识。 */
  name: string
  /** 语义类型。 */
  memoryType: MemoryType
  /** created = 新建；updated = 覆盖同名记忆。 */
  action: 'created' | 'updated'
}

/** 一条循环日志；用于排查，不参与指标。 */
export interface LogTraceEvent {
  /** 事件类型判别字段。 */
  type: 'log'
  /** 日志正文。 */
  message: string
}

/** 一次工具拒绝；权限拒绝、审批拒绝或未知工具。 */
export interface ToolDeniedTraceEvent {
  /** 事件类型判别字段。 */
  type: 'tool-denied'
  /** 被拒绝的工具名。 */
  name: string
  /** 模型给出的原始入参。 */
  args: Record<string, unknown>
  /** 拒绝发生在哪一步。 */
  stage: 'permission' | 'approval' | 'unknown'
  /** 权限管线/审批/未知工具给出的原因。 */
  reason: string
}

/** 一次 trial 里可能出现的全部轨迹事件。 */
export type TraceEvent =
  | ModelTraceEvent
  | ToolTraceEvent
  | ToolDeniedTraceEvent
  | ApprovalTraceEvent
  | RetrievalTraceEvent
  | MemoryUsedTraceEvent
  | MemoryWrittenTraceEvent
  | LogTraceEvent

// ── 一次 trial ──────────────────────────────────────────────────────────

/** 一次 trial 的输入；由 runner 准备，由 AgentRunner 执行。 */
export interface AgentRunInput {
  /** 要跑的任务 id；子进程用它加载任务定义。 */
  taskId: string
  /** 这次 trial 的工作区，agent 在这里读写文件。 */
  workspace: string
  /** 越界写入的目标目录，用来确认文件没有写到工作区外。 */
  outside: string
  /** 已经替换好占位符的 prompt 正文。 */
  prompt: string
  /** mock 或 real。 */
  mode: RunMode
  /** mock 模式回放哪套回合序列；real 模式忽略。 */
  script?: ScriptName
  /** 子进程超时时间，单位毫秒。 */
  timeoutMs: number
  /** agent 最多跑多少个模型回合。 */
  maxTurns: number
  /** 是否保留 prompt/trace/result 所在的 IO 目录；默认删除。 */
  keepIo?: boolean
  /** 保留 IO 目录时的回调，用来打印路径。 */
  onIoKept?: (path: string) => void
}

/** 记忆快照：子进程跑完后回报的记忆行（不含正文，报告与检查用）。 */
export interface MemorySnapshot {
  /** 记忆标识 */
  name: string
  /** 一行摘要 */
  description: string
  /** 语义类型 */
  memoryType: MemoryType
}

/** 一次 trial 的运行结果；是否通过由检查器另行判断。 */
export interface AgentRunResult {
  /** ok 表示正常结束；error 表示抛错；timeout 表示被父进程杀掉。 */
  status: 'ok' | 'error' | 'timeout'
  /** agent 的最终回答；失败时为空串。 */
  finalAnswer: string
  /** 真实模型有 usage 时汇总；没有时为 null，不按 0 冒充。 */
  tokens: { input: number; output: number } | null
  /** 父进程 wall-clock，包含子进程启动与 tsx 解析。 */
  durationMs: number
  /** 是否有模型回合因为 max_tokens 被截断。 */
  truncated: boolean
  /** 模型 / 工具 / 审批 / 检索 / 记忆事件。 */
  trace: TraceEvent[]
  /** 跑完后库里的记忆快照；旧结果或未注入记忆时缺省。 */
  memories?: MemorySnapshot[]
  /** 失败时的错误信息。 */
  error?: string
}

/** 执行一次 trial 的接口；子进程实现与测试替身都满足它。 */
export interface AgentRunner {
  /** 跑一次任务；实现方负责隔离、超时和结果组装。 */
  run(input: AgentRunInput): Promise<AgentRunResult>
}

/** 单个检查的结果；passed 为 false 时 message 说明原因。 */
export interface CheckResult {
  /** 对应 CheckSpec.id。 */
  id: string
  /** 检查类型，排查时用于区分。 */
  type: CheckSpec['type']
  /** 是否影响 trial 通过。 */
  required: boolean
  /** 是否通过。 */
  passed: boolean
  /** 给人看的结果说明。 */
  message: string
}

/** 一次 trial 的完整结果；passed 只看 status 与 required 检查。 */
export interface TrialResult {
  /** 任务 id。 */
  taskId: string
  /** 第几次试验，从 1 开始。 */
  trial: number
  /** agent 运行状态。 */
  status: AgentRunResult['status']
  /** 是否通过：status 为 ok 且所有 required 检查通过。 */
  passed: boolean
  /** 每个检查的详细结果。 */
  checks: CheckResult[]
  /** agent 的最终回答。 */
  finalAnswer: string
  /** token 用量；mock 或缺失时为 null。 */
  tokens: AgentRunResult['tokens']
  /** 父进程 wall-clock 延迟。 */
  durationMs: number
  /** 是否有模型回合因为 max_tokens 被截断。 */
  truncated: boolean
  /** 模型请求过的工具名（去重）；工具选择准确率按它算，不看是否被拒绝。 */
  requestedTools: string[]
  /** 实际执行过的工具名（去重）；被拒绝的调用不计入。 */
  executedTools: string[]
  /** 完整轨迹，供报告与排查使用。 */
  trace: TraceEvent[]
  /** agent 失败时的错误信息。 */
  error?: string
}

/** 一个任务在所有 trial 上的汇总。 */
export interface TaskSummary {
  /** 任务 id。 */
  taskId: string
  /** 报告里显示的任务名。 */
  title: string
  /** 这个任务跑了几次。 */
  trials: number
  /** 通过了几次。 */
  passed: number
  /** passed / trials。 */
  successRate: number
  /** 平均耗时，单位毫秒。 */
  averageDurationMs: number
  /** 失败检查的说明，来自所有未通过的 trial。 */
  failures: string[]
}

// ── 各套件报告 ──────────────────────────────────────────────────────────

/** 任务套件的报告。 */
export interface TaskSuiteReport {
  /** 每次 trial 的明细。 */
  trials: TrialResult[]
  /** 每个任务的汇总。 */
  tasks: TaskSummary[]
  /** 整个任务套件的汇总。 */
  summary: {
    /** 总 trial 数。 */
    totalTrials: number
    /** 通过的 trial 数。 */
    passedTrials: number
    /** passedTrials / totalTrials。 */
    successRate: number
    /** 所有 trial 的平均耗时。 */
    averageDurationMs: number
  }
  /** 任务套件的诊断指标。 */
  metrics: {
    /** 期望工具全部出现，且没有 expectedTools ∪ allowedExtraTools 之外的工具。 */
    toolSelectionAccuracy: number | null
    /** expectKeywords 的平均命中率。 */
    answerKeyPointHitRate: number | null
    /** expectedSources 在最终回答里出现的平均比例。 */
    citationHitRate: number | null
    /** 任务级审批轨迹与 expectedApproval 一致的比例（诊断用，不作为顶层指标）。 */
    expectedApprovalFlowRate: number | null
  }
}

/** 一条策略用例的结果。 */
export interface PolicyCaseResult {
  /** 用例 id。 */
  id: string
  /** 被测工具名。 */
  tool: string
  /** 工具入参。 */
  args: Record<string, unknown>
  /** 期望的权限结论。 */
  expectedDecision: 'allow' | 'ask' | 'deny'
  /** checkPermission 的实际结论。 */
  actualDecision: 'allow' | 'ask' | 'deny'
  /** 期望是否请求审批。 */
  shouldAskApproval: boolean
  /** 实际是否请求审批。 */
  hasAskedApproval: boolean
  /** 期望是否执行工具。 */
  shouldExecuteTool: boolean
  /** 实际是否执行工具。 */
  hasExecutedTool: boolean
  /** 三项断言是否全部一致。 */
  passed: boolean
  /** 不一致时的说明。 */
  message: string
}

/** 策略套件的报告。 */
export interface PolicySuiteReport {
  /** 每条策略用例的结果。 */
  cases: PolicyCaseResult[]
  /** 策略套件的指标。 */
  metrics: {
    /** decision 与期望一致的用例比例。 */
    policyDecisionAccuracy: number | null
    /** 期望 deny 的用例中，工具没有执行的比例。 */
    hardDenyInterceptionRate: number | null
    /** 审批请求与工具执行都符合期望的用例比例。 */
    approvalBehaviorAccuracy: number | null
  }
}

/** 一条检索命中在报告里的形状。 */
export interface RetrievalHitReport {
  /** 引用来源，格式为 `会话标题#块序号`。 */
  source: string
  /** 0..1 的相似度。 */
  score: number
  /** 在 top-k 里的名次，从 1 开始；未命中为 null。 */
  rank: number | null
}

/** 一条检索用例的结果。 */
export interface RetrievalCaseResult {
  /** 用例 id。 */
  id: string
  /** 这条用例发出的一个或多个查询；多个模拟并行双查。 */
  queries: string[]
  /** 返回条数上限。 */
  topK: number
  /** 期望出现在 top-k 的来源。 */
  expectedSources: string[]
  /** 实际命中与未命中的期望来源。 */
  hits: RetrievalHitReport[]
  /** 期望来源的召回率。 */
  recall: number
  /** 本次实际走的检索路径。 */
  mode: 'vector' | 'lexical'
  /** 这条用例的检索耗时。 */
  durationMs: number
  /** 只有并行双查用例才有：第一条查询单独的 recall。 */
  singleQueryRecall?: number
  /** 只有并行双查用例才有：多次查询并集的 recall。 */
  unionRecall?: number
  /** 并行双查多出来的 embedding 调用次数。 */
  extraEmbeddingCalls?: number
  /** 这次检索写了几条 retrieval 审计事件。 */
  auditEvents: number
}

/** 检索套件的报告。 */
export interface RetrievalSuiteReport {
  /** 每条检索用例的结果。 */
  cases: RetrievalCaseResult[]
  /** 检索套件的指标。 */
  metrics: {
    /** 各用例 recall 的算术平均。 */
    retrievalRecallAtK: number | null
    /** 并行双查用例的并集 recall 与单查 recall 之差。 */
    parallelQueryGain: number | null
    /** 词法降级用例的 recall 平均值。 */
    lexicalFallbackRecall: number | null
    /** 写出的 retrieval 事件数等于查询数的用例比例。 */
    retrievalAuditRate: number | null
    /** 各用例检索耗时的平均值。 */
    averageDurationMs: number | null
  }
  /** 报告里展示的 embedding 标识，例如 `embedding-3/1024`。 */
  embedding: string
}

/** 规模对比的一条检索路径（词法 / 向量暴力 / vec0 虚拟表）。 */
export type ComparisonPathKind = 'lexical' | 'vector-brute' | 'vector-vec0'

/** 一条检索路径在一个语料规模下的测量。 */
export interface ComparisonPathMeasurement {
  /** 路径标识。 */
  path: ComparisonPathKind
  /** 目标块（构造出来的期望命中）进入 top-k 的查询比例。 */
  recallAtK: number
  /** 每查询端到端中位耗时（扫描 + 打分 + 排序；不含审计写入——各路径公共开销）。 */
  medianLatencyMs: number
  /** 分量：从库里读出全部块（含向量 BLOB 解码）；vec0 路径不需要全量读出，为 null。 */
  medianScanMs: number | null
  /** 分量：打分与排序；vec0 路径为 KNN SQL 本身，词法为 bigram 打分。 */
  medianScoreMs: number | null
}

/** 一个语料规模下的三路对比测量。 */
export interface ComparisonScaleMeasurement {
  /** 语料块数。 */
  corpusChunks: number
  /** 固定查询集的查询数。 */
  queryCount: number
  /** 三条路径各自的测量。 */
  paths: ComparisonPathMeasurement[]
  /** vec0 表建表并灌入全部向量的一次性耗时；无 vec0 路径时为 null。 */
  vec0IndexBuildMs: number | null
}

/** 重排 A/B 对比的一条臂。 */
export interface RerankArmMeasurement {
  /** vector = 不重排；vector+rerank = 同一候选池先取 top-N 再重排。 */
  label: 'vector' | 'vector+rerank'
  /** 各查询 recall（期望来源在 top-k 内的比例）的算术平均；无查询时为 null。 */
  recallAtK: number | null
  /** 期望来源（最早出现的那条）在命中里的平均名次；未进 top-k 记 topK+1。两臂 recall 饱和时靠它分辨排序质量。 */
  meanExpectedRank: number | null
  /** 重排臂每查询的重排耗时中位数；不重排的臂为 null。 */
  medianRerankMs: number | null
  /** 参与统计的查询数。 */
  queryCount: number
}

/** 重排 检索对比套件的报告：词法 / 暴力 / vec0 三路的规模曲线 + 重排前后 A/B。 */
export interface RetrievalComparisonReport {
  /** 各规模下的三路测量；规模对比固定用离线 fake embedding（测的是管道开销曲线，不是语义质量）。 */
  scales: ComparisonScaleMeasurement[]
  /** 重排 A/B（同一查询集与同一语料含噪声）；重排不可用时为 null。 */
  rerankComparison: RerankArmMeasurement[] | null
  /** 重排臂的标识（fake-rerank / rerank 模型名）；无重排为 off。 */
  rerankLabel: string
  /** 规模对比实际使用的 embedding 标识。 */
  embeddingLabel: string
  /** 采样与聚合方法（R12：读者能据此判断数字的适用范围）。 */
  methodology: string[]
}

/** 一条记忆用例的结果。 */
export interface MemoryCaseResult {
  /** 用例 id。 */
  id: string
  /** 用例类别：选择 / 写入 / 持久化 / 隔离 / 纠正 / 删除。 */
  kind: 'selection' | 'write' | 'persistence' | 'isolation' | 'correction' | 'delete'
  /** 这条用例是否通过。 */
  passed: boolean
  /** 给人看的说明（实际选中了什么、哪条断言失败）。 */
  detail: string
  /** LLM 选择路径的 recall；不适用时为 null。 */
  selectionRecall: number | null
  /** 向量降级路径的 recall；不适用时为 null。 */
  vectorFallbackRecall: number | null
  /** 写入后是否建立了记忆块；非写入用例为 null。 */
  indexed: boolean | null
  /** 删除会话 / 噪声隔离 / 纠正后旧值消失；非隔离用例为 null。 */
  isolated: boolean | null
  /** 这条用例的耗时。 */
  durationMs: number
}

/** 记忆套件的报告。 */
export interface MemorySuiteReport {
  /** 每条用例的结果。 */
  cases: MemoryCaseResult[]
  /** 记忆套件的指标。 */
  metrics: {
    /** 全部用例通过的比例。 */
    memorySuitePassRate: number | null
    /** LLM 选择路径的 recall 平均值。 */
    memorySelectionRecallAtK: number | null
    /** 向量降级路径的 recall 平均值（只统计适用的用例）。 */
    memoryVectorFallbackRecallAtK: number | null
    /** 写入后成功建立索引的用例比例。 */
    memoryWriteIndexRate: number | null
    /** 跨 close/reopen 仍能选中的用例比例。 */
    memoryPersistenceRate: number | null
  }
  /** 报告里展示的 embedding 标识。 */
  embedding: string
}

// ── 汇总与门槛 ──────────────────────────────────────────────────────────

/** 指标口径：pipeline 是管道指标，model 是模型能力指标。 */
export type MetricScope = 'pipeline' | 'model'

/** 一次评测的全部指标；null 表示该指标没有数据。 */
export interface EvalMetrics {
  /** 前 k 条召回率（recall@k）：各用例 recall 的算术平均；k 即用例的 topK。 */
  retrievalRecallAtK: number | null
  /** 并行双查的并集 recall 减去单查 recall。 */
  parallelQueryGain: number | null
  /** 词法降级路径的 recall 平均值。 */
  lexicalFallbackRecall: number | null
  /** retrieval 审计事件覆盖率。 */
  retrievalAuditRate: number | null
  /** checkPermission 结论与期望一致的比例。 */
  policyDecisionAccuracy: number | null
  /** 期望 deny 的用例中工具没有执行的比例。 */
  hardDenyInterceptionRate: number | null
  /** 策略套件的审批请求与工具执行正确率。 */
  approvalBehaviorAccuracy: number | null
  /** 任务套件中 status 为 ok 且 required 检查全过的 trial 比例。 */
  pipelineSuccessRate: number | null
  /** 模型请求的工具与期望集一致的比例。 */
  toolSelectionAccuracy: number | null
  /** 最终回答命中 expectKeywords 的平均比例。 */
  answerKeyPointHitRate: number | null
  /** 最终回答包含 expectedSources 的平均比例。 */
  citationHitRate: number | null
  /** 记忆套件全部用例通过的比例。 */
  memorySuitePassRate: number | null
  /** 记忆 LLM 选择路径的 recall 平均值。 */
  memorySelectionRecallAtK: number | null
  /** 记忆向量降级路径的 recall 平均值（报告用，不进门槛）。 */
  memoryVectorFallbackRecallAtK: number | null
  /** 记忆写入后成功建立索引的用例比例。 */
  memoryWriteIndexRate: number | null
  /** 记忆跨 close/reopen 仍能选中的用例比例。 */
  memoryPersistenceRate: number | null
  /** 重排臂 recall 减不重排臂 recall（同一查询集；mock 下是 fake 重排的管道值，不是质量结论）。 */
  rerankRecallGain: number | null
  /** 任务 trial 的平均父进程 wall-clock。 */
  averageDurationMs: number | null
}

/** 指标口径：pipeline 中只有 GATED_METRICS 进 CI 门槛；model 只报告，mock 下是脚本值。 */
export const METRIC_SCOPES: Record<keyof EvalMetrics, MetricScope> = {
  retrievalRecallAtK: 'pipeline',
  parallelQueryGain: 'pipeline',
  lexicalFallbackRecall: 'pipeline',
  retrievalAuditRate: 'pipeline',
  policyDecisionAccuracy: 'pipeline',
  hardDenyInterceptionRate: 'pipeline',
  approvalBehaviorAccuracy: 'pipeline',
  pipelineSuccessRate: 'pipeline',
  toolSelectionAccuracy: 'model',
  answerKeyPointHitRate: 'model',
  citationHitRate: 'model',
  memorySuitePassRate: 'pipeline',
  memorySelectionRecallAtK: 'pipeline',
  memoryVectorFallbackRecallAtK: 'pipeline',
  memoryWriteIndexRate: 'pipeline',
  memoryPersistenceRate: 'pipeline',
  rerankRecallGain: 'pipeline',
  averageDurationMs: 'pipeline',
}

/** CI 只卡这些指标；model 指标不进门槛。 */
export const GATED_METRICS: Array<keyof EvalMetrics> = [
  'retrievalRecallAtK',
  'policyDecisionAccuracy',
  'hardDenyInterceptionRate',
  'approvalBehaviorAccuracy',
  'pipelineSuccessRate',
  'memorySuitePassRate',
  'memorySelectionRecallAtK',
  'memoryWriteIndexRate',
  'memoryPersistenceRate',
]

/** 门槛配置：标定来源 + 实际生效的门槛。 */
export interface Thresholds {
  /** 门槛标定信息；只记录“哪次运行、什么用例集”，完整数字在对应的 report.json。 */
  baseline: {
    /** 标定时间，ISO 字符串。 */
    measuredAt: string
    /** 标定时的评测模式。 */
    mode: RunMode
    /** 标定时的任务数。 */
    taskCount: number
    /** 标定时的检索用例数。 */
    retrievalCaseCount: number
    /** 标定时的策略用例数。 */
    policyCaseCount: number
    /** 标定时的记忆用例数。 */
    memoryCaseCount: number
  }
  /** 只写需要卡门槛的指标；缺一项就视为配置错误。 */
  thresholds: Partial<Record<keyof EvalMetrics, number>>
}

/** 一条门槛失败记录。 */
export interface GateFailure {
  /** 未达标的指标名。 */
  metric: keyof EvalMetrics
  /** 实际值；指标缺失时为 null，CI 同样判失败。 */
  actual: number | null
  /** 该指标的门槛。 */
  threshold: number
}

/** 一次门槛比较的结果。 */
export interface GateResult {
  /** 是否全部达标。 */
  passed: boolean
  /** 未达标的指标列表。 */
  failures: GateFailure[]
}

/** 一次评测的完整报告，也是 `results/<runId>/report.json` 的结构。 */
export interface EvalReport {
  /** 报告结构版本；重排 增检索对比套件后升到 4，旧报告不再作为 baseline。 */
  schemaVersion: 4
  /** 本次运行的唯一 id；`results/<runId>/` 目录用它。 */
  runId: string
  /** mock 或 real。 */
  mode: RunMode
  /** 报告里展示的模型名；mock 为 mock。 */
  modelName: string
  /** 报告里展示的裁判名；当前只用 keyword。 */
  judgeName: string
  /** 报告里展示的 embedding 标识。 */
  embedding: string
  /** 开始时间，ISO 字符串。 */
  startedAt: string
  /** 整次运行的总耗时。 */
  durationMs: number
  /** 全部指标。 */
  metrics: EvalMetrics
  /** 每个指标的口径。 */
  scopes: Record<keyof EvalMetrics, MetricScope>
  /** 任务套件报告。 */
  tasks: TaskSuiteReport
  /** 策略套件报告。 */
  policy: PolicySuiteReport
  /** 检索套件报告。 */
  retrieval: RetrievalSuiteReport
  /** 重排 检索对比套件报告（词法/暴力/vec0 + 重排 A/B）。 */
  comparison: RetrievalComparisonReport
  /** 记忆套件报告。 */
  memory: MemorySuiteReport
  /** 本次使用的门槛；real 模式为 null。 */
  thresholds: Thresholds | null
  /** 门槛比较结果；real 模式为 null。 */
  gate: GateResult | null
  /** 本次运行的已知限制。 */
  limitations: string[]
}

/** 一次评测的运行参数；由 CLI 组装。 */
export interface RunOptions {
  /** mock 或 real。 */
  mode: RunMode
  /** mock 模式回放哪套回合序列；real 忽略。 */
  script: ScriptName
  /** 每个任务跑几次。 */
  trials: number
  /** 报告里显示的模型名。 */
  modelName: string
  /** 报告里显示的裁判名。 */
  judgeName: string
  /** 是否保留临时工作区。 */
  keepWorkspace: boolean
  /** 是否保留 prompt/trace/result 文件。 */
  keepIo: boolean
  /** 保留工作区时的回调。 */
  onWorkspaceKept?: (path: string) => void
  /** 保留 IO 目录时的回调。 */
  onIoKept?: (path: string) => void
}

export type { CheckSpec, TaskDefinition }
