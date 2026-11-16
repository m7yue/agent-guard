// 记忆套件：确定性验证记忆机制本身，不经过模型子进程。
//
// 与 agent 任务分开的原因：
// - 选择 / 写入 / 对账 / 隔离是管道行为，用脚本选择器就能确定性断言；
// - agent 任务只验证「模型是否按提示调用工具、是否引用记忆」，两者互补。
//
// 向量降级用 fake embedding：bigram 是词法信号，用例的查询与记忆正文必须有字面重叠。
// 同义改写的召回是真实 embedding 的能力，重排 用真实 provider 再对比。
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { indexConversationRun } from '../../src/harness/knowledge/conversation-documents'
import type { EmbeddingProvider } from '../../src/harness/knowledge/embedding-provider'
import { selectMemories } from '../../src/harness/memory/memory-selector'
import type { MemoryTextModel } from '../../src/harness/memory/memory-text-model'
import {
  deleteMemoryDocument,
  writeMemoryDocument,
} from '../../src/harness/memory/memory-writer'
import { openStore, type MemoryType, type Store } from '../../src/harness/store'
import { average, ratio } from '../core/aggregate'
import type { MemoryCaseResult, MemorySuiteReport } from '../core/types'

export interface MemorySuiteOptions {
  /** 索引与检索共用的 embedding 提供方。 */
  provider: EmbeddingProvider
  /** 报告里展示的 embedding 标识，例如 fake-embedding/1024。 */
  embeddingLabel: string
}

interface MemoryFixture {
  name: string
  description: string
  type: MemoryType
  body: string
}

type MemoryCase =
  | {
      id: string
      kind: 'selection'
      context: string
      memories: MemoryFixture[]
      selectorResponse: string
      expectedNames: string[]
      expectedMode: 'llm' | 'vector-fallback'
      maxItems?: number
      measureFallback: boolean
    }
  | { id: string; kind: 'write'; memory: MemoryFixture; updateBody?: string }
  | {
      id: string
      kind: 'persistence'
      memory: MemoryFixture
      context: string
      expectedName: string
    }
  | { id: string; kind: 'isolation-delete'; memory: MemoryFixture; conversationText: string }
  | {
      id: string
      kind: 'isolation-noise'
      memory: MemoryFixture
      context: string
      expectedName: string
    }
  | {
      id: string
      kind: 'correction'
      memory: MemoryFixture
      correctionBody: string
      context: string
      expectedName: string
    }
  | {
      id: string
      kind: 'delete'
      memory: MemoryFixture
      context: string
      expectedName: string
    }

const FAVICON: MemoryFixture = {
  name: 'favicon-plan',
  description: 'favicon 方案',
  type: 'project',
  body: 'favicon 方案使用 svg 图标。',
}

const USER_NAME: MemoryFixture = {
  name: 'user-name',
  description: '用户叫 7yue',
  type: 'user',
  body: '用户的名字是 7yue。',
}

const USER_REAL_NAME: MemoryFixture = {
  name: 'user-real-name',
  description: '用户的真名',
  type: 'user',
  body: '用户的真名是林小明。',
}

const NOISE_TEXT = '历史会话里没有相关记录。'

const CASES: MemoryCase[] = [
  {
    id: 'selection-llm',
    kind: 'selection',
    context: 'favicon 方案是什么',
    memories: [FAVICON, USER_NAME],
    selectorResponse: '[0]',
    expectedNames: ['favicon-plan'],
    expectedMode: 'llm',
    measureFallback: true,
  },
  {
    id: 'selection-empty',
    kind: 'selection',
    context: '今天天气怎么样',
    memories: [FAVICON, USER_NAME],
    selectorResponse: '[]',
    expectedNames: [],
    expectedMode: 'llm',
    measureFallback: false,
  },
  {
    id: 'selection-invalid-fallback',
    kind: 'selection',
    context: 'favicon 方案是什么',
    memories: [FAVICON, USER_NAME],
    selectorResponse: '不是 JSON',
    expectedNames: ['favicon-plan'],
    expectedMode: 'vector-fallback',
    measureFallback: true,
  },
  {
    id: 'selection-out-of-range',
    kind: 'selection',
    context: 'favicon 方案是什么',
    memories: [FAVICON],
    selectorResponse: '[99]',
    expectedNames: ['favicon-plan'],
    expectedMode: 'vector-fallback',
    measureFallback: true,
  },
  {
    id: 'selection-max-items',
    kind: 'selection',
    context: '问题',
    memories: [FAVICON, USER_NAME, USER_REAL_NAME],
    selectorResponse: '[0, 1, 2]',
    expectedNames: ['favicon-plan', 'user-name'],
    expectedMode: 'llm',
    maxItems: 2,
    measureFallback: false,
  },
  { id: 'write-new', kind: 'write', memory: FAVICON },
  {
    id: 'write-update-replace',
    kind: 'write',
    memory: FAVICON,
    updateBody: 'favicon 方案改为 png 图标。',
  },
  {
    id: 'persistence-reopen',
    kind: 'persistence',
    memory: FAVICON,
    context: 'favicon 方案是什么',
    expectedName: 'favicon-plan',
  },
  {
    id: 'isolation-delete-conversation',
    kind: 'isolation-delete',
    memory: FAVICON,
    conversationText: 'favicon 方案使用 svg 图标。',
  },
  {
    id: 'isolation-noise',
    kind: 'isolation-noise',
    memory: USER_NAME,
    context: '我叫什么？',
    expectedName: 'user-name',
  },
  {
    id: 'correction',
    kind: 'correction',
    memory: FAVICON,
    correctionBody: 'favicon 方案改为 png 图标。',
    context: 'favicon 方案是什么',
    expectedName: 'favicon-plan',
  },
  {
    id: 'delete-memory',
    kind: 'delete',
    memory: FAVICON,
    context: 'favicon 方案是什么',
    expectedName: 'favicon-plan',
  },
]

export async function runMemorySuite(
  options: MemorySuiteOptions,
): Promise<MemorySuiteReport> {
  const cases: MemoryCaseResult[] = []
  for (const testCase of CASES) {
    cases.push(await runMemoryCase(testCase, options.provider))
  }
  return {
    cases,
    metrics: aggregateMetrics(cases),
    embedding: options.embeddingLabel,
  }
}

async function runMemoryCase(
  testCase: MemoryCase,
  provider: EmbeddingProvider,
): Promise<MemoryCaseResult> {
  const startedAt = performance.now()
  if (testCase.kind === 'persistence') {
    return runPersistenceCase(testCase, provider, startedAt)
  }

  const store = openStore(':memory:')
  try {
    const result = await runInStoreCase(testCase, provider, store)
    return { ...result, durationMs: performance.now() - startedAt }
  } finally {
    store.close()
  }
}

async function runInStoreCase(
  testCase: Exclude<MemoryCase, { kind: 'persistence' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  switch (testCase.kind) {
    case 'selection':
      return runSelectionCase(testCase, provider, store)
    case 'write':
      return runWriteCase(testCase, provider, store)
    case 'isolation-delete':
      return runDeleteIsolationCase(testCase, provider, store)
    case 'isolation-noise':
      return runNoiseIsolationCase(testCase, provider, store)
    case 'correction':
      return runCorrectionCase(testCase, provider, store)
    case 'delete':
      return runDeleteCase(testCase, provider, store)
  }
}

async function runSelectionCase(
  testCase: Extract<MemoryCase, { kind: 'selection' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  await seedMemories(store, provider, testCase.memories)

  const selection = await selectMemories({
    context: testCase.context,
    maxItems: testCase.maxItems,
    model: scriptedSelector(testCase.selectorResponse),
    store,
    provider,
  })
  const selectedNames = selection.selected.map((item) => item.document.name)
  // 选择 recall 只统计「本应由 LLM 选中」的用例；invalid / 越界用例故意让 LLM 失败，
  // 它们的价值由降级 recall 与用例通过率承担，不污染 LLM 选择指标。
  const selectionRecall =
    testCase.expectedMode !== 'llm'
      ? null
      : selection.mode === 'llm'
        ? recall(testCase.expectedNames, selectedNames)
        : 0

  const fallback = testCase.measureFallback
    ? await selectMemories({
        context: testCase.context,
        maxItems: testCase.maxItems,
        model: null,
        store,
        provider,
      })
    : null
  const fallbackNames = fallback?.selected.map((item) => item.document.name) ?? []
  const vectorFallbackRecall = fallback
    ? recall(testCase.expectedNames, fallbackNames)
    : null

  const passed =
    selection.mode === testCase.expectedMode &&
    recall(testCase.expectedNames, selectedNames) === 1 &&
    (testCase.expectedMode !== 'vector-fallback' || vectorFallbackRecall === 1)

  return {
    id: testCase.id,
    kind: 'selection',
    passed,
    detail: `LLM=${selection.mode} 选中 ${selectedNames.join('/') || '无'}；降级=${
      fallback?.mode ?? '—'
    } 选中 ${fallbackNames.join('/') || '无'}`,
    selectionRecall,
    vectorFallbackRecall,
    indexed: null,
    isolated: null,
  }
}

async function runWriteCase(
  testCase: Extract<MemoryCase, { kind: 'write' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  await writeMemoryDocument(testCase.memory, { store, provider })
  if (testCase.updateBody !== undefined) {
    await writeMemoryDocument(
      { ...testCase.memory, body: testCase.updateBody },
      { store, provider },
    )
  }

  const chunks = store.listKnowledgeChunks('memory')
  const indexed = chunks.length > 0
  const text = chunks.map((chunk) => chunk.text).join('\n')
  const expectedBody = testCase.updateBody ?? testCase.memory.body
  const oldBodyGone = testCase.updateBody === undefined || !text.includes(testCase.memory.body)
  const passed = indexed && text.includes(expectedBody) && oldBodyGone

  return {
    id: testCase.id,
    kind: 'write',
    passed,
    detail: `indexed=${indexed}；正文${text.includes(expectedBody) ? '已写入' : '缺失'}；旧正文${
      oldBodyGone ? '已清除' : '仍残留'
    }`,
    selectionRecall: null,
    vectorFallbackRecall: null,
    indexed,
    isolated: null,
  }
}

async function runPersistenceCase(
  testCase: Extract<MemoryCase, { kind: 'persistence' }>,
  provider: EmbeddingProvider,
  startedAt: number,
): Promise<MemoryCaseResult> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentguard-memory-eval-'))
  const file = path.join(dir, 'memory.db')
  try {
    let store = openStore(file)
    await writeMemoryDocument(testCase.memory, { store, provider })
    const indexed = store.listKnowledgeChunks('memory').length > 0
    store.close()

    store = openStore(file)
    try {
      const selection = await selectMemories({
        context: testCase.context,
        model: scriptedSelector('[0]'),
        store,
        provider,
      })
      const passed =
        indexed &&
        selection.mode === 'llm' &&
        selection.selected.some((item) => item.document.name === testCase.expectedName)
      return {
        id: testCase.id,
        kind: 'persistence',
        passed,
        detail: `重开后选择=${selection.mode}，选中 ${selection.selected
          .map((item) => item.document.name)
          .join('/') || '无'}`,
        selectionRecall: null,
        vectorFallbackRecall: null,
        indexed,
        isolated: null,
        durationMs: performance.now() - startedAt,
      }
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runDeleteIsolationCase(
  testCase: Extract<MemoryCase, { kind: 'isolation-delete' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  store.ensureConversation('c1', 'favicon 讨论', process.cwd())
  await indexConversationRun({
    provider,
    store,
    conversationId: 'c1',
    title: 'favicon 讨论',
    messages: [{ role: 'user', content: testCase.conversationText }],
  })
  await writeMemoryDocument(testCase.memory, { store, provider })

  // 会话软删：删会话会物理清掉 conversation 块；记忆是独立语料，必须仍然可选。
  store.deleteConversation('c1')
  const conversationChunks = store.listKnowledgeChunks('conversation').length
  const memoryChunks = store.listKnowledgeChunks('memory').length

  const selection = await selectMemories({
    context: testCase.memory.description,
    model: scriptedSelector('[0]'),
    store,
    provider,
  })
  const selected = selection.selected.some(
    (item) => item.document.name === testCase.memory.name,
  )
  const passed = conversationChunks === 0 && memoryChunks > 0 && selected

  return {
    id: testCase.id,
    kind: 'isolation',
    passed,
    detail: `删除后 conversation 块=${conversationChunks}，memory 块=${memoryChunks}，选择=${selected ? '命中' : '未命中'}`,
    selectionRecall: null,
    vectorFallbackRecall: null,
    indexed: memoryChunks > 0,
    isolated: passed,
  }
}

async function runNoiseIsolationCase(
  testCase: Extract<MemoryCase, { kind: 'isolation-noise' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  store.ensureConversation('noise', '无相关记录', process.cwd())
  await indexConversationRun({
    provider,
    store,
    conversationId: 'noise',
    title: '无相关记录',
    messages: [
      { role: 'user', content: testCase.context },
      { role: 'assistant', content: NOISE_TEXT },
    ],
  })
  await writeMemoryDocument(testCase.memory, { store, provider })

  const conversationChunks = store.listKnowledgeChunks('conversation').length
  const selection = await selectMemories({
    context: testCase.context,
    model: scriptedSelector('[0]'),
    store,
    provider,
  })
  const document = selection.selected.find(
    (item) => item.document.name === testCase.expectedName,
  )?.document
  const passed =
    conversationChunks > 0 && document !== undefined && document.body.length > 0

  return {
    id: testCase.id,
    kind: 'isolation',
    passed,
    detail: `conversation 噪声块=${conversationChunks}；记忆选择=${
      document ? `命中 ${document.name}` : '未命中'
    }`,
    selectionRecall: null,
    vectorFallbackRecall: null,
    indexed: null,
    isolated: passed,
  }
}

async function runCorrectionCase(
  testCase: Extract<MemoryCase, { kind: 'correction' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  await writeMemoryDocument(testCase.memory, { store, provider })
  await writeMemoryDocument(
    { ...testCase.memory, body: testCase.correctionBody },
    { store, provider },
  )

  const chunks = store.listKnowledgeChunks('memory')
  const text = chunks.map((chunk) => chunk.text).join('\n')
  const selection = await selectMemories({
    context: testCase.context,
    model: scriptedSelector('[0]'),
    store,
    provider,
  })
  const document = selection.selected.find(
    (item) => item.document.name === testCase.expectedName,
  )?.document
  const oldValueGone = !text.includes(testCase.memory.body)
  const passed =
    document?.body === testCase.correctionBody && text.includes(testCase.correctionBody) && oldValueGone

  return {
    id: testCase.id,
    kind: 'correction',
    passed,
    detail: `选择=${document ? '命中' : '未命中'}；新值${
      text.includes(testCase.correctionBody) ? '已索引' : '未索引'
    }；旧值${oldValueGone ? '已清除' : '仍残留'}`,
    selectionRecall: null,
    vectorFallbackRecall: null,
    indexed: chunks.length > 0,
    isolated: passed,
  }
}

async function runDeleteCase(
  testCase: Extract<MemoryCase, { kind: 'delete' }>,
  provider: EmbeddingProvider,
  store: Store,
): Promise<Omit<MemoryCaseResult, 'durationMs'>> {
  await writeMemoryDocument(testCase.memory, { store, provider })
  const beforeChunks = store.listKnowledgeChunks('memory').length
  const current = store.loadMemory(testCase.memory.name)
  if (!current) {
    return {
      id: testCase.id,
      kind: 'delete',
      passed: false,
      detail: '写入后读不到记忆',
      selectionRecall: null,
      vectorFallbackRecall: null,
      indexed: false,
      isolated: false,
    }
  }

  const before = await selectMemories({
    context: testCase.context,
    model: scriptedSelector('[0]'),
    store,
    provider,
  })
  const deleted = await deleteMemoryDocument(testCase.memory.name, current.updatedAt, {
    store,
    provider,
  })
  const after = await selectMemories({
    context: testCase.context,
    model: scriptedSelector('[0]'),
    store,
    provider,
  })
  const afterChunks = store.listKnowledgeChunks('memory').length

  const passed =
    before.selected.some((item) => item.document.name === testCase.expectedName) &&
    deleted.status === 'deleted' &&
    store.loadMemory(testCase.memory.name) === null &&
    beforeChunks > 0 &&
    afterChunks === 0 &&
    after.mode === 'none' &&
    after.selected.length === 0

  return {
    id: testCase.id,
    kind: 'delete',
    passed,
    detail: `删除前选中=${before.selected.length}，删除=${deleted.status}，剩余块=${afterChunks}，删除后选择=${after.mode}`,
    selectionRecall: null,
    vectorFallbackRecall: null,
    indexed: beforeChunks > 0,
    isolated: passed,
  }
}

async function seedMemories(
  store: Store,
  provider: EmbeddingProvider,
  memories: MemoryFixture[],
): Promise<void> {
  for (const memory of memories) {
    await writeMemoryDocument(memory, { store, provider })
  }
}

function scriptedSelector(response: string): MemoryTextModel {
  return { completeText: async () => response }
}

/** 期望来源出现在实际选中里的比例；期望为空时，实际也为空才算 1 */
function recall(expected: string[], actual: string[]): number {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0
  return expected.filter((name) => actual.includes(name)).length / expected.length
}

function aggregateMetrics(cases: MemoryCaseResult[]): MemorySuiteReport['metrics'] {
  const selectionCases = cases.filter((testCase) => testCase.kind === 'selection')
  const writeCases = cases.filter((testCase) => testCase.kind === 'write')
  const persistenceCases = cases.filter((testCase) => testCase.kind === 'persistence')
  const selectionRecalls = selectionCases.flatMap((testCase) =>
    testCase.selectionRecall === null ? [] : [testCase.selectionRecall],
  )
  const fallbackRecalls = selectionCases.flatMap((testCase) =>
    testCase.vectorFallbackRecall === null ? [] : [testCase.vectorFallbackRecall],
  )

  return {
    memorySuitePassRate: ratio(cases.filter((testCase) => testCase.passed).length, cases.length) ?? 0,
    memorySelectionRecallAtK: average(selectionRecalls),
    memoryVectorFallbackRecallAtK: average(fallbackRecalls),
    memoryWriteIndexRate: average(
      writeCases.map((testCase) => (testCase.indexed ? 1 : 0)),
    ),
    memoryPersistenceRate: average(
      persistenceCases.map((testCase) => (testCase.passed ? 1 : 0)),
    ),
  }
}
