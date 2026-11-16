#!/usr/bin/env node
// 性能采集：以 --perf 模式启动 Electron，等它写报告并退出，可重复多次并给出分布。
//
// 用法：
//   npm run perf                # 跑 1 次
//   npm run perf -- --runs 5    # 跑 5 次，输出 min / median / max
//
// 统计口径：
// - 每次都用全新的 user-data-dir（不含历史会话/缓存），避免上一次运行影响下一次；
// - 串行执行，避免多个 Electron 实例争抢 CPU 与内存；
// - 时间类指标取中位数（对偶发卡顿不敏感），并给出 min/max 让人看到波动；
// - 报告写在 .state/perf/perf-*.json，多次运行的汇总写在 .state/perf/summary-*.json。
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const electron = require('electron')

const root = path.resolve(__dirname, '..')
const stateDir = path.join(root, '.state')
const perfDir = path.join(stateDir, 'perf')

const runsIndex = process.argv.indexOf('--runs')
const runs = runsIndex === -1 ? 1 : Math.max(1, Number(process.argv[runsIndex + 1]) || 1)

/** 目录里目前有哪些 perf-*.json（用来判断这次运行新写了哪个） */
function listReports() {
  if (!fs.existsSync(perfDir)) return []
  return fs.readdirSync(perfDir).filter((name) => name.startsWith('perf-')).sort()
}

/** 启动一次 Electron，等它退出 */
function runOnce(index) {
  const userData = path.join(stateDir, `perf-userdata-${index}`)
  fs.rmSync(userData, { recursive: true, force: true })

  return new Promise((resolve) => {
    const child = spawn(electron, ['.', '--perf', `--user-data-dir=${userData}`], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('exit', () => resolve())
  })
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function round(value) {
  return Math.round(value * 10) / 10
}

function summarize(reports) {
  // 时间类指标：中位数 + 范围；内存/包体：中位数
  const pick = (report, pathList) => pathList.reduce((value, key) => value?.[key], report)

  const metrics = [
    ['toAppReadyMs', (r) => r.startup.toAppReadyMs, 'ms'],
    ['toWindowCreatedMs', (r) => r.startup.toWindowCreatedMs, 'ms'],
    ['toReadyToShowMs', (r) => r.startup.toReadyToShowMs, 'ms'],
    ['toDidFinishLoadMs', (r) => r.startup.toDidFinishLoadMs, 'ms'],
    ['toFirstPaintMs', (r) => r.startup.toFirstPaintMs, 'ms'],
    ['pageFirstPaintMs', (r) => r.pageFirstPaintMs, 'ms'],
    ['memoryTotalMB', (r) => r.memory.totalWorkingSetMB, 'MB'],
    ['mainHeapMB', (r) => r.memory.mainHeapUsedMB, 'MB'],
    ['bundleTotalMB', (r) => r.bundle.totalMB, 'MB'],
  ]

  return metrics.map(([name, read, unit]) => {
    const values = reports.map(read).filter((value) => typeof value === 'number' && value >= 0)
    if (values.length === 0) return { name, unit, count: 0 }

    return {
      name,
      unit,
      count: values.length,
      min: round(Math.min(...values)),
      median: round(median(values)),
      max: round(Math.max(...values)),
    }
  })
}

async function main() {
  const reports = []

  for (let index = 1; index <= runs; index += 1) {
    const before = new Set(listReports())
    await runOnce(index)
    const created = listReports().find((name) => !before.has(name))
    if (!created) {
      console.error(`第 ${index} 次运行没有产出报告，跳过`)
      continue
    }
    reports.push(JSON.parse(fs.readFileSync(path.join(perfDir, created), 'utf8')))
    process.stdout.write(`第 ${index} 次完成\n`)
  }

  if (reports.length === 0) {
    console.error('没有可用的性能报告')
    process.exit(1)
  }

  const summary = summarize(reports)
  const summaryFile = path.join(perfDir, `summary-${Date.now()}.json`)
  fs.writeFileSync(
    summaryFile,
    JSON.stringify({ runs: reports.length, metrics: summary, reports }, null, 2),
    'utf8',
  )

  const measurement = reports[0].measurement
  console.log(
    `\n采集口径：静置 ${measurement.idleMs}ms · 节流=${measurement.backgroundThrottling ? '开启' : '关闭'} · DevTools=${measurement.devToolsOpen ? '开启' : '关闭'}`,
  )

  console.log(`\n=== 统计（${reports.length} 次）===`)
  console.log('指标                 单位   min      median   max')
  for (const item of summary) {
    console.log(
      `${item.name.padEnd(20)} ${item.unit.padEnd(5)} ${String(item.min ?? '-').padEnd(8)} ${String(item.median ?? '-').padEnd(8)} ${item.max ?? '-'}`,
    )
  }

  console.log(`\n汇总：${summaryFile}`)
}

main()
