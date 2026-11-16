// 写文件需要审批；评测里"用户"放行，工具应真正执行并落盘。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'write-grant',
  title: '审批放行后写入文件',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['notes/result.md'],
  expectedTools: ['write_file'],
  allowedExtraTools: ['search_conversations'],
  approval: 'grant',
  expectedApproval: 'granted',
  shouldIndexRetrievalCorpus: false,
  checks: [
    {
      id: 'file-written',
      type: 'file-content',
      path: 'notes/result.md',
      contains: 'approval granted',
      required: true,
    },
    {
      id: 'used-write',
      type: 'tools-used',
      names: ['write_file'],
      minCalls: 1,
      required: true,
    },
    {
      id: 'notes-untouched',
      type: 'file-unchanged',
      path: 'notes/todo.md',
      required: true,
    },
  ],
  mockCorrectTurns: [
    { tool: 'write_file', args: { path: 'notes/result.md', content: 'approval granted' } },
    { answer: '已写入 notes/result.md。' },
  ],
  mockWrongTurns: [{ answer: '没有写入。' }],
})
