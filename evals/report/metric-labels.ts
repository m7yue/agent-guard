// 指标的中文标签与固定顺序；Markdown 与 HTML 报告共用，避免两份文案漂移。
import type { EvalMetrics } from '../core/types'

/** 每个指标的展示标签；键与 EvalMetrics 字段一一对应。 */
export const METRIC_LABELS: Record<keyof EvalMetrics, string> = {
  retrievalRecallAtK: '前 k 条召回率（recall@k）',
  parallelQueryGain: '并行双查增益',
  lexicalFallbackRecall: '词法降级 recall',
  retrievalAuditRate: '检索审计事件覆盖率',
  policyDecisionAccuracy: '审批决策正确率',
  hardDenyInterceptionRate: '硬拒绝拦截率',
  approvalBehaviorAccuracy: '审批行为正确率',
  pipelineSuccessRate: '任务通过率',
  toolSelectionAccuracy: '工具选择准确率',
  answerKeyPointHitRate: '答案要点命中率',
  citationHitRate: '引用命中率',
  memorySuitePassRate: '记忆用例通过率',
  memorySelectionRecallAtK: '记忆选择 recall@k',
  memoryVectorFallbackRecallAtK: '记忆向量降级 recall@k',
  memoryWriteIndexRate: '记忆写入索引率',
  memoryPersistenceRate: '记忆持久化率',
  rerankRecallGain: '重排 recall 增益',
  averageDurationMs: '平均耗时',
}

/** 报告里指标表的固定顺序。 */
export const METRIC_KEYS = Object.keys(METRIC_LABELS) as Array<keyof EvalMetrics>
