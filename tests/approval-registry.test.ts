import { describe, expect, it } from 'vitest'
import { createApprovalRegistry } from '../src/main/approval-registry'
import type { ApprovalRequestPayload } from '../src/shared/approval'

function request(requestId: string): ApprovalRequestPayload {
  return { requestId, runId: 'run-1', tool: 'write_file', args: { path: 'a.txt' }, reason: '写入文件' }
}

describe('待审批登记表', () => {
  it('add / list / size', () => {
    const registry = createApprovalRegistry()
    registry.add(request('ap-1'))
    registry.add(request('ap-2'))

    expect(registry.list().map((item) => item.requestId)).toEqual(['ap-1', 'ap-2'])
    expect(registry.size()).toBe(2)
  })

  it('take 取出并移除；重复取出返回 null', () => {
    const registry = createApprovalRegistry()
    registry.add(request('ap-1'))

    expect(registry.take('ap-1')?.requestId).toBe('ap-1')
    expect(registry.take('ap-1')).toBeNull()
    expect(registry.size()).toBe(0)
  })

  it('同 id 重复登记只保留一份', () => {
    const registry = createApprovalRegistry()
    registry.add(request('ap-1'))
    registry.add(request('ap-1'))

    expect(registry.size()).toBe(1)
  })
})
