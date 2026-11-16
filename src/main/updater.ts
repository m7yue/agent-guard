// 自动更新：把 electron-updater 包装成一个可控的状态机。
//
// 只在打包态启用：开发态没有 app-update.yml，检查更新没有意义。
// 更新源由环境变量注入（AGENTGUARD_UPDATE_URL），灰度由 cohort 决定：
// 客户端请求的是 <base>/<cohort>/latest-mac.yml，服务端按目录返回不同版本。
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Logger } from '../harness/logging/logger'
import type { UpdateStatus } from '../shared/update'

export interface CreateUpdaterOptions {
  /** 更新源根地址，例如 http://127.0.0.1:9999 */
  feedBaseUrl: string
  /** 灰度分组：stable / beta …，决定请求哪个子目录 */
  cohort: string
  log: Logger
  /** 状态变化时通知主进程（由它广播给窗口） */
  onStatus: (status: UpdateStatus) => void
}

export interface UpdaterController {
  /** 手动触发一次检查 */
  check(): void
  /** 下载已发现的版本 */
  download(): void
  /** 退出并安装 */
  install(): void
}

export function createUpdater(options: CreateUpdaterOptions): UpdaterController | null {
  // 开发态不启用：没有 app-update.yml，也没有"已安装版本"的概念
  if (!app.isPackaged) {
    options.log.info('开发态，跳过自动更新')
    return null
  }

  const feedUrl = `${options.feedBaseUrl}/${options.cohort}`
  options.log.info('启用自动更新', { feedUrl, cohort: options.cohort, version: app.getVersion() })

  autoUpdater.autoDownload = false // 先让用户看到"有新版本"，再决定下载
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })

  const emit = (status: UpdateStatus): void => {
    options.log.info('更新状态', status)
    options.onStatus(status)
  }

  autoUpdater.on('checking-for-update', () => emit({ phase: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    emit({ phase: 'available', version: info.version }),
  )
  autoUpdater.on('update-not-available', (info) =>
    emit({ phase: 'not-available', version: info.version }),
  )
  autoUpdater.on('download-progress', (progress) =>
    emit({ phase: 'downloading', percent: Math.round(progress.percent) }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    emit({ phase: 'downloaded', version: info.version }),
  )
  autoUpdater.on('error', (error) => emit({ phase: 'error', message: error.message }))

  return {
    check() {
      emit({ phase: 'checking' })
      void autoUpdater.checkForUpdates().catch((error: Error) => {
        emit({ phase: 'error', message: error.message })
      })
    },
    download() {
      void autoUpdater.downloadUpdate().catch((error: Error) => {
        emit({ phase: 'error', message: error.message })
      })
    },
    install() {
      // isSilent = false：走正常重启；isForceRunAfter = true：装完把应用拉起来
      autoUpdater.quitAndInstall(false, true)
    },
  }
}
