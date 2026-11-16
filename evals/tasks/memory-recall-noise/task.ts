// 噪声历史 + 记忆：检索语料里有"没有记录"的否认块，但记忆里有真名。
// 这条用例证明记忆是独立语料，不跟会话检索的噪声抢排名（否认噪声场景的受控版本）。
import { defineTask } from '../../core/task-definition'

export default defineTask({
  id: 'memory-recall-noise',
  title: '噪声历史下的记忆召回',
  timeoutMs: 120_000,
  maxTurns: 6,
  expectKeywords: ['林小明'],
  expectedTools: [],
  allowedExtraTools: ['search_conversations', 'read_memory', 'select_memory'],
  expectedSources: ['记忆:user-real-name'],
  approval: 'none',
  expectedApproval: 'not-requested',
  shouldIndexRetrievalCorpus: true,
  memories: [
    {
      name: 'user-real-name',
      description: '用户的真名',
      type: 'user',
      body: '用户的真名是林小明。',
    },
  ],
  selectorResponse: '[0]',
  checks: [
    {
      id: 'used-memory',
      type: 'memory-used',
      names: ['user-real-name'],
      minCalls: 1,
      required: true,
    },
    {
      id: 'answer',
      type: 'final-answer',
      contains: ['林小明', '记忆:user-real-name'],
      required: true,
    },
  ],
  mockCorrectTurns: [
    { answer: '你的真名是林小明（来源：记忆:user-real-name）。' },
  ],
  mockWrongTurns: [{ answer: '历史会话里没有相关记录。' }],
})
