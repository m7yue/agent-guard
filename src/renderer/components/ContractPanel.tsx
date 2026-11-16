import type { JSX } from 'react'
import { Button, Space } from 'antd'
import { agentClient } from '../lib/agent-client'
import { describe } from '../lib/envelope'

interface ContractPanelProps {
  onLog: (line: string) => void
}

export function ContractPanel({ onLog }: ContractPanelProps): JSX.Element {
  const ping = async (): Promise<void> => {
    onLog(describe('ping', await agentClient.demo.ping()))
  }

  const echoValid = async (): Promise<void> => {
    onLog(describe('echo 合法', await agentClient.demo.echo({ text: 'hello agents' })))
  }

  const echoBadType = async (): Promise<void> => {
    // 故意传错类型：运行时校验应当拦住
    onLog(describe('echo 类型错', await agentClient.demo.echo({ text: 12345 as never })))
  }

  const echoExtra = async (): Promise<void> => {
    // 故意多传字段：.strict() 应当拦住
    onLog(
      describe('echo 多余字段', await agentClient.demo.echo({ text: 'hi', admin: true } as never)),
    )
  }

  return (
    <Space wrap>
      <Button onClick={() => void ping()}>ping</Button>
      <Button onClick={() => void echoValid()}>echo 合法入参</Button>
      <Button onClick={() => void echoBadType()}>echo 类型错</Button>
      <Button onClick={() => void echoExtra()}>echo 多余字段</Button>
    </Space>
  )
}
