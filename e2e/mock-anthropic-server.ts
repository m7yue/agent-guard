// e2e 专用的本地 Anthropic 兼容端点：按脚本顺序返回 SSE 流。
//
// 为什么不用 ScriptedModel 直接注入：GUI 形态下模型在执行器（utility 进程）里创建，
// 测试进程摸不到那个对象；而模型层本来就支持用 AGENTGUARD_MODEL_BASE_URL 指向任意
// Anthropic 兼容端点。起一个本地 HTTP 服务、按协议回放脚本，产品代码零改动。
//
// 协议依据：Anthropic Messages API 的流式响应（message_start / content_block_* /
// message_delta / message_stop），与 src/harness/model/anthropic-model.ts 消费的方式一致。
import http from 'node:http'

/** 一个回放回合：发起工具调用 / 最终文本 / 延迟后的最终文本（测取消与超时链路） */
export type MockTurn =
  | { kind: 'toolUse'; tool: string; args: Record<string, unknown>; text?: string }
  | { kind: 'final'; text: string }
  | { kind: 'delay'; text: string; delayMs: number }

export interface MockAnthropicServer {
  /** 端点地址（给 AGENTGUARD_MODEL_BASE_URL；SDK 会自行追加 /v1/messages） */
  baseUrl: string
  /** 设置接下来依次返回的回合；每次模型请求消费一个 */
  setScript: (turns: MockTurn[]) => void
  close: () => Promise<void>
}

function sseChunk(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 把一个回合渲染成完整的 SSE 响应体 */
function renderTurn(turn: MockTurn, toolUseId: string): string {
  const head = sseChunk('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      model: 'e2e-mock',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })

  const blocks: string[] = []
  let stopReason = 'end_turn'

  const leadText = turn.kind === 'toolUse' ? turn.text : turn.text
  if (leadText) {
    blocks.push(
      sseChunk('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sseChunk('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: leadText },
      }),
      sseChunk('content_block_stop', { type: 'content_block_stop', index: 0 }),
    )
  }

  if (turn.kind === 'toolUse') {
    const index = leadText ? 1 : 0
    blocks.push(
      sseChunk('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: toolUseId, name: turn.tool, input: {} },
      }),
      sseChunk('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.args) },
      }),
      sseChunk('content_block_stop', { type: 'content_block_stop', index }),
    )
    stopReason = 'tool_use'
  }

  const tail = sseChunk('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 20 },
  }) + sseChunk('message_stop', { type: 'message_stop' })

  return head + blocks.join('') + tail
}

export function startMockAnthropicServer(): Promise<MockAnthropicServer> {
  let script: MockTurn[] = []
  let toolUseSeq = 0

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.includes('/messages')) {
      response.statusCode = 404
      response.end('mock: 只实现 Messages 端点')
      return
    }

    // 吞掉请求体；脚本不依赖对话内容（回合顺序由测试决定）
    request.resume()
    request.on('end', () => {
      const turn = script.shift()
      if (!turn) {
        // 脚本耗尽按服务端错误返回：走的是 SDK 抛错 → run failed 的真实链路
        response.statusCode = 500
        response.end('mock: 脚本已耗尽')
        return
      }

      // 延迟回合：先挂住不回，到点再给最终文本。客户端中止（用户点停止）时
      // 连接关闭，定时器作废——不 unref 的话 server.close() 会被它拖住不退出
      if (turn.kind === 'delay') {
        const timer = setTimeout(() => {
          toolUseSeq += 1
          response.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          })
          response.end(renderTurn({ kind: 'final', text: turn.text }, `tu-e2e-${toolUseSeq}`))
        }, turn.delayMs)
        timer.unref()
        response.on('close', () => clearTimeout(timer))
        return
      }

      toolUseSeq += 1
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      response.end(renderTurn(turn, `tu-e2e-${toolUseSeq}`))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('mock: 未拿到端口')
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        setScript: (turns) => {
          script = [...turns]
        },
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
