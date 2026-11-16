import { DownloadOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { Button, Tooltip } from 'antd'
import type { AuditEvent } from '../../shared/contracts'
import { agentClient } from '../lib/agent-client'

type AuditTone = 'default' | 'signal' | 'ok' | 'verdict'

// 事件类型 → 展示文案 / 语义色。颜色按「谁做的」分三组而不是彩虹：
// signal = 需要人决定（审批）· ok = 完成 · verdict = 删除；其余中性。
// 与 store 的 AuditEventType 枚举保持同步：store 新增事件类型时这里要补一行。
const LABELS: Record<string, { text: string; tone: AuditTone }> = {
  'run-started': { text: '开始运行', tone: 'default' },
  'approval-requested': { text: '请求审批', tone: 'signal' },
  'approval-decided': { text: '审批结果', tone: 'signal' },
  'tool-call': { text: '工具调用', tone: 'default' },
  'tool-result': { text: '工具结果', tone: 'default' },
  'tool-denied': { text: '工具拒绝', tone: 'signal' },
  retrieval: { text: '会话检索', tone: 'default' },
  'memory-used': { text: '记忆使用', tone: 'default' },
  'memory-written': { text: '记忆写入', tone: 'default' },
  'memory-deleted': { text: '记忆删除', tone: 'verdict' },
  'run-finished': { text: '运行结束', tone: 'ok' },
  'conversation-deleted': { text: '会话删除', tone: 'verdict' },
}

// 时间线一次载入的条数：视口概念，只影响展示（将来分页/滚动加载也只改这里）。
const TIMELINE_LIMIT = 200

// 导出限额：契约上限。导出语义 = 当前过滤范围的全量事件（至多此数），与展示条数无关。
const EXPORT_LIMIT = 500

// 摘要按事件类型取有意义的字段，而不是直接甩转义 JSON——
// 审计行是给人读的证据线索，不是数据转储；完整 payload 点击展开。
function summarize(item: AuditEvent): string {
  const clip = (value: unknown): string => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    return raw.length > 110 ? `${raw.slice(0, 110)}…` : raw
  }

  switch (item.type) {
    case 'run-started':
      return clip(item.payload.prompt)
    case 'tool-call':
      return `${item.payload.name} ${clip(item.payload.input)}`
    case 'tool-result':
      return `${item.payload.name} → ${clip(item.payload.result)}${item.payload.isError ? ' · 失败' : ''}`
    case 'tool-denied':
      return `${item.payload.name} · ${item.payload.stage} — ${clip(item.payload.reason)}`
    case 'retrieval': {
      // 重排标记：候选池缩到命中数的精排（重排）；旧事件与降级路径没有这段
      const rerankMark = item.payload.rerank
        ? ` · 重排 ${item.payload.rerank.candidateCount}→${item.payload.hits.length}`
        : ''
      return `“${item.payload.query}” · ${item.payload.mode} · 命中 ${item.payload.hits.length}${rerankMark}`
    }
    case 'memory-used': {
      const names = item.payload.names.join(', ')
      const mode = item.payload.reason === 'read' ? '' : ` · ${item.payload.mode}`
      return `${item.payload.reason} · ${names}${mode}`
    }
    case 'memory-written':
      return `${item.payload.name} (${item.payload.memoryType})${item.payload.action === 'updated' ? ' · 更新' : ' · 新增'}`
    case 'memory-deleted':
      return `${item.payload.name} (${item.payload.memoryType})`
    case 'approval-requested':
      return `${item.payload.tool} — ${clip(item.payload.reason)}`
    case 'approval-decided':
      return `${item.payload.tool} · ${item.payload.decision}`
    case 'run-finished':
      return item.payload.status
    case 'conversation-deleted':
      return clip(item.payload.title)
    default: {
      const exhaustive: never = item
      return exhaustive
    }
  }
}

// 导出文件名里的时间戳：YYYYMMDD-HHmm（本地时区，精确到分）
function toFileStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function toClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString()
}

interface AuditPanelProps {
  /** 当前打开的会话；审计只展示这个会话的事件 */
  conversationId: string
  /** 顶部只读范围提示 */
  conversationTitle: string
  /**
   * 刷新信号：外部在运行开始/结束、审批到达等「库已变化」的时刻递增它。
   * 审计读的是库（执行器写入），渲染层只能靠活动点通知重查；
   * 页面不自行订阅事件流（订阅归 hooks，组件只渲染）。
   */
  refreshToken: number
  /** 收起审计面板（收成右缘窄把手，状态记在 App） */
  onCollapse: () => void
}

/**
 * 审计面板：时间线展示执行器写下的每条事件，范围固定为当前会话。
 * 数据来自 app:audit-events（主进程只读查询）；refreshToken 变化或切换会话时重查，
 * 另外保留手动刷新按钮兜底。点击一条事件可展开完整 payload。
 */
export function AuditPanel({ conversationId, conversationTitle, refreshToken, onCollapse }: AuditPanelProps): JSX.Element {
  const [items, setItems] = useState<AuditEvent[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set())

  const refresh = useCallback((): void => {
    setIsLoading(true)
    void agentClient
      .listAuditEvents({ conversationId, limit: TIMELINE_LIMIT })
      .then(setItems)
      .finally(() => setIsLoading(false))
  }, [conversationId])

  // refreshToken 是「库变了」的信号（由 App 在运行/审批活动点递增）；切换会话也会重查
  useEffect(() => {
    refresh()
  }, [refresh, refreshToken])

  const toggleExpanded = useCallback((id: number): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 导出语义独立于展示：当前会话、按时间倒序的全部库内事件，上限 EXPORT_LIMIT（契约限额）。
  // 条数不与界面共享——界面是视口，将来分页/滚动加载只改展示，不进证据链。
  // 内容为数组原样序列化，不做加工。文件名：audit-<会话前 8 位>-<YYYYMMDD-HHmm>.json。
  const exportAuditJson = useCallback((): void => {
    setIsExporting(true)
    void agentClient
      .listAuditEvents({ conversationId, limit: EXPORT_LIMIT })
      .then((exportItems) => {
        if (exportItems.length === 0) return
        const scope = conversationId.slice(0, 8)
        const blob = new Blob([JSON.stringify(exportItems, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `audit-${scope}-${toFileStamp(new Date())}.json`
        anchor.click()
        // 推迟 revoke：click() 触发的下载异步读取 blob，立即 revoke 有截断为空文件的竞态。
        // 实测口径见 设计文档 更新.5-收口与审计导出.md（Chromium 156 下立即 revoke 一次未复现截断，此处为防御性推迟）。
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      })
      .finally(() => setIsExporting(false))
  }, [conversationId])

  return (
    <div className="audit">
      <div className="panel-head">
        <span>
          审计 <span className="audit-count">{items.length} 条</span>
        </span>
        <Tooltip title="收起审计">
          <Button size="small" type="text" icon={<RightOutlined />} onClick={onCollapse} />
        </Tooltip>
      </div>

      <div className="audit-toolbar">
        <span className="audit-scope" title={conversationId}>
          当前会话 · {conversationTitle || '未命名会话'}
        </span>
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<ReloadOutlined />} loading={isLoading} onClick={refresh} />
        </Tooltip>
        <Tooltip title="导出当前过滤范围为 JSON">
          <Button
            size="small"
            type="text"
            icon={<DownloadOutlined />}
            loading={isExporting}
            disabled={items.length === 0}
            onClick={exportAuditJson}
          />
        </Tooltip>
      </div>

      <div className="audit-list">
        {items.length === 0 ? (
          <div className="sessions-empty">当前会话还没有审计事件。发起一次运行后，每一步都会记在这里。</div>
        ) : (
          items.map((item) => {
            const label = LABELS[item.type] ?? { text: item.type, tone: 'default' as AuditTone }
            const isExpanded = expandedIds.has(item.id)
            const ref = item.runId ?? item.conversationId ?? null

            return (
              <div key={item.id} className="audit-item" onClick={() => toggleExpanded(item.id)}>
                <span className={`audit-dot ${label.tone}`} />
                <div className="audit-main">
                  <div className="audit-line">
                    <Tooltip title={new Date(item.createdAt).toLocaleString()}>
                      <time className="audit-time">{toClockTime(item.createdAt)}</time>
                    </Tooltip>
                    <span className={`audit-type ${label.tone}`}>{label.text}</span>
                    {ref ? (
                      <Tooltip title={ref}>
                        <span className="audit-ref">{ref.slice(0, 8)}</span>
                      </Tooltip>
                    ) : null}
                  </div>
                  <div className="audit-summary">{summarize(item)}</div>
                  {isExpanded ? <pre className="args">{JSON.stringify(item.payload ?? {}, null, 2)}</pre> : null}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
