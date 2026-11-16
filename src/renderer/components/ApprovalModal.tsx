import type { JSX } from 'react'
import { Button, ConfigProvider, Modal } from 'antd'
import type { ApprovalDecision, ApprovalRequestPayload } from '../../shared/approval'

interface ApprovalModalProps {
  request: ApprovalRequestPayload | null
  onDecide: (decision: ApprovalDecision) => void
}

/**
 * 危险操作必须由人点头；默认三个选项对应"一次 / 本会话 / 拒绝"。
 * write_memory 例外：不提供"本会话允许"——一次授权会让后续所有记忆写入静默通过，
 * 与"每次写入都先看见"的产品约定冲突（执行器侧也有同样的守卫）。
 * 局部主题把主色换成 signal（#C2410C）——全站唯一强调色留给「需要人决定」的时刻。
 */
export function ApprovalModal({ request, onDecide }: ApprovalModalProps): JSX.Element {
  const isMemoryWrite = request?.tool === 'write_memory'
  const memoryArgs = isMemoryWrite ? (request.args as Record<string, unknown>) : null

  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#C2410C' } }}>
      <Modal
        open={request !== null}
        title="需要你的批准"
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={[
          <Button key="deny" danger onClick={() => onDecide('deny')}>
            拒绝
          </Button>,
          isMemoryWrite ? null : (
            <Button key="session" onClick={() => onDecide('session')}>
              本会话允许
            </Button>
          ),
          <Button key="once" type="primary" onClick={() => onDecide('once')}>
            允许一次
          </Button>,
        ]}
      >
        {request ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="approval-reason">{request.reason}</div>
            <div className="approval-fact">
              工具
              <code>{request.tool}</code>
            </div>
            <div className="approval-fact">
              运行
              <code>{request.runId}</code>
            </div>
            {memoryArgs ? (
              <>
                <div className="approval-fact">
                  记忆
                  <code>{String(memoryArgs.name ?? '')}</code>
                </div>
                <div className="approval-fact">
                  类型
                  <code>{String(memoryArgs.type ?? '')}</code>
                </div>
                <div className="approval-fact">
                  描述
                  <span>{String(memoryArgs.description ?? '')}</span>
                </div>
                <pre className="args">{String(memoryArgs.body ?? '')}</pre>
              </>
            ) : (
              <pre className="args">{JSON.stringify(request.args, null, 2)}</pre>
            )}
          </div>
        ) : null}
      </Modal>
    </ConfigProvider>
  )
}
