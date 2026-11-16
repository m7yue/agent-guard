import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { Effect, EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { withToolErrors } from './execute-tool'
import type { ToolContext } from './types'

const name = 'run_command' as const
const effectType = 'RunCommand' as const

export interface RunCommandEffect
  extends Effect<typeof effectType, Record<string, unknown>, string> {}

const Args = z
  .object({
    command: z.string().min(1),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
  })
  .strict()

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_OUTPUT = 20_000

const definition: ToolDefinition = {
  name,
  description:
    '在工作区目录下执行一条 shell 命令，返回退出码、stdout 与 stderr（各截断到 20000 字符）。默认超时 10 秒。',
  parameters: z.toJSONSchema(Args) as Record<string, unknown>,
}

export const runCommandTool = {
  name,
  effectType,
  definition,
  createHandler: (ctx: ToolContext): EffectHandler<RunCommandEffect> =>
    withToolErrors(name, async (input) => {
      const args = Args.parse(input)

      return new Promise<string>((resolve, reject) => {
        const child = spawn(args.command, {
          shell: true,
          cwd: ctx.workspaceRoot,
          timeout: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })

        let stdout = ''
        let stderr = ''

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8')
        })

        child.on('error', reject)
        child.on('close', (code) => {
          resolve(
            JSON.stringify({
              code,
              stdout: stdout.slice(0, MAX_OUTPUT),
              stderr: stderr.slice(0, MAX_OUTPUT),
            }),
          )
        })
      })
    }),
} as const
