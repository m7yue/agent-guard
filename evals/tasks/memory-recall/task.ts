// 预置记忆后提问：自动选择必须把 user-name 注入，最终回答引用 记忆:user-name。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'memory-recall',
  title: '跨会话记忆召回',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['7yue'],
  expectedTools: [],
  allowedExtraTools: ['read_memory', 'select_memory', 'search_conversations'],
  expectedSources: ['记忆:user-name'],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: false,
  memories: [
    {
      name: 'user-name',
      description: '用户叫 7yue',
      type: 'user',
      body: '用户的名字是 7yue。',
    },
  ],
  selectorResponse: '[0]',
  checks: [
    {
      id: 'used-memory',
      type: 'memory-used',
      names: ['user-name'],
      minCalls: 1,
      required: true,
    },
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['7yue', '记忆:user-name'],
      required: true,
    },
  ],
  mockCorrectTurns: [{ answer: '你叫 7yue（来源：记忆:user-name）。' }],
  mockWrongTurns: [{ answer: '我不知道。' }],
})
