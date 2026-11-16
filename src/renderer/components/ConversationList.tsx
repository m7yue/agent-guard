import { DeleteOutlined } from '@ant-design/icons'
import type { JSX } from 'react'
import { Button, Popconfirm } from 'antd'
import type { ConversationSummary } from '../../shared/contracts'

interface ConversationListProps {
  items: ConversationSummary[]
  activeId: string
  /** 有任务在跑的会话（行内显示"运行中"；运行中不可删除） */
  runningIds: Set<string>
  onSelect: (id: string) => void
  onCreate: () => void
  /** 软删会话：成功后列表刷新、若删的是当前会话则切到新会话 */
  onDelete: (id: string) => void
}

// 会话时间：今天只显示时刻，更早显示月日——列表里时间只是排序线索，精确值看 tooltip
function formatSessionTime(timestamp: number): { text: string; title: string } {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const isToday = new Date().toDateString() === date.toDateString()
  return {
    text: isToday ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    title: date.toLocaleString(),
  }
}

export function ConversationList({
  items,
  activeId,
  runningIds,
  onSelect,
  onCreate,
  onDelete,
}: ConversationListProps): JSX.Element {
  return (
    <div className="sessions">
      <div className="panel-head">
        会话
        <Button size="small" type="text" onClick={onCreate}>
          新建
        </Button>
      </div>

      <div className="sessions-list">
        {items.length === 0 ? (
          <div className="sessions-empty">还没有会话。新建一个，交代它一个任务。</div>
        ) : (
          items.map((item) => {
            const time = formatSessionTime(item.updatedAt)
            return (
              <div
                key={item.id}
                className={`session-row${item.id === activeId ? ' active' : ''}`}
                onClick={() => onSelect(item.id)}
              >
                <span className="session-title" title={item.title || '未命名会话'}>
                  {item.title || '未命名会话'}
                  {runningIds.has(item.id) ? <span className="session-running">运行中</span> : null}
                </span>
                <span className="session-workspace" title={item.workspaceRoot}>
                  {item.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || item.workspaceRoot}
                </span>
                <div className="session-meta">
                  <time title={time.title}>{time.text}</time>
                  <span>{item.messageCount} 条</span>
                </div>

                {/* 删除是破坏性操作：Popconfirm 二次确认；运行中禁删（执行器侧还有守卫） */}
                <Popconfirm
                  title="删除这个会话？"
                  description="对话与运行记录将归档（审计可查），并从检索语料中移除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  disabled={runningIds.has(item.id)}
                  onConfirm={(event) => {
                    event?.stopPropagation()
                    onDelete(item.id)
                  }}
                  onCancel={(event) => event?.stopPropagation()}
                >
                  <Button
                    className="conversation-delete"
                    size="small"
                    type="text"
                    danger
                    aria-label="删除会话"
                    title="删除会话"
                    icon={<DeleteOutlined />}
                    disabled={runningIds.has(item.id)}
                    onClick={(event) => event.stopPropagation()}
                  />
                </Popconfirm>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
