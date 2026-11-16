#!/usr/bin/env node
// 把打包好的 .app 变成仅用于本地验证的 dmg。
//
// 输入：dist/mac-arm64/AgentGuard.app（由 electron-builder --mac dir 产出）
// 输出：
//   dist/AgentGuard-<版本>-arm64.dmg      仅本地安装/启动验证
//
// 两步，顺序不能换：
//   1. codesign  —— 给整个 .app 做 ad-hoc 签名。Electron 的 stub 自带签名，
//                   但打包替换 Resources 后失效，不重签会"启动即退出、无输出"。
//   2. hdiutil   —— 生成 dmg（磁盘镜像）。UDZO = 压缩的只读镜像。
//
// 本项目不发布安装包，也不生成自动更新用的 zip / app-update.yml。
//
// 为什么不用 electron-builder 的 dmg/zip 目标：
// - dmg 目标要从 GitHub 下载 vendor 工具，受限网络下超时；
// - zip 目标在签名前就打包，签完还得重打。
// hdiutil 与 ditto 是 macOS 自带，离线可用，顺序也可控。
// 若后续需要正式签名，可切换回 electron-builder 的签名流程。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const { version, productName } = require(path.join(root, 'package.json'))

const appPath = path.join(root, 'dist', 'mac-arm64', `${productName}.app`)
if (!fs.existsSync(appPath)) {
  console.error(`找不到 ${appPath}，先跑 electron-builder --mac dir`)
  process.exit(1)
}

// 1) ad-hoc 签名
//    --force   覆盖已有签名
//    --deep    连内嵌的框架与插件一起签（简单但慢，正式签名要按组件分别签）
//    --sign -  用 ad-hoc 身份（不指向任何证书）
//    --identifier 指定 bundle id，覆盖 Electron 默认的 "Electron"
console.log('[artifacts] ad-hoc 签名')
execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.agentguard.app', appPath], {
  stdio: 'inherit',
})

// 2) dmg：把 .app 放进一个只读压缩镜像
//    -volname   挂载后显示的卷名
//    -srcfolder 要装进镜像的目录（这里就是 .app）
//    -ov        输出文件已存在时覆盖
//    -format UDZO  压缩的只读镜像（UD = user data，ZO = zlib 压缩）
const dmgPath = path.join(root, 'dist', `${productName}-${version}-arm64.dmg`)
fs.rmSync(dmgPath, { force: true })
console.log('[artifacts] 生成 dmg')
execFileSync(
  'hdiutil',
  ['create', '-volname', productName, '-srcfolder', appPath, '-ov', '-format', 'UDZO', dmgPath],
  { stdio: 'inherit' },
)

console.log(`${path.basename(dmgPath)}  ${Math.round(fs.statSync(dmgPath).size / 1024 / 1024)} MB`)
