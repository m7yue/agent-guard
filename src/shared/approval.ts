import { z } from 'zod'

// 审批请求的形状与通道：执行器发出，主进程转发，渲染进程弹窗。
// 用户选择通过 `app:approve` 回执，最终唤醒执行器里的等待。
// channel 常量的唯一定义在 channels.ts（那里零依赖，preload 可以直接引）
import { PUSH_CHANNELS } from './channels'
export const APPROVAL_CHANNEL = PUSH_CHANNELS.approvalRequest

export type ApprovalDecision = 'once' | 'session' | 'deny'

export interface ApprovalRequestPayload {
  requestId: string
  /** 属于哪一次 Agent 运行，便于界面把审批和对话对应起来 */
  runId: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

// 用于跨进程校验（主进程 → 渲染进程的推送、待审批列表）
export const ApprovalRequestSchema = z
  .object({
    requestId: z.string().min(1),
    runId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    reason: z.string(),
  })
  .strict()
