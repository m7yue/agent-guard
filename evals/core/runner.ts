// 任务套件调度：任务 × trials，负责临时工作区、检查、汇总。
//
// 一次 runEvals 的流程：
// 1. task × trial 串行循环（不并发：每个 trial 会起子进程 / 调模型，串行更可控，报告顺序也稳定）；
// 2. 每个 trial 建独立 workspace/outside，复制 fixture，渲染 prompt；
// 3. 交给 AgentRunner 跑一次，读回 status/finalAnswer/trace；
// 4. 检查永远执行，不因 agent 报错而跳过；passed 还要求 status 为 ok；
// 5. 汇总 per-task 与 per-suite 指标；比例指标都是“先算每个 trial，再取算术平均”。
//
// 这个文件只依赖 AgentRunner 接口，不 import 具体子进程实现；
// 装配在 cli/index.ts 完成，便于测试时替换成假 runner。
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { average, ratio } from './aggregate'
import { scoreAnswerKeyPoints } from './answer-key-points'
import { evaluateChecks } from './checks'
import { renderTemplate } from './render'
import type {
  AgentRunResult,
  AgentRunner,
  ApprovalTraceEvent,
  LoadedTask,
  RunOptions,
  TaskSummary,
  TaskSuiteReport,
  ToolTraceEvent,
  TraceEvent,
  TrialResult,
} from './types'

export async function runEvals(
  tasks: LoadedTask[],
  agentRunner: AgentRunner,
  options: RunOptions,
): Promise<TaskSuiteReport> {
  const trials: TrialResult[] = []

  // 任务按登记顺序、trial 按 1..N 串行执行；任何一步失败只影响当前 trial 的 passed，不中断整轮评测。
  for (const task of tasks) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      // 每个 trial 一个独立临时目录：
      // - workspace 是 agent 的现场，检查器按它判断文件是否被创建/修改；
      // - outside 是越界写入目标，用来确认权限管线没有把文件写到工作区外。
      const base = await mkdtemp(join(tmpdir(), `agentguard-eval-${task.id}-`))
      const workspace = join(base, 'workspace')
      const outside = join(base, 'outside')

      try {
        // fixture 复制而不是直接使用任务目录：agent 的写入不能污染仓库里的原始 fixture。
        await cp(task.fixtureDir, workspace, { recursive: true })
        await mkdir(outside, { recursive: true })
        // prompt 里的 {{WORKSPACE}} / {{OUTSIDE}} 只在这里替换成当前 trial 的绝对路径。
        const prompt = renderTemplate(task.promptTemplate, { WORKSPACE: workspace, OUTSIDE: outside })

        // AgentRunner 自己抛错（子进程起不来、读不到 result 等）时也合成一个 error 结果，
        // 后面仍然跑检查——失败前可能已经留下了文件副作用。
        let runResult: AgentRunResult
        const runStartedAt = performance.now()
        try {
          runResult = await agentRunner.run({
            taskId: task.id,
            workspace,
            outside,
            prompt,
            mode: options.mode,
            script: options.script,
            timeoutMs: task.timeoutMs,
            maxTurns: task.maxTurns,
            keepIo: options.keepIo,
            onIoKept: options.onIoKept,
          })
        } catch (error) {
          // runner 自己抛错时也要继续评分：失败前可能已经写了文件
          runResult = toErrorRunResult(error, performance.now() - runStartedAt)
        }

        // 检查总是执行，不因 agent 报错而跳过；否则“跑挂了但留下副作用”会被漏报。
        // checks 只看 workspace/outside/finalAnswer/trace，不依赖模型是否正常结束。
        const checks = await evaluateChecks(task.checks, {
          workspace,
          outside,
          fixtureDir: task.fixtureDir,
          finalAnswer: runResult.finalAnswer,
          trace: runResult.trace,
          memories: runResult.memories ?? [],
        })

        trials.push({
          taskId: task.id,
          trial,
          status: runResult.status,
          // 超时 / 报错不算通过：即使失败前碰巧留下了预期文件，也不能把未完成的运行算成功。
          // required=false 的检查只进报告，不影响 passed。
          passed:
            runResult.status === 'ok' &&
            checks.filter((check) => check.required).every((check) => check.passed),
          checks,
          finalAnswer: runResult.finalAnswer,
          tokens: runResult.tokens,
          durationMs: runResult.durationMs,
          truncated: runResult.truncated,
          // requestedTools 来自模型回合，executedTools 来自实际 tool 事件：
          // 被审批拒绝的调用会出现在前者，不会出现在后者。
          requestedTools: uniqueRequestedTools(runResult.trace),
          executedTools: uniqueExecutedTools(runResult.trace),
          trace: runResult.trace,
          error: runResult.error,
        })
      } finally {
        // 默认清理临时现场；--keep-workspace 时保留路径供人工核对。
        if (options.keepWorkspace) {
          options.onWorkspaceKept?.(base)
        } else {
          await rm(base, { recursive: true, force: true })
        }
      }
    }
  }

  return {
    trials,
    // 以下汇总都是 macro-average：先得到每个 trial / 每个任务的比值，再对结果取平均，
    // 而不是把所有命中与样本合并成一个全局分数；这样不同任务不会因用例数多而主导指标。
    tasks: summarizeTasks(tasks, trials),
    summary: {
      totalTrials: trials.length,
      passedTrials: trials.filter((trial) => trial.passed).length,
      successRate: ratio(trials.filter((trial) => trial.passed).length, trials.length) ?? 0,
      averageDurationMs: average(trials.map((trial) => trial.durationMs)) ?? 0,
    },
    metrics: {
      toolSelectionAccuracy: toolSelectionAccuracy(tasks, trials),
      answerKeyPointHitRate: answerKeyPointHitRate(tasks, trials),
      citationHitRate: citationHitRate(tasks, trials),
      expectedApprovalFlowRate: expectedApprovalFlowRate(tasks, trials),
    },
  }
}

/** AgentRunner 抛错时合成结果：没有回答/trace，但保留实际耗时，后面仍能跑 checks。 */
function toErrorRunResult(error: unknown, durationMs: number): AgentRunResult {
  return {
    status: 'error',
    finalAnswer: '',
    tokens: null,
    durationMs,
    truncated: false,
    trace: [],
    error: error instanceof Error ? error.message : String(error),
  }
}

/** 模型请求过的工具（去重）：来自 model 事件，包含随后被审批拒绝的调用。 */
function uniqueRequestedTools(trace: TraceEvent[]): string[] {
  const names = new Set<string>()
  for (const event of trace) {
    if (event.type === 'model') {
      for (const name of event.requestedTools) names.add(name)
    }
  }
  return [...names]
}

/** 实际执行过的工具（去重）：只来自 tool 事件，被拒绝或抛错的调用不在其中。 */
function uniqueExecutedTools(trace: TraceEvent[]): string[] {
  return [
    ...new Set(
      trace
        .filter((event): event is ToolTraceEvent => event.type === 'tool')
        .map((event) => event.name),
    ),
  ]
}

/** 每个任务的通过数、平均耗时与失败检查；failures 会扁平化到任务级，报告直接展示。 */
function summarizeTasks(tasks: LoadedTask[], trials: TrialResult[]): TaskSummary[] {
  return tasks.map((task) => {
    const taskTrials = trials.filter((trial) => trial.taskId === task.id)
    const passed = taskTrials.filter((trial) => trial.passed).length
    return {
      taskId: task.id,
      title: task.title,
      trials: taskTrials.length,
      passed,
      successRate: ratio(passed, taskTrials.length) ?? 0,
      averageDurationMs: average(taskTrials.map((trial) => trial.durationMs)) ?? 0,
      failures: taskTrials.flatMap((trial) =>
        trial.checks
          .filter((check) => check.required && !check.passed)
          .map((check) => `${check.id}: ${check.message}`),
      ),
    }
  })
}

/**
 * 工具选择准确率：按模型请求的工具算，不看是否被审批拒绝。
 * - expectedTools 必须全部出现；
 * - actual 不能超出 expectedTools ∪ allowedExtraTools；
 * - expectedTools 为空的边界任务只检查“没有出现不允许的工具”，不要求一定调用某工具。
 */
function toolSelectionAccuracy(tasks: LoadedTask[], trials: TrialResult[]): number | null {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const results = trials.map((trial) => {
    const task = taskById.get(trial.taskId)
    if (!task) return false
    const expected = new Set(task.expectedTools)
    const allowed = new Set([...task.expectedTools, ...task.allowedExtraTools])
    const actual = new Set(trial.requestedTools)
    return [...expected].every((name) => actual.has(name)) && [...actual].every((name) => allowed.has(name))
  })
  return average(results.map((passed) => (passed ? 1 : 0)))
}

/** 答案要点命中率：每个 trial 先算命中关键词比例，再对所有 trial 取平均。 */
function answerKeyPointHitRate(tasks: LoadedTask[], trials: TrialResult[]): number | null {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const rates = trials.map((trial) => {
    const task = taskById.get(trial.taskId)
    if (!task) return 0
    return scoreAnswerKeyPoints(trial.finalAnswer, task.expectKeywords).hitRate
  })
  return average(rates)
}

/**
 * 引用命中率：只统计声明了 expectedSources 的任务，按精确 `标题#块序号` 匹配。
 * 模型写成“历史会话#标题 的第 N 块”会记 0——这是格式遵守率，不是语义判断。
 * 没有任务声明 expectedSources 时返回 null，而不是 0。
 */
function citationHitRate(tasks: LoadedTask[], trials: TrialResult[]): number | null {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const rates: number[] = []
  for (const trial of trials) {
    const task = taskById.get(trial.taskId)
    if (!task?.expectedSources) continue
    const hit = task.expectedSources.filter((source) => trial.finalAnswer.includes(source)).length
    rates.push(hit / task.expectedSources.length)
  }
  return average(rates)
}

/**
 * 任务级审批轨迹诊断：按 expectedApproval 判断审批事件形态。
 * 只作诊断，不作为顶层 approvalBehaviorAccuracy；顶层指标来自策略套件。
 */
function expectedApprovalFlowRate(tasks: LoadedTask[], trials: TrialResult[]): number | null {
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  const results = trials.map((trial) => {
    const task = taskById.get(trial.taskId)
    if (!task) return false
    const approvals = trial.trace.filter(
      (event): event is ApprovalTraceEvent => event.type === 'approval',
    )
    // 审批行为评的是 harness 是否忠实执行了"用户"的决定，不要求模型一定走某条路径：
    // - 任何审批事件的 approved 都必须与任务 approval 一致；
    // - expectedApproval=granted/denied 要求至少发生一次审批；
    // - not-requested 只要求"若发生则方向正确"，避免模型换用别的 ask 工具时误判。
    const expectedApproved = task.approval === 'grant'
    const directionsMatch = approvals.every((event) => event.approved === expectedApproved)
    if (task.expectedApproval === 'granted' || task.expectedApproval === 'denied') {
      return approvals.length > 0 && directionsMatch
    }
    return directionsMatch
  })
  return average(results.map((passed) => (passed ? 1 : 0)))
}

