import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 开发期专用 CSP：HMR 要连 ws，React 刷新要内联脚本。
// apply: 'serve' 保证它不会进入生产构建——生产仍然是 default-src 'none'。
function devCsp(): Plugin {
  return {
    name: 'agentguard-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*",
      )
    },
  }
}

export default defineConfig({
  main: {
    build: {
      // 依赖交给 Node 运行时解析（主进程能读 node_modules）
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          executor: resolve(__dirname, 'src/executor/index.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },

  preload: {
    // 关键：electron-vite v6 默认会自动 externalize 依赖。
    // sandbox 下的 preload 不能 require 依赖，zod 必须内联进产物。
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'preload.js' },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCsp()],
    build: {
      // electron-vite 的 renderer 默认不压缩；产物要进安装包，这里打开
      minify: true,
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
})
