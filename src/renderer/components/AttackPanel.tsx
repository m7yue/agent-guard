import type { JSX } from 'react'
import { Button, Space, Typography } from 'antd'

interface AttackPanelProps {
  onLog: (line: string) => void
}

// 安全模式下页面没有 require，这里会抛 ReferenceError——这就是"拿不到 Node"的具体长相
function getRequire(): ((id: string) => unknown) | null {
  const requireFn = (globalThis as { require?: (id: string) => unknown }).require
  return typeof requireFn === 'function' ? requireFn : null
}

export function AttackPanel({ onLog }: AttackPanelProps): JSX.Element {
  const readHosts = (): void => {
    try {
      const requireFn = getRequire()
      if (!requireFn) throw new ReferenceError('require is not defined')

      const fs = requireFn('node:fs') as typeof import('node:fs')
      const head = fs.readFileSync('/etc/hosts', 'utf8').split('\n').slice(0, 2).join(' / ')
      onLog(`[读文件] 成功：${head}`)
    } catch (error) {
      const err = error as Error
      onLog(`[读文件] 失败：${err.name}: ${err.message}`)
    }
  }

  const runWhoami = (): void => {
    try {
      const requireFn = getRequire()
      if (!requireFn) throw new ReferenceError('require is not defined')

      const { execSync } = requireFn('node:child_process') as typeof import('node:child_process')
      const who = execSync('whoami', { encoding: 'utf8' }).trim()
      onLog(`[执行命令] 成功：whoami = ${who}`)
    } catch (error) {
      const err = error as Error
      onLog(`[执行命令] 失败：${err.name}: ${err.message}`)
    }
  }

  return (
    <Space wrap>
      <Button onClick={readHosts}>读 /etc/hosts</Button>
      <Button onClick={runWhoami}>执行 whoami</Button>
      <Typography.Link
        href="https://example.com"
        onClick={() => onLog('[导航] 已请求跳转到 example.com')}
      >
        尝试把页面导航到外网
      </Typography.Link>
    </Space>
  )
}
