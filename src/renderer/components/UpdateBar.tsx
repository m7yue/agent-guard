import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button } from 'antd'
import type { UpdateStatus } from '../../shared/update'
import { agentClient } from '../lib/agent-client'

function describe(status: UpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 ${status.version}`
    case 'not-available':
      return '已是最新版本'
    case 'downloading':
      return `正在下载 ${status.percent}%`
    case 'downloaded':
      return `新版本 ${status.version} 已下载，重启后安装`
    case 'error':
      return `更新失败：${status.message}`
    case 'unavailable':
      return status.message
    default:
      // idle：左侧只交代「这是什么」，动作由右侧按钮表达，避免两处都说「检查更新」
      return '自动更新'
  }
}

/**
 * 更新状态条：订阅主进程推送的 update-status，按阶段给一个动作按钮。
 * 下载完成后才允许安装；其余阶段只提供"检查"或"下载"。
 * 行为保持 更新 验收语义（unavailable 时可见并隐藏动作按钮），只做样式收敛为细条。
 */
export function UpdateBar(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus>({ phase: 'idle' })

  useEffect(() => agentClient.onUpdateStatus(setStatus), [])

  // unavailable 时没有任何可执行动作（开发态/未配源），只说明原因
  const action =
    status.phase === 'unavailable' ? null : status.phase === 'available' ? (
      <Button size="small" type="primary" onClick={() => void agentClient.downloadUpdate()}>
        下载
      </Button>
    ) : status.phase === 'downloaded' ? (
      <Button size="small" type="primary" onClick={() => void agentClient.installUpdate()}>
        重启并安装
      </Button>
    ) : (
      <Button size="small" type="text" onClick={() => void agentClient.checkUpdate()}>
        检查更新
      </Button>
    )

  return (
    <div className="update-bar">
      <span>{describe(status)}</span>
      {action}
    </div>
  )
}
