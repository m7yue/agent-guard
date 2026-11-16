// 通道表：channel → 页面方法名。**零依赖**，不含 schema。
//
// 为什么单独一个文件：sandbox 下的 preload 只能拿到 electron，它需要的是"方法名 → channel"
// 这张表，不需要 zod 校验。把表放在这里，preload 就不会把整份 schema（和 zod）打进产物。
// 契约（contracts.ts）从这张表派生，所以"改一处、两边同步"仍然成立。
export const CHANNELS = {
  'app:ping': { method: 'ping' },
  'app:echo': { method: 'echo' },
  'app:busy': { method: 'busy' },
  'app:busy-main': { method: 'busyMain' },
  'app:crash-executor': { method: 'crashExecutor' },
  'app:ask': { method: 'ask' },
  'app:approve': { method: 'approve' },
  'app:cancel': { method: 'cancel' },
  'app:audit-events': { method: 'listAuditEvents' },
  'app:check-update': { method: 'checkUpdate' },
  'app:download-update': { method: 'downloadUpdate' },
  'app:install-update': { method: 'installUpdate' },
  'app:report-perf': { method: 'reportPerf' },
  'app:report-error': { method: 'reportError' },
  'app:conversation-list': { method: 'listConversations' },
  'app:conversation-create': { method: 'createConversation' },
  'app:workspace-choose': { method: 'chooseWorkspace' },
  'app:conversation-load': { method: 'loadConversation' },
  'app:pending-approvals': { method: 'listPendingApprovals' },
  'app:memory-list': { method: 'listMemories' },
  'app:memory-load': { method: 'loadMemory' },
  'app:memory-update': { method: 'updateMemory' },
  'app:memory-delete': { method: 'deleteMemory' },
  'app:conversation-delete': { method: 'deleteConversation' },
} as const

// 推送类通道（主进程 → 渲染进程）：没有 invoke/handle，所以不进上面的表。
// 放在这里而不是各自的 schema 模块里，是为了让 preload 不必 import 带 zod 的模块。
export const PUSH_CHANNELS = {
  /** 审批请求：执行器 → 主进程 → 渲染进程 */
  approvalRequest: 'app:approval-request',
  /** Agent 运行事件流（token / 工具调用 / 结束） */
  agentEvent: 'app:agent-event',
  /** 自动更新状态 */
  updateStatus: 'app:update-status',
} as const

/** 所有合法的 channel 名（`app:xxx`） */
export type Channel = keyof typeof CHANNELS

/** 启动自检用：拿到全部 channel 名 */
export function channelNames(): Channel[] {
  return Object.keys(CHANNELS) as Channel[]
}
