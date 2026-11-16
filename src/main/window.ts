// 窗口创建与导航守卫。
import { BrowserWindow, type WebPreferences } from 'electron'
import path from 'node:path'
import { APP_ORIGIN } from './app-protocol'

export interface CreateWindowOptions {
  insecure: boolean
  /**
   * 是否允许 Chromium 节流不可见窗口（默认应传 true）。
   * 只有 --perf 采集首帧时才传 false：被遮挡窗口的 rAF 会被节流，导致测不到首帧。
   * 这是测量开关，不是产品开关——正常运行时保持节流以省电。
   */
  backgroundThrottling: boolean
}

// 三个开关是一组：nodeIntegration 决定页面能不能 require，contextIsolation 决定两个 JS 世界，
// sandbox 决定渲染进程有没有被 Chromium 关进系统沙箱。
function webPreferences(options: CreateWindowOptions): WebPreferences {
  const preload = path.join(__dirname, '..', 'preload', 'preload.js')
  const insecure = options.insecure
  const base = { backgroundThrottling: options.backgroundThrottling }

  if (insecure) {
    return { preload, nodeIntegration: true, contextIsolation: false, sandbox: false, ...base }
  }
  return { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, ...base }
}

export function createWindow(options: CreateWindowOptions): BrowserWindow {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const devOrigin = devUrl ? new URL(devUrl).origin : null

  const win = new BrowserWindow({
    width: 1040,
    height: 860,
    // 先不显示：等 ready-to-show 后最大化再显示，避免启动时先闪一下小窗口。
    show: false,
    title: `${options.insecure ? 'INSECURE' : 'SECURE'} · AgentGuard`,
    webPreferences: webPreferences(options),
  })

  // 默认以最大化窗口打开（对齐桌面聊天客户端的初始形态）。
  // 同一次会话内用户手动调整后不再强制；重启仍按默认最大化打开。
  win.once('ready-to-show', () => {
    win.maximize()
    win.show()
  })

  // 只允许停留在自己的源（生产是 app://，开发是本地 dev server）
  const allowed = (url: string): boolean =>
    url.startsWith(APP_ORIGIN) || (devOrigin !== null && url.startsWith(devOrigin))

  win.webContents.on('will-navigate', (event, url) => {
    if (!allowed(url)) {
      event.preventDefault()
      console.log('[guard] 已拦截导航:', url)
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[guard] 已拦截新窗口:', url)
    return { action: 'deny' }
  })

  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadURL(`${APP_ORIGIN}/index.html`)
  }

  return win
}

// 从托盘/其他入口把窗口叫回前台
export function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
