import type { JSX } from 'react'
import { useState } from 'react'

interface LogDrawerProps {
  lines: string[]
  /** 调试信息（页面标题、协议、模型模式）：属于排障材料，放进抽屉而不是产品头部 */
  meta: string
}

/**
 * 底部运行日志：默认收成一条 28px 的状态条，点开从底部展开抽屉。
 * 日志是开发/排障材料，不应长期占据产品界面（会话检索 前的黑底 pre 横亘全宽）。
 */
export function LogDrawer({ lines, meta }: LogDrawerProps): JSX.Element {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <div className="log-bar" onClick={() => setIsOpen((prev) => !prev)}>
        <span>{isOpen ? '▾' : '▸'} 运行日志</span>
        <span>{lines.length} 条</span>
        <span className="log-meta">{meta}</span>
      </div>

      <div className={`log-drawer${isOpen ? ' open' : ''}`}>
        <pre>{lines.length === 0 ? '（暂无日志）' : lines.join('\n')}</pre>
      </div>
    </>
  )
}
