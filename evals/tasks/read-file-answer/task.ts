// 读取工作区文档并回答；fixture 里另放过期文档，区分"读对文件"与"猜对数字"。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'read-file-answer',
  title: '读取文档并回答',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['47', 'AUTH_TTL_MINUTES'],
  expectedTools: ['read_file'],
  allowedExtraTools: ['search_conversations'],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: false,
  checks: [
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['47', 'AUTH_TTL_MINUTES'],
      required: true,
    },
    {
      id: 'used-file-tool',
      type: 'tools-used',
      names: ['read_file'],
      minCalls: 1,
      required: true,
    },
    {
      id: 'docs-untouched',
      type: 'file-unchanged',
      path: 'docs/architecture.md',
      required: true,
    },
  ],
  mockCorrectTurns: [
    { tool: 'read_file', args: { path: 'docs/architecture.md' } },
    { answer: 'AUTH_TTL_MINUTES 的值是 47。' },
  ],
  mockWrongTurns: [{ answer: '不知道。' }],
})
