import { useState } from 'react'
import type { JSX } from 'react'
import { Button, Space } from 'antd'
import { agentClient } from '../lib/agent-client'

interface ExecutorPanelProps {
  onLog: (line: string) => void
}

const BUSY_MS = 1500

export function ExecutorPanel({ onLog }: ExecutorPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false)

  // 同一件重活分别在两个进程里跑，然后看"任务进行时另一条请求要等多久"
  const runBusy = async (where: 'executor' | 'main'): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const label = where === 'main' ? '主进程' : '执行器'
      const task =
        where === 'main'
          ? agentClient.demo.busyMain({ ms: BUSY_MS })
          : agentClient.demo.busy({ ms: BUSY_MS })

      const pingStart = performance.now()
      const pingResult = await agentClient.demo.ping()
      const pingMs = performance.now() - pingStart

      const result = await task
      if (!result.ok) {
        onLog(`[${label}忙等] 失败：${result.error.message}`)
        return
      }

      const mainPid = pingResult.ok ? pingResult.data.pid : -1
      onLog(
        `[${label}忙等 ${BUSY_MS}ms] 任务耗时 ${result.data.elapsed}ms；` +
          `期间 ping 往返 ${pingMs.toFixed(0)}ms；执行 pid=${result.data.pid}（主进程 pid=${mainPid}）`,
      )
    } finally {
      setBusy(false)
    }
  }

  const crashExecutor = async (): Promise<void> => {
    const result = await agentClient.demo.crashExecutor()
    onLog(
      result.ok
        ? '[崩溃演示] 已请求执行器退出；主进程应仍然存活'
        : `[崩溃演示] 失败：${result.error.message}`,
    )
  }

  return (
    <Space wrap>
      <Button loading={busy} onClick={() => void runBusy('executor')}>
        执行器忙等 {BUSY_MS}ms
      </Button>
      <Button loading={busy} onClick={() => void runBusy('main')}>
        主进程忙等 {BUSY_MS}ms（对照）
      </Button>
      <Button danger onClick={() => void crashExecutor()}>
        让执行器崩溃
      </Button>
    </Space>
  )
}
