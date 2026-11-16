// 审批队列：订阅请求、排队、把用户选择回执出去。
import { useEffect, useRef, useState } from 'react'
import type { ApprovalDecision, ApprovalRequestPayload } from '../../shared/approval'
import { agentClient } from '../lib/agent-client'

export interface UseApprovalsOptions {
  onLog: (line: string) => void
  /** 审批请求到达/回执后通知外部：approval-requested/decided 已落库，审计要刷新 */
  onActivity?: () => void
}

export function useApprovals({ onLog, onActivity }: UseApprovalsOptions) {
  const [queue, setQueue] = useState<ApprovalRequestPayload[]>([])

  const logRef = useRef(onLog)
  logRef.current = onLog
  const activityRef = useRef(onActivity)
  activityRef.current = onActivity

  useEffect(() => {
    let active = true

    // 按 requestId 去重：推送与补水可能带来同一条请求
    const merge = (incoming: ApprovalRequestPayload[]): void => {
      setQueue((prev) => {
        const known = new Set(prev.map((item) => item.requestId))
        return [...prev, ...incoming.filter((item) => !known.has(item.requestId))]
      })
    }

    // 主进程推送审批请求；执行器在等回执，不回就等于让它挂到超时（超时按拒绝）
    const off = agentClient.onApprovalRequest((request) => {
      logRef.current(`[审批] 收到 ${request.tool}（${request.runId}）`)
      merge([request])
      activityRef.current?.()
    })

    // 窗口重开/刷新后，把主进程记着的待审批补回来
    void agentClient.listPendingApprovals().then((items) => {
      if (!active || items.length === 0) return
      logRef.current(`[审批] 恢复 ${items.length} 条待处理`)
      merge(items)
    })

    return () => {
      active = false
      off()
    }
  }, [])

  const decide = async (decision: ApprovalDecision): Promise<void> => {
    const current = queue[0]
    if (!current) return

    setQueue((prev) => prev.slice(1))
    await agentClient.approve({ requestId: current.requestId, decision })
    logRef.current(`[审批] ${current.tool} → ${decision}`)
    activityRef.current?.()
  }

  return { current: queue[0] ?? null, decide }
}
