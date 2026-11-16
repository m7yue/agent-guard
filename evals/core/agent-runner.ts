// AgentRunner 的正式实现：每个 trial 起一个子进程，父进程只负责超时与读结果。
//
// 子进程入口是 evals/agent-child.ts；这里不关心里面用的是真实模型还是脚本模型。
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readTraceEvents } from './trace'
import type { AgentRunInput, AgentRunResult, AgentRunner, ModelTraceEvent } from './types'

const execFileAsync = promisify(execFile)
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AGENT_CHILD_PATH = join(PROJECT_ROOT, 'evals', 'core', 'agent-child.ts')
/** 子进程 stdout/stderr 读取上限；agent 日志也从这里过。 */
const MAX_OUTPUT = 8 * 1024 * 1024

export class HarnessAgentRunner implements AgentRunner {
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    // prompt / result / trace 放在独立 IO 目录，不写进 workspace：
    // workspace 是 agent 的现场，检查器会按 fixture 比对文件，不能被评测文件污染。
    const trialFilesDir = await mkdtemp(join(tmpdir(), 'agentguard-eval-io-'))
    const promptFile = join(trialFilesDir, 'prompt.txt')
    const resultFile = join(trialFilesDir, 'result.json')
    const traceFile = join(trialFilesDir, 'trace.jsonl')
    await writeFile(promptFile, input.prompt, 'utf8')

    const args = [
      '--import',
      'tsx',
      AGENT_CHILD_PATH,
      '--task-id',
      input.taskId,
      '--workspace',
      input.workspace,
      '--outside',
      input.outside,
      '--prompt-file',
      promptFile,
      '--mode',
      input.mode,
      '--result-file',
      resultFile,
      '--trace-file',
      traceFile,
      '--max-turns',
      String(input.maxTurns),
    ]
    if (input.mode === 'mock') args.push('--script', input.script ?? 'correct')

    // mock 模式显式覆盖 .env，避免本地配置让评测意外触网
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (input.mode === 'mock') {
      env.EVAL_OFFLINE = '1'
      env.AGENTGUARD_EMBEDDING_PROVIDER = 'fake'
    }

    const startedAt = performance.now()
    try {
      await execFileAsync(process.execPath, args, {
        cwd: PROJECT_ROOT,
        timeout: input.timeoutMs,
        maxBuffer: MAX_OUTPUT,
        env,
      })
      const raw = JSON.parse(await readFile(resultFile, 'utf8')) as AgentRunResult
      return {
        ...raw,
        trace: readTraceEvents(traceFile),
        // 延迟按父进程 wall-clock 算，包含子进程启动与 tsx 解析
        durationMs: performance.now() - startedAt,
      }
    } catch (error) {
      const trace = readTraceEvents(traceFile)
      const failure = error as { killed?: boolean; signal?: string; message?: string }
      const timedOut = failure.killed === true || failure.signal === 'SIGTERM'
      return {
        status: timedOut ? 'timeout' : 'error',
        finalAnswer: '',
        tokens: null,
        durationMs: performance.now() - startedAt,
        truncated: trace.some(
          (event): event is ModelTraceEvent =>
            event.type === 'model' && event.stopReason === 'max_tokens',
        ),
        trace,
        error: failure.message ?? String(error),
      }
    } finally {
      if (input.keepIo) {
        input.onIoKept?.(trialFilesDir)
      } else {
        await rm(trialFilesDir, { recursive: true, force: true })
      }
    }
  }
}
