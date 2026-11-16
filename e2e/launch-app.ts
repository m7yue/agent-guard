// e2e / 渲染性能共用的应用启动器：Playwright _electron 指向生产构建（out/），
// 独立 user-data-dir 与工作区，环境变量全部指向测试形态。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as playwrightElectron, type ElectronApplication, type Page } from 'playwright'

const requireFromE2e = createRequire(import.meta.url)
const electronExecutablePath = requireFromE2e('electron') as unknown as string
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface LaunchedAppGuard {
  app: ElectronApplication
  page: Page
  /** 本次运行的工作区根目录（write_file 的落点，断言用） */
  workspaceRoot: string
  /** 本次运行的状态目录（会话库等；重启恢复场景复用它） */
  stateDir: string
  /** 首屏就绪：工作台 Segmented 出现 */
  waitUntilWorkbenchReady: () => Promise<void>
  close: () => Promise<void>
}

export interface LaunchAppGuardOptions {
  /** Anthropic 兼容端点（mock server）；不传则走零配置的演示模型 */
  modelBaseUrl?: string
  /** 复用上一次运行的数据目录（工作区 + 状态库）：重启恢复类场景用 */
  dirs?: { workspaceRoot: string; stateDir: string }
  /** 关闭时不删运行目录：配合 dirs 把同一份数据喂给下一次 launch */
  preserveData?: boolean
}

/**
 * cwd 特意放在临时目录：config.ts 的 loadEnvOnce 会读 cwd 下的 .env，
 * 开发机的 .env 里可能有真实模型配置，会盖掉测试注入的环境变量。
 */
export async function launchAppGuard(options: LaunchAppGuardOptions = {}): Promise<LaunchedAppGuard> {
  const runRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agentguard-e2e-'))
  const workspaceRoot = options.dirs?.workspaceRoot ?? path.join(runRoot, 'workspace')
  const stateDir = options.dirs?.stateDir ?? path.join(runRoot, 'state')
  await fs.promises.mkdir(workspaceRoot, { recursive: true })

  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENTGUARD_WORKSPACE: workspaceRoot,
    AGENTGUARD_STATE_DIR: stateDir,
    // 检索与记忆全部走确定性 fake，e2e 不依赖任何外部 key
    AGENTGUARD_EMBEDDING_PROVIDER: 'fake',
    AGENTGUARD_RERANK_PROVIDER: 'off',
  }
  if (options.modelBaseUrl) {
    env.AGENTGUARD_MODEL_BASE_URL = options.modelBaseUrl
    env.AGENTGUARD_MODEL_API_KEY = 'e2e-mock-key'
    env.AGENTGUARD_MODEL_ID = 'e2e-mock-model'
  }
  // 环境坑：不清掉它 ipcMain 是 undefined，窗口根本起不来
  delete env.ELECTRON_RUN_AS_NODE

  const app = await playwrightElectron.launch({
    executablePath: electronExecutablePath,
    args: [repoRoot],
    cwd: runRoot,
    env: env as Record<string, string>,
  })

  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)

  return {
    app,
    page,
    workspaceRoot,
    stateDir,
    waitUntilWorkbenchReady: async () => {
      await page.getByText('工作台', { exact: true }).first().waitFor()
    },
    close: async () => {
      await app.close()
      // preserveData：留着 runRoot 给下一次 launch 复用（重启恢复场景）
      if (!options.preserveData) {
        await fs.promises.rm(runRoot, { recursive: true, force: true })
      }
    },
  }
}

export { repoRoot }
