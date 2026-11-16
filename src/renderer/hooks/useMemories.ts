// 记忆管理状态：列表、详情、保存、删除。
//
// 组件只渲染；所有 IPC 都经 agent-client。冲突/运行中删除的 reason 在这里翻译成
// 人能读的提示，并保留 current 文档供 UI 重新加载。
import { useCallback, useRef, useState } from 'react'
import type {
  DeleteMemoryInput,
  ListMemoriesInput,
  UpdateMemoryInput,
} from '../../shared/contracts'
import type { MemoryItem, MemorySummary, MemoryType } from '../../shared/memory'
import { agentClient } from '../lib/agent-client'

export interface MemoryFormValues {
  description: string
  type: MemoryType
  body: string
}

export interface UseMemoriesOptions {
  /** 保存/删除成功后通知外部（刷新审计） */
  onChanged?: () => void
}

export interface UseMemoriesResult {
  items: MemorySummary[]
  /** 当前筛选条件下的总条数（分页前） */
  total: number
  /** 当前编辑中的完整文档；null 表示编辑弹窗关闭 */
  selected: MemoryItem | null
  isLoading: boolean
  isSaving: boolean
  isDeleting: boolean
  error: string | null
  clearError: () => void
  clearSelected: () => void
  refresh: (options?: ListMemoriesInput) => Promise<void>
  openMemory: (name: string) => Promise<void>
  save: (values: MemoryFormValues) => Promise<boolean>
  remove: (item: MemorySummary) => Promise<boolean>
}

function statusText(status: 'not-found' | 'conflict' | 'run-active' | 'internal'): string {
  switch (status) {
    case 'conflict':
      return '这条记忆已被其他操作更新，请重新加载后再操作。'
    case 'not-found':
      return '这条记忆已不存在。'
    case 'run-active':
      return '有正在进行的任务，停止后再删除。'
    case 'internal':
      return '记忆操作失败，请稍后重试。'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '记忆操作失败，请稍后重试。'
}

export function useMemories(options: UseMemoriesOptions = {}): UseMemoriesResult {
  const [items, setItems] = useState<MemorySummary[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<MemoryItem | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { onChanged } = options
  const lastListQuery = useRef<ListMemoriesInput>({
    limit: 20,
    offset: 0,
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  })

  const refresh = useCallback(async (nextQuery?: ListMemoriesInput) => {
    if (nextQuery) lastListQuery.current = nextQuery
    setIsLoading(true)
    try {
      const page = await agentClient.listMemories(lastListQuery.current)
      setItems(page.items)
      setTotal(page.total)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setIsLoading(false)
    }
  }, [])

  const openMemory = useCallback(async (name: string) => {
    try {
      const item = await agentClient.loadMemory(name)
      setSelected(item)
      if (item) setError(null)
      else setError('这条记忆已不存在。')
    } catch (cause) {
      setError(errorText(cause))
    }
  }, [])

  const save = useCallback(
    async (values: MemoryFormValues): Promise<boolean> => {
      if (!selected) return false
      setIsSaving(true)
      try {
        const input: UpdateMemoryInput = {
          name: selected.name,
          description: values.description,
          type: values.type,
          body: values.body,
          expectedUpdatedAt: selected.updatedAt,
        }
        const result = await agentClient.updateMemory(input)
        if (!result.ok) {
          setError(result.error.message)
          return false
        }
        if (result.data.status === 'updated') {
          setSelected(result.data.item)
          setError(null)
          await refresh()
          onChanged?.()
          return true
        }
        if (result.data.status === 'conflict') {
          setSelected(result.data.current)
        }
        setError(statusText(result.data.status))
        await refresh()
        return false
      } catch (cause) {
        setError(errorText(cause))
        return false
      } finally {
        setIsSaving(false)
      }
    },
    [onChanged, refresh, selected],
  )

  const remove = useCallback(
    async (item: MemorySummary): Promise<boolean> => {
      setIsDeleting(true)
      try {
        const input: DeleteMemoryInput = {
          name: item.name,
          expectedUpdatedAt: item.updatedAt,
        }
        const result = await agentClient.deleteMemory(input)
        if (!result.ok) {
          setError(result.error.message)
          return false
        }
        if (result.data.status !== 'deleted') {
          if (result.data.status === 'conflict') setSelected(result.data.current)
          setError(statusText(result.data.status))
          await refresh()
          return false
        }
        if (selected?.name === item.name) setSelected(null)
        setError(null)
        await refresh()
        onChanged?.()
        return true
      } catch (cause) {
        setError(errorText(cause))
        return false
      } finally {
        setIsDeleting(false)
      }
    },
    [onChanged, refresh, selected],
  )

  return {
    items,
    total,
    selected,
    isLoading,
    isSaving,
    isDeleting,
    error,
    clearError: () => setError(null),
    clearSelected: () => setSelected(null),
    refresh,
    openMemory,
    save,
    remove,
  }
}
