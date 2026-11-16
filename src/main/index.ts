// 主进程入口：只做生命周期与装配，具体职责在各模块里。
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { registerAppProtocol } from './app-protocol'
import { createApprovalRegistry } from './approval-registry'
import { createAgentProcessClient } from './agent-process-client'
import { broadcastToWindows, forwardAgentEvents, registerIpcHandlers } from './ipc'
import { writeCrashReport } from '../harness/logging/crash-report'
import { configureLogging, getLogger } from '../harness/logging/logger'
import { UPDATE_CHANNEL } from '../shared/update'
import { bootstrapStore, databaseFile, openReadStore } from '../harness/store'
import { buildReport, mark, writeReport } from './perf'
import { createTray, type TrayController } from './tray'
import { createUpdater } from './updater'
import { createWindow, showWindow } from './window'

const INSECURE = process.env.AGENTGUARD_INSECURE === '1'

// 诊断开关：打包后的二进制会拒绝 --remote-debugging-port 这类命令行开关，
// 需要调 CDP 时改用环境变量注入（正常使用不设置）。
const DEBUG_PORT = process.env.AGENTGUARD_DEBUG_PORT
if (DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', DEBUG_PORT)

// --perf：加载完成后静置 5 秒，采集一次指标、写报告、退出（给 scripts/perf.cjs 用）
const PERF_MODE = process.argv.includes('--perf')
// 加载完成后静置多久再采集：与报告里的 measurement.idleMs 用同一个常量，避免两处不一致
const PERF_IDLE_MS = 5000
mark('process-start')

// 开发态 Electron 的 bundle 名是 Electron.app，系统菜单/Dock 会显示 Electron；
// 显式设置应用名，至少让 app.getName() 与部分系统 UI 用上产品名（打包后由 productName 决定）。
app.setName('AgentGuard')

// 工作区路径：
// - 显式覆盖优先（AGENTGUARD_WORKSPACE）
// - 开发态放项目根的 .workspace/：方便直接查看产物，且已在 .gitignore 里
// - 打包后放 userData：应用目录（asar）是只读的，不能往安装目录写
// 状态目录：会话与运行记录（与工作区分离，Agent 不应碰它）。
// 开发态放项目根便于查看与清理；打包后应用目录只读，只能落 userData。
function resolveStateDir(): string {
  const override = process.env.AGENTGUARD_STATE_DIR
  // 打包后应用目录（app.asar）只读，状态必须落 userData；
  // 用 dev Electron 直接加载 app.asar 时 isPackaged 仍是 false，所以把 asar 也算作打包形态
  const packaged = app.isPackaged || app.getAppPath().endsWith('app.asar')
  const dir = override ?? (packaged
    ? path.join(app.getPath('userData'), 'state')
    : path.join(app.getAppPath(), '.state'))
  mkdirSync(dir, { recursive: true })
  return dir
}

let quitting = false
let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  showWindow(mainWindow)
}

app.whenReady().then(() => {
  registerAppProtocol()

  mark('app-ready')

  const stateDir = resolveStateDir()

  // 日志目录：诊断材料（app-YYYY-MM-DD.log 与 crash-*.json）都落在这里
  const logsDir = path.join(stateDir, 'logs')
  configureLogging(logsDir)
  const log = getLogger('main')
  log.info('应用启动', { version: app.getVersion(), packaged: app.isPackaged })

  // 主进程崩溃：先把日志与崩溃报告写下来，再提示用户
  process.on('uncaughtException', (error) => {
    log.error('uncaughtException', { message: error.message, stack: error.stack })
    const file = writeCrashReport({ error, dir: logsDir, context: { stateDir } })
    dialog.showErrorBox(
      'AgentGuard 遇到问题',
      `${error.message}\n\n诊断信息已保存：${file ?? '写入失败'}`,
    )
    app.exit(1)
  })
  // 未处理的 Promise 拒绝：不致命，但必须留痕
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { reason: String(reason) })
  })
  // 引导期：建库/迁移 + 修复上次中断的运行。这是主进程唯一一次写，显式独立成一步。
  const repaired = bootstrapStore(databaseFile(stateDir))
  if (repaired > 0) log.warn('引导期修复了中断的运行', { count: repaired })

  // 长期持有的只读视图：没有写方法，连接上也开了 query_only
  const conversationStore = openReadStore(databaseFile(stateDir))

  // 自动更新：只有配置了更新源才启用；cohort 决定请求哪个灰度的 feed
  const updateBaseUrl = process.env.AGENTGUARD_UPDATE_URL
  const updater = updateBaseUrl
    ? createUpdater({
        feedBaseUrl: updateBaseUrl,
        cohort: process.env.AGENTGUARD_UPDATE_COHORT ?? 'stable',
        log: getLogger('updater'),
        onStatus: (status) => broadcastToWindows(UPDATE_CHANNEL, status),
      })
    : null

  const agentProcessClient = createAgentProcessClient({
    stateDir,
    logger: getLogger('executor-client'),
  })
  const approvalRegistry = createApprovalRegistry()

  // 待审批数量变化：更新托盘；窗口不可见时用 Dock 角标 + 跳动提醒（不强行弹窗）。
  // 不用系统通知：开发态未签名的 Electron 会被 macOS 拒绝（UNErrorDomain 1）。
  let lastPending = 0
  const onPendingChange = (count: number): void => {
    tray?.setPendingCount(count)

    const windowHidden =
      !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || !mainWindow.isFocused()

    if (process.platform === 'darwin' && app.dock) {
      app.dock.setBadge(count > 0 ? String(count) : '')
      if (count > lastPending && windowHidden) {
        app.dock.bounce('informational')
        console.log(`[dock] 角标 ${count}，并在 Dock 上跳动提醒`)
      }
    }

    lastPending = count
  }

  registerIpcHandlers({
    agentProcessClient,
    approvalRegistry,
    conversationStore,
    updater,
    onPendingChange,
    // updater 为 null 的原因要到达界面：否则"检查更新"是死按钮（用户动作必须有可见结果）
    updateUnavailableMessage: updater
      ? null
      : app.isPackaged
        ? '未配置更新源（AGENTGUARD_UPDATE_URL），自动更新未启用'
        : '开发态不启用自动更新（打包产物启用）',
  })
  forwardAgentEvents(agentProcessClient, approvalRegistry, onPendingChange)

  mainWindow = createWindow({ insecure: INSECURE, backgroundThrottling: !PERF_MODE })
  mark('window-created')

  mainWindow.once('ready-to-show', () => mark('ready-to-show'))

  // 启动后自动检查一次更新（仅打包态且配置了更新源）
  if (updater) setTimeout(() => updater.check(), 3000)
  mainWindow.webContents.once('did-finish-load', () => {
    mark('did-finish-load')
    // 静置 5 秒：等首帧、首屏异步任务与内存分配稳定，再采集
    if (PERF_MODE) setTimeout(() => finishPerf(stateDir), PERF_IDLE_MS)
  })

  // 关窗 = 收进托盘，不退出；真正退出走托盘菜单或 Cmd+Q
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
    console.log('[window] 已拦截关闭，窗口收进托盘')
  })

  try {
    tray = createTray({
      onShowWindow: showMainWindow,
      onOpenLogs: () => void shell.openPath(logsDir),
      onCopyDiagnostics: () =>
        clipboard.writeText(
          [
            `AgentGuard ${app.getVersion()}`,
            `electron ${process.versions.electron}`,
            `node ${process.versions.node}`,
            `platform ${process.platform} ${process.arch}`,
            `state ${stateDir}`,
            `logs ${logsDir}`,
          ].join('\n'),
        ),
      onQuit: () => {
        quitting = true
        app.quit()
      },
    })
  } catch (error) {
    // 托盘建不起来就只影响"常驻"，不该拖垮整个应用
    console.error('[tray] 创建失败:', error)
  }

  // macOS：点 dock 图标且没有窗口时，重新开一个；否则把现有窗口叫出来
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // 重新创建的窗口不参与启动时间线：打点只属于第一次启动
      mainWindow = createWindow({ insecure: INSECURE, backgroundThrottling: !PERF_MODE })
    } else {
      showMainWindow()
    }
  })

  // 性能模式：写报告、打摘要、退出
  function finishPerf(perfStateDir: string): void {
    const report = buildReport(path.join(app.getAppPath(), 'out'), {
      idleMs: PERF_IDLE_MS,
      backgroundThrottling: !PERF_MODE,
      devToolsOpen: mainWindow?.webContents.isDevToolsOpened() ?? false,
      userDataDir: app.getPath('userData'),
    })
    const file = writeReport(path.join(perfStateDir, 'perf'), report)
    console.log(`[perf] 报告已写入 ${file}`)
    app.quit()
  }

  // 退出时结束执行器，避免留下孤儿进程
  app.on('will-quit', () => {
    agentProcessClient.dispose()
    conversationStore.close()
  })
})

app.on('before-quit', () => {
  quitting = true
})

// 有托盘常驻，窗口全关也不退出
app.on('window-all-closed', () => {})
