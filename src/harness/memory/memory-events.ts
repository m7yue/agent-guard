// 记忆事件的载荷形状：run-agent 产生，executor 写审计，评测子进程写 trace。
// 三处共用一份定义，避免字段名各写各的。
import type { MemoryType } from '../../shared/memory'

/** 一次「使用记忆」：自动选择注入、工具按名读取、或工具重新选择 */
export type MemoryUsedPayload =
  | {
      /** read_memory：按名读取，只有一条，没有选择过程 */
      reason: 'read'
      names: string[]
    }
  | {
      /** 每轮开始自动选择并注入 */
      reason: 'selected'
      names: string[]
      mode: 'llm'
    }
  | {
      /** 每轮开始自动选择并注入；向量降级带分数 */
      reason: 'selected'
      names: string[]
      mode: 'vector-fallback'
      scores: Record<string, number>
    }
  | {
      /** select_memory 工具重新选择 */
      reason: 'tool'
      names: string[]
      mode: 'llm'
    }
  | {
      /** select_memory 工具重新选择；向量降级带分数 */
      reason: 'tool'
      names: string[]
      mode: 'vector-fallback'
      scores: Record<string, number>
    }

/** 一次「写入记忆」：显式 write_memory 经审批后写入 */
export interface MemoryWrittenPayload {
  /** 记忆标识 */
  name: string
  /** 语义类型（不叫 type，避免与事件类型 discriminator 混淆） */
  memoryType: MemoryType
  /** created = 新建；updated = 覆盖同名记忆 */
  action: 'created' | 'updated'
}

/** 一次「删除记忆」：用户从记忆管理 UI 删除（模型没有 delete_memory 工具） */
export interface MemoryDeletedPayload {
  /** 记忆标识 */
  name: string
  /** 删除前的语义类型；正文已删除，审计只保留元数据 */
  memoryType: MemoryType
}
