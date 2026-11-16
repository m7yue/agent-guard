// 对话状态机：发送、流式追加、收尾、取消，以及多会话的切换与后台运行。
//
// 关键设计：状态按 conversationId 分桶（messagesByConversation / runningRuns），
// 而不是"一个全局 messages"。这样切到别的会话时，原会话的运行仍在后台继续，
// 事件按 runId → conversationId 的路由写回它自己的桶里。
import { useEffect, useRef, useState } from 'react'
import { agentClient } from '../lib/agent-client'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  pending?: boolean
}

// localStorage 只存"当前打开哪个会话"，不存消息——消息在 SQLite 里
const STORAGE_KEY = 'agentguard:conversationId'
const newId = (): string => crypto.randomUUID()

// 流式 token 是增量文本，直接追加到最后一条助手消息
function appendToLast(messages: ChatMessage[], chunk: string): ChatMessage[] {
  if (messages.length === 0) return messages
  const next = [...messages]
  const last = next[next.length - 1]
  next[next.length - 1] = { ...last, text: last.text + chunk }
  return next
}

// 收尾：去掉"正在输入"的光标状态
function settleLast(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages
  const next = [...messages]
  const last = next[next.length - 1]
  next[next.length - 1] = { ...last, pending: false }
  return next
}

export interface UseChatOptions {
  onLog: (line: string) => void
  /**
   * 会话有持久化活动时通知外部（运行开始/结束/失败/取消）：
   * App 用它刷新会话列表，并给审计面板发刷新信号——审计读的是库，
   * 渲染层只能靠这些活动点通知它「库变了」。
   */
  onConversationChange?: () => void
}

export function useChat({ onLog, onConversationChange }: UseChatOptions) {
  const [conversationId, setConversationId] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? newId(),
  )

  // 每个会话一份消息；Streaming 事件只改自己那一份
  const [messagesByConversation, setMessagesByConversation] = useState<
    Record<string, ChatMessage[]>
  >({})

  // 每个会话绑定的工作区；新建时写入，切换会话时从库里读回
  const [workspaceByConversation, setWorkspaceByConversation] = useState<Record<string, string>>({})

  // 每个会话的运行状态：conversationId → runId（awaiting 时放占位符）
  const [runningRuns, setRunningRuns] = useState<Record<string, string>>({})

  // runId → conversationId：事件回来时靠它找到该写哪个会话
  const runToConversation = useRef(new Map<string, string>())
  // ask 返回 runId 之前的极短窗口里，事件先归到"正在发起的那次"
  const pendingConversation = useRef<string | null>(null)
  // 已从库里加载过历史的会话，避免每次切换都重读
  const loadedConversations = useRef(new Set<string>())

  const logRef = useRef(onLog)
  logRef.current = onLog
  const changeRef = useRef(onConversationChange)
  changeRef.current = onConversationChange

  const messages = messagesByConversation[conversationId] ?? []
  const running = Boolean(runningRuns[conversationId])

  // 记住当前会话：重启后回到同一个，而不是又开一个新的
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, conversationId)
  }, [conversationId])

  // 首次切到某个会话时，从库里把历史读回来（之后由内存状态接管）
  useEffect(() => {
    if (loadedConversations.current.has(conversationId)) return
    loadedConversations.current.add(conversationId)

    // 刻意不做 active/卸载守卫：StrictMode 开发态会把 effect「挂载→卸载→再挂载」双跑，
    // 「先标记、后加载」加上卸载守卫的结果是——第一次加载被 cleanup 丢弃、第二次因已标记跳过，
    // 重启后首开的会话历史永远不显示。结果幂等（桶里已有消息就不覆盖）足以替代卸载守卫。
    void agentClient.loadConversation(conversationId).then(({ workspaceRoot, items }) => {
      if (workspaceRoot) {
        setWorkspaceByConversation((prev) => ({ ...prev, [conversationId]: workspaceRoot }))
      }
      if (items.length === 0) return
      setMessagesByConversation((prev) => {
        // 如果这期间已经有新消息（例如用户已开始发送），不要覆盖
        if (prev[conversationId]?.length) return prev
        return {
          ...prev,
          [conversationId]: items.map((item) => ({ id: newId(), role: item.role, text: item.text })),
        }
      })
    })
  }, [conversationId])

  // 事件订阅：按 runId 路由到对应会话，而不是"当前会话"
  useEffect(() => {
    const off = agentClient.onAgentEvent(({ runId, event }) => {
      const target = runToConversation.current.get(runId) ?? pendingConversation.current
      if (!target) return

      const update = (change: (list: ChatMessage[]) => ChatMessage[]): void => {
        setMessagesByConversation((prev) => ({ ...prev, [target]: change(prev[target] ?? []) }))
      }

      const clearRunning = (): void => {
        setRunningRuns((prev) => {
          const next = { ...prev }
          delete next[target]
          return next
        })
      }

      switch (event.type) {
        case 'token':
          update((list) => appendToLast(list, event.text))
          break
        case 'tool-call':
          logRef.current(`[工具调用] ${event.name}(${event.input})`)
          break
        case 'tool-result':
          logRef.current(
            `[${event.isError ? '工具错误' : '工具结果'}] ${event.name} → ${event.result}`,
          )
          break
        case 'tool-denied':
          logRef.current(`[工具拒绝] ${event.name} · ${event.stage} · ${event.reason}`)
          break
        case 'log':
          logRef.current(`[循环] ${event.message}`)
          break
        case 'done':
          update(settleLast)
          clearRunning()
          runToConversation.current.delete(runId)
          changeRef.current?.()
          break
        case 'cancelled':
          update((list) => settleLast(appendToLast(list, '\n（已停止）')))
          clearRunning()
          runToConversation.current.delete(runId)
          changeRef.current?.()
          break
        case 'error':
          update((list) => settleLast(appendToLast(list, `\n[错误] ${event.message}`)))
          clearRunning()
          runToConversation.current.delete(runId)
          // 失败的 run 也已落库（run-finished failed），审计同样要刷新
          changeRef.current?.()
          break
      }
    })

    return off
  }, [])

  /**
   * 在指定会话里发起一次运行（默认当前会话）。
   * 发送时就把消息写进目标会话的桶，所以运行中切换到别处也不会丢。
   */
  const send = async (text: string, targetConversationId = conversationId): Promise<void> => {
    const prompt = text.trim()
    if (!prompt || runningRuns[targetConversationId]) return

    setRunningRuns((prev) => ({ ...prev, [targetConversationId]: 'pending' }))
    setMessagesByConversation((prev) => ({
      ...prev,
      [targetConversationId]: [
        ...(prev[targetConversationId] ?? []),
        { id: newId(), role: 'user', text: prompt },
        { id: newId(), role: 'assistant', text: '', pending: true },
      ],
    }))

    pendingConversation.current = targetConversationId
    const result = await agentClient.ask({ conversationId: targetConversationId, prompt })
    pendingConversation.current = null

    if (!result.ok) {
      logRef.current(`[Agent] 启动失败：${result.message}`)
      setMessagesByConversation((prev) => ({
        ...prev,
        [targetConversationId]: settleLast(
          appendToLast(prev[targetConversationId] ?? [], `[启动失败] ${result.message}`),
        ),
      }))
      setRunningRuns((prev) => {
        const next = { ...prev }
        delete next[targetConversationId]
        return next
      })
      return
    }

    runToConversation.current.set(result.runId, targetConversationId)
    setRunningRuns((prev) => ({ ...prev, [targetConversationId]: result.runId }))
    logRef.current(`[Agent] 已启动 ${result.runId}（会话 ${targetConversationId.slice(0, 8)}）`)
    // run-started 已落库：通知审计刷新（会话列表的 messageCount 此时未变，多刷一次无副作用）
    changeRef.current?.()
  }

  /** 取消某个会话里正在跑的任务（默认当前会话） */
  const cancel = async (targetConversationId = conversationId): Promise<void> => {
    const runId = runningRuns[targetConversationId]
    if (!runId || runId === 'pending') return
    logRef.current(`[Agent] 请求停止 ${runId}`)
    await agentClient.cancel(runId)
  }

  // 运行中也可以切换：后台运行不阻塞浏览其它会话
  const openConversation = (id: string): void => setConversationId(id)

  // 新建会话：先选目录，取消则不创建；创建成功后切换过去
  const newConversation = async (): Promise<void> => {
    const chosen = await agentClient.chooseWorkspace()
    if (!chosen) return

    const id = newId()
    const created = await agentClient.createConversation({
      conversationId: id,
      workspaceRoot: chosen.path,
      workspaceToken: chosen.token,
    })
    if (!created.ok) {
      logRef.current(`[Agent] 新建会话失败：${created.message}`)
      return
    }
    setWorkspaceByConversation((prev) => ({ ...prev, [id]: chosen.path }))
    setConversationId(id)
    changeRef.current?.()
  }

  /**
   * 软删一个会话：成功后清掉它的内存状态（桶、已加载标记），
   * 删的是当前会话就切到新会话。拒绝（运行中等）只记日志，不动状态。
   */
  const removeConversation = async (id: string): Promise<void> => {
    const result = await agentClient.deleteConversation({ conversationId: id })
    if (!result.ok) {
      logRef.current(`[Agent] 删除请求失败：${result.error.message}`)
      return
    }
    if (result.data.status === 'run-active') {
      logRef.current('[Agent] 删除被拒：会话有正在进行的运行')
      return
    }

    loadedConversations.current.delete(id)
    setMessagesByConversation((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (id === conversationId) void newConversation()
    changeRef.current?.()
  }

  return {
    conversationId,
    workspaceRoot: workspaceByConversation[conversationId] ?? '',
    messages,
    running,
    /** 有任务在跑的会话 id 集合，列表用来显示"运行中" */
    runningConversationIds: new Set(Object.keys(runningRuns)),
    send,
    cancel,
    openConversation,
    newConversation,
    removeConversation,
  }
}
