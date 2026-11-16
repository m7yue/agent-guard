#!/usr/bin/env node
// 造一个更新 feed：以 0.1.1 构建应用，签名、打包，并生成 electron-updater 需要的 latest-mac.yml。
//
// 输出：dist/feed/<cohort>/AgentGuard-0.1.1-arm64-mac.zip 与 latest-mac.yml
// 用途：配合 scripts/update-server.cjs 做本地自动更新验证。
//
// 注意：构建时临时把 package.json 的版本改成 0.1.1，结束后恢复——这样仓库里的版本仍是 0.1.0。
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')
const originalPkg = fs.readFileSync(pkgPath, 'utf8')
const { productName } = JSON.parse(originalPkg)
const nextVersion = '0.1.1'
const cohort = process.argv[2] ?? 'beta'

function sh(command, args, extraEnv = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_BUILDER_CACHE: path.join(root, '.eb-cache'), ...extraEnv },
  })
}

try {
  // 1) 临时改版本，构建到独立目录，避免覆盖正在运行的 0.1.0
  const pkg = JSON.parse(originalPkg)
  pkg.version = nextVersion
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  sh('npm', ['run', 'build'])
  sh('npx', ['electron-builder', '--mac', 'dir', '--config.directories.output=dist-next'])

  // 2) 补 app-update.yml 后签名（与 make-artifacts.cjs 同样的原因）
  const appPath = path.join(root, 'dist-next', 'mac-arm64', `${productName}.app`)
  fs.writeFileSync(
    path.join(appPath, 'Contents', 'Resources', 'app-update.yml'),
    ['provider: generic', 'url: https://updates.agentguard.invalid/agentguard', ''].join('\n'),
    'utf8',
  )
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--identifier', 'com.agentguard.app', appPath], {
    stdio: 'inherit',
  })

  // 3) 打 zip（electron-updater 的 generic provider 需要 zip 作为更新包）
  const feedDir = path.join(root, 'dist', 'feed', cohort)
  fs.mkdirSync(feedDir, { recursive: true })
  const zipName = `${productName}-${nextVersion}-arm64-mac.zip`
  const zipPath = path.join(feedDir, zipName)
  fs.rmSync(zipPath, { force: true })
  execFileSync('ditto', ['-c', '-k', '--keepParent', appPath, zipPath], { stdio: 'inherit' })

  // 4) 生成 latest-mac.yml：electron-updater 靠它判断"有没有新版本"
  const buffer = fs.readFileSync(zipPath)
  const sha512 = crypto.createHash('sha512').update(buffer).digest('base64')
  const yml = [
    `version: ${nextVersion}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${buffer.length}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(feedDir, 'latest-mac.yml'), yml, 'utf8')

  console.log(`\nfeed 已生成：${feedDir}`)
  console.log(`  版本 ${nextVersion}，zip ${Math.round(buffer.length / 1024 / 1024)} MB`)
} finally {
  fs.writeFileSync(pkgPath, originalPkg, 'utf8')
  console.log('package.json 版本已恢复')
}
