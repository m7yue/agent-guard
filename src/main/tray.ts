// 托盘：让应用在窗口关掉之后仍然活着，并作为"有审批待处理"的提示位。
import { app, Menu, Tray, nativeImage } from 'electron'
import path from 'node:path'

export interface TrayController {
  /** 有待审批请求时更新提示（托盘 tooltip） */
  setPendingCount(count: number): void
  destroy(): void
}

export interface CreateTrayOptions {
  onShowWindow: () => void
  onQuit: () => void
  /** 打开日志目录（便于用户把日志发回来） */
  onOpenLogs: () => void
  /** 复制诊断信息到剪贴板 */
  onCopyDiagnostics: () => void
}

export function createTray(options: CreateTrayOptions): TrayController {
  // 图标放在 resources/，开发态即项目根；打包后随 asar 一起走
  const iconPath = path.join(app.getAppPath(), 'resources', 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.error('[tray] 图标加载失败:', iconPath, '| app.getName() =', app.getName())
  }

  const tray = new Tray(icon)

  tray.setToolTip('AgentGuard')
  console.log(
    `[tray] 已创建图标 tooltip="AgentGuard" iconEmpty=${icon.isEmpty()} bounds=${JSON.stringify(tray.getBounds())}`,
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: options.onShowWindow },
      { type: 'separator' },
      { label: '打开日志目录', click: options.onOpenLogs },
      { label: '复制诊断信息', click: options.onCopyDiagnostics },
      { type: 'separator' },
      { label: '退出 AgentGuard', click: options.onQuit },
    ]),
  )

  // macOS 左键点击图标：直接显示窗口
  tray.on('click', options.onShowWindow)

  return {
    setPendingCount(count) {
      console.log(`[tray] 待审批 ${count} 条`)
      tray.setToolTip(count > 0 ? `AgentGuard · ${count} 条审批待处理` : 'AgentGuard')
      // macOS 的 tooltip 不一定可靠，用标题在菜单栏直接显示数字
      if (process.platform === 'darwin') tray.setTitle(count > 0 ? ` ${count}` : '')
    },
    destroy() {
      tray.destroy()
    },
  }
}
