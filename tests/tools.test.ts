import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConversationSearchOutcome } from '../src/harness/knowledge/searcher'
import { NO_MEMORY } from '../src/harness/memory/runtime'
import { checkPermission } from '../src/harness/permission'
import { toToolErrorMessage } from '../src/harness/tools/execute-tool'
import { toolDefinitions } from '../src/harness/tools/manifest'
import { readFileTool } from '../src/harness/tools/read-file'
import { searchConversationsTool } from '../src/harness/tools/search-conversations'
import type { ToolContext } from '../src/harness/tools/types'
import { writeFileTool } from '../src/harness/tools/write-file'

let root = ''

// search_conversations 的执行体由执行器注入；工具测试给一个可编程的桩
const searchStub = async (): Promise<ConversationSearchOutcome> => ({
  mode: 'vector',
  hits: [
    {
      conversationId: 'c1',
      title: 'favicon 讨论',
      chunkIndex: 3,
      text: '用户：favicon 方案用 svg',
      score: 0.8123,
    },
  ],
  rerank: null,
})

function toolContext(workspaceRoot: string): ToolContext {
  return {
    workspaceRoot,
    searchConversationHistory: searchStub,
    memory: NO_MEMORY,
  }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agentguard-tools-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('工具定义与执行', () => {
  it('read_file 读取工作区内文件', async () => {
    await writeFile(path.join(root, 'a.txt'), 'hello', 'utf8')
    const handler = readFileTool.createHandler(toolContext(root))
    const raw = await handler({ type: 'ReadFile', input: { path: 'a.txt' } })
    const parsed = JSON.parse(raw) as { content: string; lines: number }
    expect(parsed.content).toBe('hello')
    expect(parsed.lines).toBe(1)
  })

  it('越界路径被拒绝', async () => {
    const handler = readFileTool.createHandler(toolContext(root))
    await expect(
      handler({ type: 'ReadFile', input: { path: '../x' } }),
    ).rejects.toThrow(/越界/)
  })

  it('write_file 写入并自动创建父目录', async () => {
    const handler = writeFileTool.createHandler(toolContext(root))
    await handler({ type: 'WriteFile', input: { path: 'sub/b.txt', content: 'x' } })
    expect(await readFile(path.join(root, 'sub/b.txt'), 'utf8')).toBe('x')
  })

  it('入参不合法被 zod 拒绝', async () => {
    const handler = readFileTool.createHandler(toolContext(root))
    await expect(handler({ type: 'ReadFile', input: {} })).rejects.toThrow(/入参不合法/)
  })

  it('search_conversations 返回带来源的命中', async () => {
    const handler = searchConversationsTool.createHandler(toolContext(root))
    const raw = await handler({
      type: 'SearchConversations',
      input: { query: '上次 favicon 用了什么方案', topK: 3 },
    })
    const parsed = JSON.parse(raw) as {
      mode: string
      hits: Array<{ source: string; conversationId: string; score: number; text: string }>
    }
    expect(parsed.mode).toBe('vector')
    expect(parsed.hits[0].source).toBe('favicon 讨论#3')
    expect(parsed.hits[0].conversationId).toBe('c1')
    expect(parsed.hits[0].text).toContain('favicon')
  })

  it('search_conversations 的 topK 越界被拒', async () => {
    const handler = searchConversationsTool.createHandler(toolContext(root))
    await expect(
      handler({ type: 'SearchConversations', input: { query: 'x', topK: 0 } }),
    ).rejects.toThrow(/入参不合法/)
    await expect(
      handler({ type: 'SearchConversations', input: { query: 'x', extra: 1 } }),
    ).rejects.toThrow(/入参不合法/)
  })

  it('权限管线：只读放行，写入与命令要审批', () => {
    const root = '/tmp/agentguard-ws'
    expect(checkPermission('read_file', { path: 'a.txt' }, root).decision).toBe('allow')
    expect(checkPermission('search_conversations', { query: '上次聊了什么' }, root).decision).toBe('allow')
    expect(checkPermission('write_file', { path: 'a.txt' }, root).decision).toBe('ask')
    expect(checkPermission('run_command', { command: 'ls' }, root).decision).toBe('ask')
  })

  it('权限管线：硬拒绝、越界、未知工具一律拒绝', () => {
    const root = '/tmp/agentguard-ws'
    expect(checkPermission('run_command', { command: 'sudo rm -rf /' }, root).decision).toBe('deny')
    expect(checkPermission('write_file', { path: '../escape.txt' }, root).decision).toBe('deny')
    expect(checkPermission('read_file', { path: '/etc/passwd' }, root).decision).toBe('deny')
    expect(checkPermission('mystery_tool', {}, root).decision).toBe('deny')
  })

  it('每个工具都带 JSON Schema', () => {
    for (const definition of toolDefinitions()) {
      expect(definition.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('search_conversations 已在定义表登记', () => {
    expect(toolDefinitions().map((definition) => definition.name)).toContain('search_conversations')
  })

  it('工具错误消息压成单行并截断', () => {
    expect(toToolErrorMessage(new Error('文件\n不存在'))).toBe('文件 不存在')
    expect(toToolErrorMessage(new Error('x'.repeat(600))).length).toBe(501)
  })
})
