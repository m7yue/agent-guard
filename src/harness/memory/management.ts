// 记忆管理服务：UI 编辑/删除的用例编排。
//
// 入口（executor）只做协议分发；"检查 expectedUpdatedAt → 写/删 → 发审计"
// 这些业务步骤都在这里。列表/详情由主进程直接读 store（只读），不经过本服务。
import type { EmbeddingProvider } from '../knowledge/embedding-provider'
import { getLogger } from '../logging/logger'
import type { MemoryUpsertInput } from '../store'
import type { MemoryDeletedPayload, MemoryWrittenPayload } from './memory-events'
import {
  deleteMemoryDocument,
  updateMemoryDocument,
  type DeleteMemoryResult,
  type MemoryStore,
  type UpdateMemoryResult,
} from './memory-writer'

export interface MemoryManagementDeps {
  store: MemoryStore
  provider: EmbeddingProvider
  /** 管理 UI 编辑成功后的审计出口 */
  onWritten?: (payload: MemoryWrittenPayload) => void
  /** 管理 UI 删除成功后的审计出口 */
  onDeleted?: (payload: MemoryDeletedPayload) => void
}

export interface MemoryUpdateCommand extends MemoryUpsertInput {
  /** UI 打开详情时看到的 updatedAt；不匹配说明被别人改过 */
  expectedUpdatedAt: number
}

export interface MemoryManagement {
  /** 编辑；expectedUpdatedAt 冲突时返回当前文档供 UI 重载 */
  update(input: MemoryUpdateCommand): Promise<UpdateMemoryResult>
  /** 删除；expectedUpdatedAt 冲突时返回当前文档供 UI 重载 */
  delete(name: string, expectedUpdatedAt: number): Promise<DeleteMemoryResult>
}

export function createMemoryManagement(deps: MemoryManagementDeps): MemoryManagement {
  return {
    async update(input) {
      const result = await updateMemoryDocument(input, deps)
      if (result.status === 'updated') {
        try {
          deps.onWritten?.({
            name: result.document.name,
            memoryType: result.document.type,
            action: 'updated',
          })
        } catch (error) {
          getLogger('memory').warn('记忆写入审计失败', {
            name: result.document.name,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return result
    },

    async delete(name, expectedUpdatedAt) {
      const result = await deleteMemoryDocument(name, expectedUpdatedAt, deps)
      if (result.status === 'deleted') {
        try {
          deps.onDeleted?.({
            name: result.document.name,
            memoryType: result.document.type,
          })
        } catch (error) {
          getLogger('memory').warn('记忆删除审计失败', {
            name: result.document.name,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return result
    },
  }
}
