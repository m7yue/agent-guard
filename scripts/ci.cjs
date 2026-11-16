#!/usr/bin/env node
// 本地 CI：按 .github/workflows/ci.yml 的顺序跑一遍，保证"CI 跑的就是本地能跑的"。
//
// 步骤：类型检查 → 测试 → 评测自检 → 评测门槛 → 构建 → 产物大小门槛。
// 打包与安装包大小不在本地跑（要 Electron 原生模块按 ABI 重建，且耗时长），由 workflow 负责。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const BUDGET_MB = 2

function run(label, command, args) {
  console.log(`\n[ci] ${label}`)
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    total += stat.isDirectory() ? dirSize(full) : stat.size
  }
  return total
}

run('类型检查', 'npm', ['run', 'typecheck'])
run('测试', 'npm', ['test'])
run('评测自检', 'npm', ['run', 'evals:check'])
run('评测', 'npm', ['run', 'evals'])
run('构建', 'npm', ['run', 'build'])

const outSize = dirSize(path.join(root, 'out'))
const outMB = outSize / 1024 / 1024
console.log(`\n[ci] out/ 大小：${outMB.toFixed(2)} MB（预算 ${BUDGET_MB} MB）`)
if (outMB > BUDGET_MB) {
  console.error('[ci] 超出产物预算')
  process.exit(1)
}
console.log('[ci] 通过')
