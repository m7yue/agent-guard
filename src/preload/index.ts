// [KP-02] preload：页面加载之前先跑，能用 Node API；对页面的出口只有 contextBridge 上挂的那几个函数。
//
// [KP-06] preload 从通道表派生方法名与 channel，不手写字符串。
// 只引 channels.ts（零依赖），不引 contracts.ts——契约带 zod schema，会把它整份打进产物。
// 前提是 preload 被打成单文件（sandbox 下不能 require 本地文件，打包发生在构建期）。
import { contextBridge, ipcRenderer } from 'electron'
import type { AgentGuardApi } from '../shared/contracts'
// 只引通道表（零依赖），不引契约——契约带 zod schema，会把整份 zod 打进 preload 产物
import { CHANNELS, PUSH_CHANNELS } from '../shared/channels'
import type { AgentEvent } from '../shared/agent-event'
import { extraMethods, missingMethods } from '../shared/api-shape'


import type { UpdateStatus } from '../shared/update'
import type { ApprovalRequestPayload } from '../shared/approval'

// Object.entries 只能推出 Record<string, (...args) => ...>，
// 这里断言回契约声明的形状；真正的一致性由 channels.ts 与契约的对账测试保证。
const invokeMethods = Object.fromEntries(
  Object.entries(CHANNELS).map(([channel, entry]) => [
    entry.method,
    (input: unknown) => ipcRenderer.invoke(channel, input ?? {}),
  ]),
)

// 推送类能力没法从通道表派生（它不是 invoke），单独挂一个订阅方法。
// 回调只把 payload 交出去，ipcRenderer 的 event 对象不外传。
const api = {
  ...invokeMethods,
  // 审批请求由主进程推送（来源是执行器的 approval-request）；这里只转发 payload
  onApprovalRequest: (listener: (payload: ApprovalRequestPayload) => void) => {
    const handler = (_event: unknown, payload: ApprovalRequestPayload): void => listener(payload)
    ipcRenderer.on(PUSH_CHANNELS.approvalRequest, handler)
    return (): void => {
      ipcRenderer.removeListener(PUSH_CHANNELS.approvalRequest, handler)
    }
  },

  onUpdateStatus: (listener: (status: UpdateStatus) => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status)
    ipcRenderer.on(PUSH_CHANNELS.updateStatus, handler)
    return (): void => {
      ipcRenderer.removeListener(PUSH_CHANNELS.updateStatus, handler)
    }
  },

  onAgentEvent: (listener: (payload: { runId: string; event: AgentEvent }) => void) => {
    // 只把 payload 交出去，ipcRenderer 的 event 对象不外传
    const handler = (_event: unknown, payload: { runId: string; event: AgentEvent }): void => listener(payload)
    ipcRenderer.on(PUSH_CHANNELS.agentEvent, handler)
    return (): void => {
      ipcRenderer.removeListener(PUSH_CHANNELS.agentEvent, handler)
    }
  },
} as unknown as AgentGuardApi

// 启动自检：契约声明的方法必须和实际暴露的一致，否则立刻在控制台报出来。
// 这补上了 `as unknown as AgentGuardApi` 这处断言留下的空白。
const exposed = Object.keys(invokeMethods)
const missing = missingMethods(CHANNELS, exposed)
const extra = extraMethods(CHANNELS, exposed)
if (missing.length > 0 || extra.length > 0) {
  console.error('[preload] 契约与暴露面不一致', { missing, extra })
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('agentguard', api)
} else {
  // 不安全模式：两个世界被打开，只能直接挂到共享的全局对象上
  ;(globalThis as Record<string, unknown>).agentguard = api
}
