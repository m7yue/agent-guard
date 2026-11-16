// 自定义协议：生产形态下页面从 app://agentguard/ 加载，而不是 file://。
// 换成受限的源之后，CSP 的 'self' 才有意义。
import { protocol, net } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEME = 'app'
const HOST = 'agentguard'

// 构建产物在 out/，本文件编译到 out/main/，所以页面目录是 ../renderer
const ROOT = path.join(__dirname, '..', 'renderer')

// 必须在 app ready 之前调用
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
])

// 把 URL 路径解析成磁盘路径，并保证它不会逃出 ROOT
function resolveInsideRoot(urlPathname: string): string | null {
  const decoded = decodeURIComponent(urlPathname)
  const target = path.normalize(path.join(ROOT, decoded === '/' ? '/index.html' : decoded))
  return target.startsWith(ROOT + path.sep) ? target : null
}

export function registerAppProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    const { host, pathname } = new URL(request.url)
    if (host !== HOST) return new Response('not found', { status: 404 })

    const filePath = resolveInsideRoot(pathname)
    if (!filePath) return new Response('forbidden', { status: 403 })

    return net.fetch(pathToFileURL(filePath).toString())
  })
}

export const APP_ORIGIN = `${SCHEME}://${HOST}`
