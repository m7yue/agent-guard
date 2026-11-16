import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { resolveInWorkspace, toWorkspacePath } from '../workspace'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'read_file' as const
const effectType = 'ReadFile' as const

export interface ReadFileEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    path: z.string().min(1),
    maxBytes: z.number().int().min(1).max(200_000).optional(),
  })
  .strict()

const definition: ToolDefinition = {
  name,
  description:
    '读取工作区内的文本文件，返回行数、字节数与内容。默认最多返回 20000 字符，超出会截断并标记。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const readFileTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<ReadFileEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)
      const abs = resolveInWorkspace(ctx.workspaceRoot, args.path)
      const stat = await fs.stat(abs)
      if (!stat.isFile()) throw new Error(`不是文件：${args.path}`)

      const limit = args.maxBytes ?? 20_000
      const text = await fs.readFile(abs, 'utf8')
      const truncated = text.length > limit

      return JSON.stringify({
        path: toWorkspacePath(ctx.workspaceRoot, abs),
        bytes: stat.size,
        lines: text.split('\n').length,
        truncated,
        content: truncated ? text.slice(0, limit) : text,
      })
    }),
} as const
