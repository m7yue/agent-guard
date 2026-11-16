// 记忆运行时：handler 依赖的记忆能力，不是 loop 的新抽象层。
//
// 它把 store / provider / 选择器 / 审计出口收成一个对象：
// - loop 的 ReadMemoryIndex / SelectMemoryForRun handler 用它读目录、选正文；
// - 工具 effect 的 write_memory / read_memory / select_memory handler 用它执行；
// - 审计（memory-used / memory-written）在内部完成，调用方不再拼 payload。
import type { EmbeddingProvider } from '../knowledge/embedding-provider'
import type { MemoryDocument, MemoryUpsertInput } from '../store'
import { toMemoryIndexText } from './memory-document'
import type { MemoryUsedPayload, MemoryWrittenPayload } from './memory-events'
import {
  selectMemories,
  type MemorySelection,
  type MemorySelectionWithResults,
} from './memory-selector'
import type { MemoryTextModel } from './memory-text-model'
import { writeMemoryDocument, type MemoryStore, type WriteMemoryResult } from './memory-writer'

export interface MemoryRuntime {
  /** 第一层索引：name + description 目录；空库返回空串 */
  readIndex(): string
  /** 选择相关记忆；reason 区分自动选择（selected）与 select_memory 工具（tool） */
  select(
    context: string,
    reason: 'selected' | 'tool',
    maxItems?: number,
  ): Promise<MemorySelection>
  /** 写入/更新记忆；成功后写 memory-written 审计 */
  remember(input: MemoryUpsertInput): Promise<WriteMemoryResult>
  /** 按名字读正文；命中时写 memory-used(read) 审计 */
  read(name: string): MemoryDocument | null
}

export interface MemoryRuntimeDeps {
  /** 记忆行与切块的读写入口 */
  store: MemoryStore
  /** 向量降级与索引的 embedding 提供方 */
  provider: EmbeddingProvider
  /** LLM 选择器；null 表示零配置/演示模式，选择直接走向量降级 */
  selectorModel: MemoryTextModel | null
  /** 一次选择的审计出口（由 executor / 评测子进程绑定 runId 或 trace） */
  onMemoryUsed?: (payload: MemoryUsedPayload) => void
  /** 一次写入的审计出口 */
  onMemoryWritten?: (payload: MemoryWrittenPayload) => void
}

/** 生产/评测共用的记忆运行时工厂 */
export function createMemoryRuntime(deps: MemoryRuntimeDeps): MemoryRuntime {
  const { store, provider, selectorModel } = deps

  return {
    readIndex() {
      return toMemoryIndexText(store.listMemories())
    },

    async select(context, reason, maxItems) {
      const selection = await selectMemories({
        context,
        maxItems,
        model: selectorModel,
        store,
        provider,
      })
      if (selection.mode !== 'none' && selection.selected.length > 0) {
        deps.onMemoryUsed?.(toMemoryUsedPayload(reason, selection))
      }
      return selection
    },

    async remember(input) {
      const result = await writeMemoryDocument(input, { store, provider })
      deps.onMemoryWritten?.({
        name: result.document.name,
        memoryType: result.document.type,
        action: result.action,
      })
      return result
    },

    read(name) {
      const document = store.loadMemory(name)
      if (document) {
        deps.onMemoryUsed?.({ reason: 'read', names: [document.name] })
      }
      return document
    },
  }
}

/** 未配置记忆时的空实现：loop 里不需要 if (!memory)，工具调用会得到明确失败 */
export const NO_MEMORY: MemoryRuntime = {
  readIndex() {
    return ''
  },
  async select() {
    return { mode: 'none', selected: [] }
  },
  async remember() {
    throw new Error('记忆服务未配置')
  },
  read() {
    return null
  },
}

/** 把一次选择结果转成审计载荷；向量降级带分数，LLM 选择只带名字 */
export function toMemoryUsedPayload(
  reason: 'selected' | 'tool',
  selection: MemorySelectionWithResults,
): MemoryUsedPayload {
  const names = selection.selected.map((item) => item.document.name)
  if (selection.mode === 'vector-fallback') {
    const scores = Object.fromEntries(
      selection.selected.map((item) => [item.document.name, item.score]),
    )
    return reason === 'selected'
      ? { reason: 'selected', names, mode: 'vector-fallback', scores }
      : { reason: 'tool', names, mode: 'vector-fallback', scores }
  }
  return reason === 'selected'
    ? { reason: 'selected', names, mode: 'llm' }
    : { reason: 'tool', names, mode: 'llm' }
}
