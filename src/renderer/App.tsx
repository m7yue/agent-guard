import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Segmented, Button } from 'antd'
import type { ConversationSummary } from '../shared/contracts'
import { ApprovalModal } from './components/ApprovalModal'
import { AuditPanel } from './components/AuditPanel'
import { AttackPanel } from './components/AttackPanel'
import { ChatPanel } from './components/ChatPanel'
import { ConversationList } from './components/ConversationList'
import { ContractPanel } from './components/ContractPanel'
import { ExecutorPanel } from './components/ExecutorPanel'
import { LogDrawer } from './components/LogDrawer'
import { MemoryPanel } from './components/MemoryPanel'
import { UpdateBar } from './components/UpdateBar'
import { useApprovals } from './hooks/useApprovals'
import { useChat } from './hooks/useChat'
import { agentClient } from './lib/agent-client'

// 工作台 = 产品界面（会话/对话/审批/审计，三栏同屏：看着它干活 + 同时查依据）；
// 实验室 = 攻击实验 / IPC 契约 / 执行器进程三个演示面板的独立入口，不进工作台。
type WorkspaceView = 'workbench' | 'lab'

// 审计面板是否展开：记住上次选择（默认展开——演示场景需要三栏同屏）
const AUDIT_OPEN_KEY = 'agentguard:audit-open'

// 顶栏/日志头的调试信息：属于排障材料，不占产品头部
function debugMeta(mode: string): string {
  return `${document.title} · ${location.href} · 模型 ${mode || '检测中…'}`
}

export function App(): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [mode, setMode] = useState<string>('')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [activeView, setActiveView] = useState<WorkspaceView>('workbench')
  const [isMemoryOpen, setIsMemoryOpen] = useState(false)
  const [isAuditOpen, setIsAuditOpen] = useState<boolean>(
    () => localStorage.getItem(AUDIT_OPEN_KEY) !== '0',
  )
  // 审计刷新信号：运行开始/结束、审批到达时递增（审计读库，靠活动点通知重查）
  const [auditTick, setAuditTick] = useState(0)

  useEffect(() => {
    localStorage.setItem(AUDIT_OPEN_KEY, isAuditOpen ? '1' : '0')
  }, [isAuditOpen])

  // 固定引用：子组件与 hooks 依赖它，否则会重复订阅
  const onLog = useCallback((line: string): void => {
    setLines((prev) => [...prev, line])
  }, [])

  // 会话列表按最近活动排序：每次有新消息落库后重新拉一次
  const refreshConversations = useCallback((): void => {
    void agentClient.listConversations().then(setConversations)
  }, [])

  // 会话活动（运行开始/结束/失败/取消）：列表与审计都要刷新
  const handleChatActivity = useCallback((): void => {
    refreshConversations()
    setAuditTick((tick) => tick + 1)
  }, [refreshConversations])

  // 审批活动（请求到达/回执）：只影响审计，列表不用重拉
  const handleApprovalActivity = useCallback((): void => {
    setAuditTick((tick) => tick + 1)
  }, [])

  // 记忆编辑/删除成功后刷新审计（memory-written / memory-deleted）
  const handleMemoryChanged = useCallback((): void => {
    setAuditTick((tick) => tick + 1)
  }, [])

  const chat = useChat({ onLog, onConversationChange: handleChatActivity })
  const approvals = useApprovals({ onLog, onActivity: handleApprovalActivity })

  useEffect(() => {
    void agentClient.ping().then((result) => {
      if (result) setMode(result.mode)
    })
  }, [])

  useEffect(() => {
    refreshConversations()
  }, [refreshConversations])

  // 幽灵会话守卫（只做一次）：localStorage 记住的会话可能已被删除——
  // 首次列表加载后若当前 id 不在其中，切到新会话，避免往已删会话里写数据
  const ghostGuardDone = useRef(false)
  useEffect(() => {
    if (ghostGuardDone.current || conversations.length === 0) return
    ghostGuardDone.current = true
    if (!conversations.some((conversation) => conversation.id === chat.conversationId)) {
      void chat.newConversation()
    }
    // chat 的方法引用固定（useChat 返回的字段每次渲染都重建，故只依赖 conversations）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          AgentGuard
          <span className="brand-sub">可审计的本地 Agent 执行器</span>
        </div>

        <div className="header-right">
          <Segmented
            value={activeView}
            onChange={(value) => setActiveView(value as WorkspaceView)}
            options={[
              { label: '工作台', value: 'workbench' },
              { label: '实验室', value: 'lab' },
            ]}
          />
          <Button size="small" onClick={() => setIsMemoryOpen(true)}>
            记忆
          </Button>
          <span className={`model-chip${mode === 'real' ? ' real' : ''}`}>
            {mode || '检测中'}
          </span>
        </div>
      </header>

      <UpdateBar />

      {activeView === 'workbench' ? (
        <div className="app-body">
          <aside className="col col-sessions">
            <ConversationList
              items={conversations}
              activeId={chat.conversationId}
              runningIds={chat.runningConversationIds}
              onSelect={chat.openConversation}
              onCreate={() => void chat.newConversation()}
              onDelete={(id) => void chat.removeConversation(id)}
            />
          </aside>

          <main className="col col-chat">
            <div className="panel-head panel-head-chat">
              <span>
                {conversations.find((conversation) => conversation.id === chat.conversationId)?.title ||
                  '新会话'}
              </span>
              {chat.workspaceRoot ? (
                <span className="workspace-path" title={chat.workspaceRoot}>
                  工作区：{chat.workspaceRoot}
                </span>
              ) : null}
            </div>
            <ChatPanel
              messages={chat.messages}
              running={chat.running}
              onSend={(text) => void chat.send(text)}
              onCancel={() => void chat.cancel()}
            />
          </main>

          {isAuditOpen ? (
            <aside className="col col-audit">
              <AuditPanel
                conversationId={chat.conversationId}
                conversationTitle={
                  conversations.find((conversation) => conversation.id === chat.conversationId)?.title ??
                  ''
                }
                refreshToken={auditTick}
                onCollapse={() => setIsAuditOpen(false)}
              />
            </aside>
          ) : (
            <button
              className="audit-handle"
              title="展开审计"
              onClick={() => setIsAuditOpen(true)}
            >
              ‹ 审计
            </button>
          )}
        </div>
      ) : (
        <div className="lab-scroll">
          <section className="panel">
            <div className="panel-title">攻击实验</div>
            <div className="panel-body">
              <AttackPanel onLog={onLog} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">IPC 契约</div>
            <div className="panel-body">
              <ContractPanel onLog={onLog} />
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">执行器进程</div>
            <div className="panel-body">
              <ExecutorPanel onLog={onLog} />
            </div>
          </section>
        </div>
      )}

      <LogDrawer lines={lines} meta={debugMeta(mode)} />

      <ApprovalModal
        request={approvals.current}
        onDecide={(decision) => void approvals.decide(decision)}
      />

      <MemoryPanel
        open={isMemoryOpen}
        isAnyRunActive={chat.runningConversationIds.size > 0}
        onClose={() => setIsMemoryOpen(false)}
        onChanged={handleMemoryChanged}
      />
    </div>
  )
}
