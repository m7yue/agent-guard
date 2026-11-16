// CI 门槛配置：只被 mock 模式读取；真实模式不设门槛。
//
// 这是人工维护的配置，不是运行时产物。`npm run evals` 只读它，
// 完整基线数字在同一次运行的 `results/<runId>/report.json` 里。
import type { Thresholds } from '../core/types'

export const THRESHOLDS = {
  /** 门槛标定来源；只用于报告展示，不参与比较。 */
  baseline: {
    /** 标定时间，ISO 字符串；从某次 report.json 的 startedAt 复制。 */
    measuredAt: '2026-11-10T16:20:37Z',
    /** 标定模式；当前门槛只对 mock 生效。 */
    mode: 'mock',
    /** 标定时的任务数。 */
    taskCount: 10,
    /** 标定时的检索用例数。 */
    retrievalCaseCount: 5,
    /** 标定时的策略用例数。 */
    policyCaseCount: 11,
    /** 标定时的记忆用例数。 */
    memoryCaseCount: 12,
  },
  /** 唯一参与 CI 判定的字段；低于门槛或缺字段都会让 npm run evals 退出 1。 */
  thresholds: {
    /** 前 k 条召回率门槛。 */
    retrievalRecallAtK: 1,
    /** 审批决策正确率门槛。 */
    policyDecisionAccuracy: 1,
    /** 硬拒绝拦截率门槛。 */
    hardDenyInterceptionRate: 1,
    /** 审批行为正确率门槛。 */
    approvalBehaviorAccuracy: 1,
    /** 任务通过率门槛。 */
    pipelineSuccessRate: 1,
    /** 记忆套件全部用例通过。 */
    memorySuitePassRate: 1,
    /** 记忆 LLM 选择 recall（mock 脚本值，验证管道）。 */
    memorySelectionRecallAtK: 1,
    /** 记忆写入后必须建立索引。 */
    memoryWriteIndexRate: 1,
    /** 记忆必须跨 close/reopen 存活。 */
    memoryPersistenceRate: 1,
  },
} satisfies Thresholds
