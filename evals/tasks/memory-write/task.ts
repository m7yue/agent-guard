// 显式写入记忆：模型必须调用 write_memory，审批放行，记忆真正落库。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'memory-write',
  title: '显式写入记忆（审批）',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['favicon-plan'],
  expectedTools: ['write_memory'],
  allowedExtraTools: [],
  approval: 'grant',
  expectedApproval: 'granted',
  shouldIndexRetrievalCorpus: false,
  checks: [
    {
      id: 'used-write-memory',
      type: 'tools-used',
      names: ['write_memory'],
      minCalls: 1,
      required: true,
    },
    {
      id: 'memory-present',
      type: 'memory-written',
      names: ['favicon-plan'],
      required: true,
    },
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['favicon-plan'],
      required: true,
    },
  ],
  mockCorrectTurns: [
    {
      tool: 'write_memory',
      args: {
        name: 'favicon-plan',
        description: 'favicon 方案',
        type: 'project',
        body: 'favicon 方案使用 svg 图标。',
      },
    },
    { answer: '已保存记忆 favicon-plan。' },
  ],
  mockWrongTurns: [{ answer: '我记住了。' }],
})
