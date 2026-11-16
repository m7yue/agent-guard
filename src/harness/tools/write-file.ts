import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { resolveInWorkspace, toWorkspacePath } from '../workspace'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'write_file' as const
const effectType = 'WriteFile' as const

export interface WriteFileEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    path: z.string().min(1),
    content: z.string().max(200_000),
  })
  .strict()

const definition: ToolDefinition = {
  name,
  description: '把文本写入工作区内的文件（覆盖）。父目录不存在会自动创建。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const writeFileTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<WriteFileEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)
      const abs = resolveInWorkspace(ctx.workspaceRoot, args.path)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, args.content, 'utf8')

      return JSON.stringify({
        path: toWorkspacePath(ctx.workspaceRoot, abs),
        bytes: Buffer.byteLength(args.content, 'utf8'),
      })
    }),
} as const
