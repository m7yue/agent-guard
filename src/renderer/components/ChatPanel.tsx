import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { Button, Input } from 'antd'
import type { ChatMessage } from '../hooks/useChat'

interface ChatPanelProps {
  messages: ChatMessage[]
  running: boolean
  onSend: (text: string) => void
  onCancel: () => void
}

// 纯视图：状态与副作用都在 useChat 里，由 App 注入
export function ChatPanel({ messages, running, onSend, onCancel }: ChatPanelProps): JSX.Element {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // 新消息进来时滚到底部
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [messages])

  const submit = (): void => {
    const text = input.trim()
    if (!text) return
    setInput('')
    onSend(text)
  }

  return (
    <div className="chat">
      <div className="chat-scroll" ref={listRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            交代它一个任务。
            <br />
            需要的操作会先弹审批问你，
            <br />
            每一步都记进右侧的审计。
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`bubble ${message.role}${message.pending ? ' pending' : ''}`}
            >
              {message.text || (message.pending ? '' : '（空回复）')}
            </div>
          ))
        )}
      </div>

      <div className="composer">
        <Input.TextArea
          value={input}
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={running}
          onChange={(event) => setInput(event.target.value)}
          onPressEnter={(event) => {
            if (event.shiftKey) return
            event.preventDefault()
            submit()
          }}
          placeholder="交给 Agent 一个任务…（Enter 发送，Shift+Enter 换行）"
        />
        {running ? (
          <Button danger onClick={onCancel}>
            停止
          </Button>
        ) : (
          <Button type="primary" onClick={submit}>
            发送
          </Button>
        )}
      </div>
    </div>
  )
}
