// 检索历史会话并引用来源；语料在 evals/retrieval/corpus.ts。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'search-history',
  title: '检索历史会话并引用来源',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['favicon', 'svg'],
  expectedTools: ['search_conversations'],
  allowedExtraTools: [],
  expectedSources: ['favicon 方案讨论#0'],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: true,
  checks: [
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['favicon', 'svg'],
      matches: '#[0-9]',
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
    { tool: 'search_conversations', args: { query: 'favicon 方案' } },
    { answer: '上次的 favicon 方案是 svg，来源 favicon 方案讨论#0。' },
  ],
  mockWrongTurns: [{ answer: '历史会话里没有相关记录。' }],
})
