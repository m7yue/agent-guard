// 身份类问法不显式要求检索，验证系统提示词能否让模型自触发 search_conversations。
// 这是留给评测的「触发覆盖率」用例。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'identity-recall',
  title: '身份类问法自触发检索',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['7yue'],
  expectedTools: ['search_conversations'],
  allowedExtraTools: [],
  expectedSources: ['寒暄#0'],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: true,
  checks: [
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['7yue'],
      required: true,
    },
    {
      id: 'used-search',
      type: 'tools-used',
      names: ['search_conversations'],
      minCalls: 1,
      required: true,
    },
  ],
  mockCorrectTurns: [
    { tool: 'search_conversations', args: { query: '我是谁 7yue' } },
    { answer: '你是 7yue，来源 寒暄#0。' },
  ],
  mockWrongTurns: [{ answer: '历史会话里没有相关记录。' }],
})
