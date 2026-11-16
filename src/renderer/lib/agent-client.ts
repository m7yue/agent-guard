// 渲染层唯一接触 window.agentguard 的地方。
//
// 这是一条"接缝"而不是抽象层：组件只依赖这里导出的形状。
// 将来要跑在 Web 上，只需另写一份实现（fetch + EventSource），组件一行不用改。
import type { AgentEvent } from '../../shared/agent-event'
import type { ApprovalDecision, ApprovalRequestPayload } from '../../shared/approval'
import type {
  AuditEvent,
  ConversationDeleteOutput,
  ConversationSummary,
  CreateConversationInput,
  DeleteMemoryInput,
  DeleteMemoryOutput,
  Envelope,
  ListMemoriesInput,
  ListMemoriesOutput,
  UpdateMemoryInput,
  UpdateMemoryOutput,
} from '../../shared/contracts'
import type { MemoryItem } from '../../shared/memory'
import type { UpdateStatus } from '../../shared/update'

export type AskResult = { ok: true; runId: string } | { ok: false; message: string }

export interface AgentClient {
  /** 当前模型模式，界面用来显示 mock / real */
  ping(): Promise<{ mode: 'mock' | 'real' } | null>
  ask(input: { conversationId: string; prompt: string }): Promise<AskResult>
  cancel(runId: string): Promise<void>
  approve(input: { requestId: string; decision: ApprovalDecision }): Promise<void>
  /** 拉取当前待审批列表：窗口刷新/重开后恢复队列 */
  listPendingApprovals(): Promise<ApprovalRequestPayload[]>
  /** 审计事件（按时间倒序） */
  listAuditEvents(options?: { conversationId?: string; limit?: number }): Promise<AuditEvent[]>
  /** 触发一次更新检查；返回是否已转交更新器 */
  checkUpdate(): Promise<boolean>
  /** 下载已发现的新版本 */
  downloadUpdate(): Promise<boolean>
  /** 退出并安装 */
  installUpdate(): Promise<boolean>
  /** 订阅更新状态；返回取消订阅函数 */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  /** 上报首帧时间（主进程用于启动打点） */
  reportPerf(input: { firstPaintMs: number }): Promise<void>
  /** 把渲染层未捕获的异常报给主进程 */
  reportError(input: { message: string; stack?: string; source?: string }): Promise<void>
  /** 会话列表（按最近活动排序），侧栏用 */
  listConversations(): Promise<ConversationSummary[]>
  /** 某个会话的历史（纯文本）与它绑定的工作区，切换会话时用来回放 */
  loadConversation(
    conversationId: string,
  ): Promise<{ workspaceRoot: string; items: Array<{ role: 'user' | 'assistant'; text: string }> }>
  /** 打开系统目录选择器；取消返回 null */
  chooseWorkspace(): Promise<{ path: string; token: string } | null>
  /** 新建会话并绑定工作区；失败返回错误信息 */
  createConversation(input: CreateConversationInput): Promise<{ ok: true } | { ok: false; message: string }>
  /** 软删会话：拒绝（运行中）用 status 表达，不算传输失败 */
  deleteConversation(input: { conversationId: string }): Promise<Envelope<ConversationDeleteOutput>>
  /** 记忆列表摘要；支持服务端搜索/筛选/分页；读失败时抛错 */
  listMemories(input: ListMemoriesInput): Promise<ListMemoriesOutput>
  /** 读取一条记忆的完整正文；不存在返回 null，读失败时抛错 */
  loadMemory(name: string): Promise<MemoryItem | null>
  /** 编辑记忆；返回原始信封，UI 用 reason/current 处理冲突 */
  updateMemory(input: UpdateMemoryInput): Promise<Envelope<UpdateMemoryOutput>>
  /** 删除记忆；返回原始信封，UI 用 reason 处理 run-active/conflict */
  deleteMemory(input: DeleteMemoryInput): Promise<Envelope<DeleteMemoryOutput>>
  onAgentEvent(listener: (payload: { runId: string; event: AgentEvent }) => void): () => void
  onApprovalRequest(listener: (payload: ApprovalRequestPayload) => void): () => void
  /** 实验室视图的演示面板用（工作台之外，入口见 App 的视图切换） */
  demo: {
    ping: () => ReturnType<typeof window.agentguard.ping>
    echo: (input: { text: string }) => ReturnType<typeof window.agentguard.echo>
    busy: (input: { ms: number }) => ReturnType<typeof window.agentguard.busy>
    busyMain: (input: { ms: number }) => ReturnType<typeof window.agentguard.busyMain>
    crashExecutor: () => ReturnType<typeof window.agentguard.crashExecutor>
  }
}

export const agentClient: AgentClient = {
  async ping() {
    const result = await window.agentguard.ping()
    return result.ok ? { mode: result.data.mode } : null
  },

  async ask(input) {
    const result = await window.agentguard.ask(input)
    return result.ok ? { ok: true, runId: result.data.runId } : { ok: false, message: result.error.message }
  },

  async cancel(runId) {
    await window.agentguard.cancel({ runId })
  },

  async approve(input) {
    await window.agentguard.approve(input)
  },

  async listPendingApprovals() {
    const result = await window.agentguard.listPendingApprovals()
    return result.ok ? result.data.items : []
  },

  async listAuditEvents(options = {}) {
    const result = await window.agentguard.listAuditEvents(options)
    return result.ok ? result.data.items : []
  },

  async checkUpdate() {
    const result = await window.agentguard.checkUpdate({})
    return result.ok && result.data.accepted
  },

  async downloadUpdate() {
    const result = await window.agentguard.downloadUpdate({})
    return result.ok && result.data.accepted
  },

  async installUpdate() {
    const result = await window.agentguard.installUpdate({})
    return result.ok && result.data.accepted
  },

  onUpdateStatus(listener) {
    return window.agentguard.onUpdateStatus(listener)
  },

  async reportPerf(input) {
    await window.agentguard.reportPerf(input)
  },

  async reportError(input) {
    await window.agentguard.reportError(input)
  },

  async listConversations() {
    const result = await window.agentguard.listConversations()
    return result.ok ? result.data.items : []
  },

  async loadConversation(conversationId) {
    const result = await window.agentguard.loadConversation({ conversationId })
    return result.ok
      ? { workspaceRoot: result.data.workspaceRoot, items: result.data.items }
      : { workspaceRoot: '', items: [] }
  },

  async chooseWorkspace() {
    const result = await window.agentguard.chooseWorkspace({})
    if (!result.ok || !result.data.path || !result.data.token) return null
    return { path: result.data.path, token: result.data.token }
  },

  async createConversation(input) {
    const result = await window.agentguard.createConversation(input)
    return result.ok ? { ok: true } : { ok: false, message: result.error.message }
  },

  async deleteConversation(input) {
    return window.agentguard.deleteConversation(input)
  },

  async listMemories(input) {
    const result = await window.agentguard.listMemories(input)
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  },

  async loadMemory(name) {
    const result = await window.agentguard.loadMemory({ name })
    if (!result.ok) throw new Error(result.error.message)
    return result.data.item
  },

  async updateMemory(input) {
    return window.agentguard.updateMemory(input)
  },

  async deleteMemory(input) {
    return window.agentguard.deleteMemory(input)
  },

  onAgentEvent(listener) {
    return window.agentguard.onAgentEvent(listener)
  },

  onApprovalRequest(listener) {
    return window.agentguard.onApprovalRequest(listener)
  },

  demo: {
    ping: () => window.agentguard.ping(),
    echo: (input) => window.agentguard.echo(input),
    busy: (input) => window.agentguard.busy(input),
    busyMain: (input) => window.agentguard.busyMain(input),
    crashExecutor: () => window.agentguard.crashExecutor(),
  },
}
