// 待审批请求的登记表：由主进程独占。
//
// 由主进程记账，而不是只放在渲染层：窗口刷新或关闭时，请求不会没人接，
// 窗口重新出现后可以再拉一次，把队列恢复出来。
import type { ApprovalRequestPayload } from '../shared/approval'

export interface ApprovalRegistry {
  add(request: ApprovalRequestPayload): void
  list(): ApprovalRequestPayload[]
  /** 取出并移除；不存在返回 null（重复点击、过期回执都走这里） */
  take(requestId: string): ApprovalRequestPayload | null
  size(): number
}

export function createApprovalRegistry(): ApprovalRegistry {
  const pending = new Map<string, ApprovalRequestPayload>()

  return {
    add(request) {
      pending.set(request.requestId, request)
    },
    list() {
      return [...pending.values()]
    },
    take(requestId) {
      const request = pending.get(requestId) ?? null
      pending.delete(requestId)
      return request
    },
    size() {
      return pending.size
    },
  }
}
