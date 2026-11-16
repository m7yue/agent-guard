// 契约驱动的 IPC 注册：所有 handler 走同一条路径（校验 → 执行 → 统一信封）。
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { CONTRACTS, ERROR, fail, ok, type Channel } from '../shared/contracts'
import { formatZodIssues } from '../shared/zod'
import { APPROVAL_CHANNEL } from '../shared/approval'
import { AGENT_EVENT_CHANNEL } from '../shared/agent-event'
import { UPDATE_CHANNEL, type UpdateStatus } from '../shared/update'
import { getLogger } from '../harness/logging/logger'
import { mark, setPageFirstPaint } from './perf'
import { getModelConfig } from '../harness/model/config'
import type { ReadStore } from '../harness/store'
import type { AgentProcessClient } from './agent-process-client'
import type { UpdaterController } from './updater'
import type { ApprovalRegistry } from './approval-registry'

// 目录选择器发放的一次性令牌：渲染层不能凭空指定任意路径当工作区
const workspaceTokens = new Map<string, string>()

// 记住上次选过的工作区，下次打开选择器时从这里开始（而不是系统默认的「下载」）
function workspacePreferenceFile(): string {
  return path.join(app.getPath('userData'), 'workspace-preference.json')
}

function loadLastWorkspace(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(workspacePreferenceFile(), 'utf8')) as {
      workspaceRoot?: unknown
    }
    const root = typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : ''
    if (root && existsSync(root) && statSync(root).isDirectory()) return root
    return null
  } catch {
    return null
  }
}

function saveLastWorkspace(root: string): void {
  try {
    writeFileSync(workspacePreferenceFile(), JSON.stringify({ workspaceRoot: root }), 'utf8')
  } catch {
    // 偏好写不进去不影响本次选择
  }
}

type InputOf<K extends Channel> = z.infer<(typeof CONTRACTS)[K]['input']>
type OutputOf<K extends Channel> = z.infer<(typeof CONTRACTS)[K]['output']>

// IPC 层的处理器（不是代数效应里的 handler）：输入是已校验的入参，输出是契约声明的出参
type IpcHandlers = { [K in Channel]: (input: InputOf<K>) => OutputOf<K> | Promise<OutputOf<K>> }

export interface IpcDeps {
  agentProcessClient: AgentProcessClient
  approvalRegistry: ApprovalRegistry
  /** 会话与运行记录（主进程只读，执行器写） */
  conversationStore: ReadStore
  /** 自动更新控制器；未配置更新源或开发态时为 null */
  updater: UpdaterController | null
  /** updater 为 null 时的原因（开发态 / 未配置更新源）；updater 存在时为 null */
  updateUnavailableMessage: string | null
  /** 待审批数量变化：托盘提示 + 必要时提醒用户 */
  onPendingChange: (count: number) => void
}

let askSeq = 0

// 纯 CPU 忙等：对照"在主进程里做重活"会发生什么
function busyWait(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // 空转
  }
}

function createIpcHandlers({
  agentProcessClient,
  approvalRegistry,
  conversationStore,
  updater,
  updateUnavailableMessage,
  onPendingChange,
}: IpcDeps): IpcHandlers {
  return {
    'app:ping': () => ({
      pong: true,
      pid: process.pid,
      // 主进程与执行器读同一份环境变量，这里能直接判定模式
      mode: getModelConfig() ? ('real' as const) : ('mock' as const),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    }),

    'app:echo': ({ text }) => ({ text, length: text.length }),

    'app:busy': async ({ ms }) => {
      const reply = await agentProcessClient.runBusy(ms)
      return { where: 'executor' as const, pid: reply.pid, elapsed: reply.elapsed }
    },

    'app:busy-main': ({ ms }) => {
      const started = Date.now()
      busyWait(ms)
      return { where: 'main' as const, pid: process.pid, elapsed: Date.now() - started }
    },

    'app:crash-executor': () => {
      agentProcessClient.crash()
      return { requested: true as const }
    },

    // 用户在界面上的选择 → 回执给执行器（执行器正在 await 这个结果）
    'app:approve': ({ requestId, decision }) => {
      const request = approvalRegistry.take(requestId)
      // 重复点击或已过期的回执：不报错，只是没接受
      if (!request) return { accepted: false }

      getLogger('approval').info('审批回执', { requestId, decision })
      agentProcessClient.respondApproval(requestId, decision)
      onPendingChange(approvalRegistry.size())
      return { accepted: true }
    },

    // 取消正在进行的运行（界面上的"停止"）
    'app:cancel': ({ runId }) => {
      agentProcessClient.cancel(runId)
      return { cancelled: true }
    },

    // 窗口刷新/重开后恢复审批队列
    'app:pending-approvals': () => ({ items: approvalRegistry.list() }),

    // 审计事件：执行器边跑边写，这里只读；按时间倒序，默认最近 100 条
    'app:audit-events': ({ conversationId, limit }) => ({
      items: conversationStore.listEvents({ conversationId, limit }),
    }),

    // 自动更新：三个动作只负责触发，结果通过 update-status 推送
    'app:check-update': () => {
      // updater 未启用时不能静默：推送 unavailable 让界面说明原因（accepted:false 只是应答，界面不展示）
      if (!updater) {
        const status: UpdateStatus = {
          phase: 'unavailable',
          message: updateUnavailableMessage ?? '自动更新未启用',
        }
        broadcastToWindows(UPDATE_CHANNEL, status)
        return { accepted: false }
      }
      updater.check()
      return { accepted: true }
    },

    'app:download-update': () => {
      updater?.download()
      return { accepted: updater !== null }
    },

    'app:install-update': () => {
      updater?.install()
      return { accepted: updater !== null }
    },

    // 渲染层首帧：在启动时间线上打一个点（含 IPC 往返，是上界）
    'app:report-perf': ({ firstPaintMs }) => {
      mark('first-paint')
      setPageFirstPaint(firstPaintMs)
      getLogger('perf').info('收到首帧回报', { firstPaintMs })
      return { recorded: true }
    },

    // 渲染层的未捕获异常：落进日志，供事后排查
    'app:report-error': ({ message, stack, source }) => {
      getLogger('renderer').error(message, { stack, source })
      return { recorded: true }
    },

    // 会话列表与历史：执行器已经把数据写好了，主进程直接读同一个库，
    // 不必再绕回执行器要一次（读连接在 WAL 下不会阻塞写入）
    'app:conversation-list': () => ({ items: conversationStore.listConversations() }),

    // 回放只取 text 块：库里存的是完整消息块（含 tool_use / tool_result），
    // 那些块是给模型续上下文用的；界面只需要知道"谁说了什么"。
    // 工具调用的细节在运行时就已写进下方日志，不必在历史里重放
    // （textOf 会把 tool_result 内容也拼进来，那是给模型看的，不是给回放看的）。
    // 纯工具轮次的文本为空：过滤掉，否则回放出一串"（空回复）"的气泡。
    'app:conversation-load': ({ conversationId }) => ({
      workspaceRoot: conversationStore.loadConversationWorkspace(conversationId) ?? '',
      items: conversationStore
        .loadMessages(conversationId)
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          text:
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .flatMap((block) => (block.type === 'text' ? [block.text] : []))
                  .join(''),
        }))
        .filter((item) => item.text.trim().length > 0),
    }),

    // 记忆列表：主进程只读，服务端搜索/筛选/分页；不返回全量。
    'app:memory-list': (input) => {
      const result = conversationStore.searchMemories(input)
      return {
        items: result.items.map(({ name, description, type, updatedAt }) => ({
          name,
          description,
          type,
          updatedAt,
        })),
        total: result.total,
      }
    },

    'app:memory-load': ({ name }) => ({
      item: conversationStore.loadMemory(name),
    }),

    'app:memory-update': async (input) => {
      const reply = await agentProcessClient.updateMemory(input)
      switch (reply.status) {
        case 'updated':
          return { status: 'updated' as const, item: reply.item }
        case 'conflict':
          return { status: 'conflict' as const, current: reply.current }
        case 'not-found':
          return { status: 'not-found' as const }
        case 'internal':
          return { status: 'internal' as const }
      }
    },

    'app:memory-delete': async (input) => {
      const reply = await agentProcessClient.deleteMemory(input)
      switch (reply.status) {
        case 'deleted':
          return { status: 'deleted' as const }
        case 'conflict':
          return { status: 'conflict' as const, current: reply.current }
        case 'run-active':
          return { status: 'run-active' as const }
        case 'not-found':
          return { status: 'not-found' as const }
        case 'internal':
          return { status: 'internal' as const }
      }
    },

    'app:ask': ({ conversationId, prompt }) => {
      // 跨重启也必须唯一：库里按 runId 存运行记录
      const runId = `run-${Date.now()}-${++askSeq}`
      agentProcessClient.ask({ runId, conversationId, prompt })
      return { runId }
    },

    // 删除是写操作：转发给执行器（唯一写者）做事务删除，等回执
    'app:conversation-create': async ({ conversationId, workspaceRoot, workspaceToken, title }) => {
      const tokenPath = workspaceToken ? workspaceTokens.get(workspaceToken) : undefined
      const devWorkspace = process.env.AGENTGUARD_WORKSPACE
      const allowedByDevOverride = !app.isPackaged && devWorkspace === workspaceRoot
      if (tokenPath !== workspaceRoot && !allowedByDevOverride) {
        throw new Error('工作区未通过目录选择器授权')
      }
      if (workspaceToken) workspaceTokens.delete(workspaceToken)
      const reply = await agentProcessClient.createConversation({
        conversationId,
        workspaceRoot,
        title: title ?? '',
      })
      if (reply.status === 'error') throw new Error(reply.message)
      return { created: true }
    },

    'app:workspace-choose': async () => {
      // 开发态自动化：AGENTGUARD_WORKSPACE 可跳过原生对话框；打包后不生效。
      const devWorkspace = process.env.AGENTGUARD_WORKSPACE
      if (!app.isPackaged && devWorkspace && existsSync(devWorkspace) && statSync(devWorkspace).isDirectory()) {
        const token = randomUUID()
        workspaceTokens.set(token, devWorkspace)
        saveLastWorkspace(devWorkspace)
        return { path: devWorkspace, token }
      }

      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const defaultPath = loadLastWorkspace() ?? app.getPath('documents')
      const options: OpenDialogOptions = {
        title: '选择 Agent 的工作区',
        defaultPath,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '选择此目录',
      }
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return { path: null, token: null }
      const path = result.filePaths[0]
      saveLastWorkspace(path)
      const token = randomUUID()
      workspaceTokens.set(token, path)
      return { path, token }
    },

    'app:conversation-delete': async ({ conversationId }) => {
      const reply = await agentProcessClient.deleteConversation(conversationId)
      return { status: reply.status }
    },
  }
}

// 启动即对账：契约里有、实现里没有（或反过来）直接崩，别等到用户点按钮
function assertContractsMatchIpcHandlers(ipcHandlers: Record<string, unknown>): void {
  const contractChannels = Object.keys(CONTRACTS)
  const handlerChannels = Object.keys(ipcHandlers)

  for (const channel of contractChannels) {
    if (!handlerChannels.includes(channel)) throw new Error(`契约里有 ${channel}，但没有实现`)
  }
  for (const channel of handlerChannels) {
    if (!contractChannels.includes(channel)) throw new Error(`实现了 ${channel}，但契约里没有`)
  }
  getLogger('contract').info('契约与实现已对齐', { channels: contractChannels })
}

// 为一个 channel 注册处理器：统一做入参校验、统一包结果信封
function registerIpcChannel<K extends Channel>(ipcHandlers: IpcHandlers, channel: K): void {
  const contract = CONTRACTS[channel]

  ipcMain.handle(channel, async (_event, rawInput: unknown) => {
    const parsed = contract.input.safeParse(rawInput ?? {})
    if (!parsed.success) {
      return fail(ERROR.BAD_INPUT, `${channel} 入参不合法，${formatZodIssues(parsed.error)}`)
    }

    try {
      // 校验通过后，类型才由 unknown 变成契约声明的入参类型
      const input = parsed.data as InputOf<K>
      return ok(await ipcHandlers[channel](input))
    } catch (err) {
      return fail(ERROR.INTERNAL, err instanceof Error ? err.message : String(err))
    }
  })
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const ipcHandlers = createIpcHandlers(deps)
  assertContractsMatchIpcHandlers(ipcHandlers)

  for (const channel of Object.keys(CONTRACTS) as Channel[]) {
    registerIpcChannel(ipcHandlers, channel)
  }
}

export function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// 执行器推上来的运行事件与审批请求，转发给所有窗口。
// 审批请求同时记账：窗口刷新/关闭都不会让请求"没人接"（执行器那边在挂起等回执）。
export function forwardAgentEvents(
  agentProcessClient: AgentProcessClient,
  approvalRegistry: ApprovalRegistry,
  onPendingChange: (count: number) => void,
): void {
  agentProcessClient.on('agent-event', (payload) => broadcastToWindows(AGENT_EVENT_CHANNEL, payload))

  agentProcessClient.on('approval-request', (request) => {
    approvalRegistry.add(request)
    onPendingChange(approvalRegistry.size())
    broadcastToWindows(APPROVAL_CHANNEL, request)
  })
}
