import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { App } from './App'
import { agentClient } from './lib/agent-client'
import { ErrorBoundary } from './components/ErrorBoundary'
import './app.css'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root 挂载点')

// 主题 token：主色是墨蓝（工具的克制），唯一强调色 signal（#C2410C）
// 留给「需要人决定」的审批（ApprovalModal 局部覆盖），不在全局与主色争。
createRoot(root).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1A2332',
          colorInfo: '#1A2332',
          colorSuccess: '#15803D',
          colorWarning: '#C2410C',
          colorError: '#B42318',
          colorTextBase: '#1A2332',
          borderRadius: 4,
        },
      }}
    >
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ConfigProvider>
  </StrictMode>,
)

// 首帧：等一次 rAF，拿到"页面真正要画的那一帧"的时间，交给主进程打点。
// 窗口被遮挡时 Chromium 会节流 rAF；采集（--perf）时已在 window.ts 里关闭节流。
requestAnimationFrame(() => {
  void agentClient.reportPerf({ firstPaintMs: Math.round(performance.now()) })
})

// 渲染层未捕获的异常：交给主进程落日志，否则只在用户控制台里一闪而过。
window.addEventListener('error', (event) => {
  void agentClient.reportError({
    message: event.message || 'window.error',
    stack: event.error instanceof Error ? event.error.stack : undefined,
    source: 'window.error',
  })
})

window.addEventListener('unhandledrejection', (event) => {
  void agentClient.reportError({
    message: String(event.reason),
    source: 'unhandledrejection',
  })
})
