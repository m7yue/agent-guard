// 记忆的共享形状：IPC 契约、执行器协议、渲染层与 harness 共用一份枚举。
//
// 这里只放"跨进程的形状与常量"，不放 store / runtime 实现。
import { z } from 'zod'

/** 记忆的四种语义类型（与参照项目 记忆选择 一致） */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

/** 记忆在 chunks 表里的 source_type；与会话语料分开，检索互不混排名 */
export const MEMORY_SOURCE_TYPE = 'memory'

/** kebab-case 标识；引用格式「记忆:name」 */
export const MemoryName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'name 必须是 kebab-case：小写字母/数字开头，只能含小写字母、数字、点、下划线、连字符，最长 64',
  )

export const MemoryDescription = z.string().min(1).max(160)
export const MemoryBody = z.string().min(1).max(2000)

/** 一条完整记忆：管理详情与写入结果用 */
export const MemoryItem = z.object({
  name: MemoryName,
  description: MemoryDescription,
  type: z.enum(MEMORY_TYPES),
  body: MemoryBody,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type MemoryItem = z.infer<typeof MemoryItem>

/** 列表项：不返回正文，避免管理列表一次拉太多内容 */
export const MemorySummary = z.object({
  name: MemoryName,
  description: MemoryDescription,
  type: z.enum(MEMORY_TYPES),
  updatedAt: z.number(),
})
export type MemorySummary = z.infer<typeof MemorySummary>
