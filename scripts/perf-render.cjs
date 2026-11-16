#!/usr/bin/env node
// 渲染交互性能采集：Playwright 驱动真实窗口做固定交互，测 FPS 与长任务。
//
// 用法：
//   npm run perf:render                # 跑 1 次
//   npm run perf:render -- --runs 3    # 跑 3 次取中位数
//
// 口径（与 scripts/perf.cjs 一致的原则）：
// - 每次都用全新的 user-data-dir / 工作区，串行执行；
// - 指标取中位数，附 min/max；
// - 交互固定：工作台 ↔ 实验室 切换 ×5、审计刷新 ×5——只测渲染层，不触发模型；
//   （dev:secure 形态：out/ 产物 + app://，与生产同构）
// - FPS 用 rAF 计数（interaction 窗口内帧数 / 时长），长任务用 PerformanceObserver('longtask')
//   （>50ms 的主线程任务，Chromium 定义）。
//
// 报告写入 .state/perf/render-perf-<时间戳>.json 与 render-summary-<时间戳>.json。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron: playwrightElectron } = require('playwright')

const electronExecutablePath = require('electron')
const repoRoot = path.resolve(__dirname, '..')
const perfDir = path.join(repoRoot, '.state', 'perf')

const runsIndex = process.argv.indexOf('--runs')
const runs = runsIndex === -1 ? 1 : Math.max(1, Number(process.argv[runsIndex + 1]) || 1)

/**
 * 注入渲染层的采集器（上半）：开始计数。
 *
 * 这两个函数经 page.evaluate 传参时会被序列化后**在渲染进程里执行**，
 * 不是在本脚本进程里跑——所以只能访问 window / performance / PerformanceObserver
 * 这些页面 API，也不能引用闭包外的任何常量。
 *
 * 帧计数原理：rAF 回调在每次重绘前触发一次，连续自调度就是在数"浏览器画了多少帧"。
 * 注意它测的是"有机会画帧的频率"，不感知丢帧内容；窗口不可见或被节流时 rAF 会停摆
 * （采集窗口内 Playwright 持续交互，窗口始终前台，此偏差不出现）。
 */
function renderProbeStart() {
  window.__renderProbe = { frames: 0, longTasks: [], startedAt: 0, stoppedAt: 0 }
  window.__renderProbeOn = true
  const countFrame = () => {
    if (!window.__renderProbeOn) return
    window.__renderProbe.frames += 1
    requestAnimationFrame(countFrame)
  }
  requestAnimationFrame(countFrame)
  // longtask：主线程超过 50ms 的任务（Chromium 定义），触发一次记录其时长
  window.__renderProbeObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__renderProbe.longTasks.push(Math.round(entry.duration))
    }
  })
  window.__renderProbeObserver.observe({ entryTypes: ['longtask'] })
  window.__renderProbe.startedAt = performance.now()
}

/** 注入渲染层的采集器（下半）：停止计数，把原始数据带回本进程 */
function renderProbeStop() {
  window.__renderProbeOn = false
  window.__renderProbe.stoppedAt = performance.now()
  window.__renderProbeObserver.disconnect()
  return {
    frames: window.__renderProbe.frames,
    windowMs: Math.round(window.__renderProbe.stoppedAt - window.__renderProbe.startedAt),
    longTasks: window.__renderProbe.longTasks,
  }
}

/**
 * 启动一次采集：全新 profile + 独立工作区，跑固定交互，返回单次指标。
 * 与 e2e/launch-app.ts 同一套启动约定（本脚本是 CJS，不便复用 ESM 模块，逻辑保持对齐）。
 */
async function runOnce(index) {
  const runRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `agentguard-render-${index}-`))
  const env = {
    ...process.env,
    AGENTGUARD_WORKSPACE: path.join(runRoot, 'workspace'),
    AGENTGUARD_STATE_DIR: path.join(runRoot, 'state'),
    AGENTGUARD_EMBEDDING_PROVIDER: 'fake',
    AGENTGUARD_RERANK_PROVIDER: 'off',
  }
  // 环境坑：不清掉它 Electron 以纯 Node 模式启动，ipcMain 是 undefined，窗口起不来
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(env.AGENTGUARD_WORKSPACE, { recursive: true })

  const app = await playwrightElectron.launch({
    executablePath: electronExecutablePath,
    args: [repoRoot],
    cwd: runRoot, // 避免读到开发机 .env 里的真实模型配置
    env,
  })

  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    // 顶栏 Segmented 的「工作台」出现 = 首屏渲染完成
    await page.getByText('工作台', { exact: true }).first().waitFor()
    await page.waitForTimeout(500) // 等首屏渲染尘埃落定（挂载后的布局/订阅都在窗口外）

    await page.evaluate(renderProbeStart)

    // 固定交互负载：切视图触发两套面板的卸载/挂载（最重的渲染层交互）
    for (let i = 0; i < 5; i += 1) {
      await page.getByText('实验室', { exact: true }).click()
      await page.getByText('工作台', { exact: true }).click()
    }
    // 审计刷新按钮只有图标（ReloadOutlined），无文本名；按图标类定位
    for (let i = 0; i < 5; i += 1) {
      await page.locator('.anticon-reload').first().click()
    }

    const probe = await page.evaluate(renderProbeStop)
    // fps = 帧数 / 交互窗口时长；round 到 0.1，与 perf.cjs 的精度一致
    return {
      fps: probe.windowMs > 0 ? Math.round((probe.frames / probe.windowMs) * 1000 * 10) / 10 : 0,
      frames: probe.frames,
      windowMs: probe.windowMs,
      longTaskCount: probe.longTasks.length,
      longTaskTotalMs: probe.longTasks.reduce((sum, item) => sum + item, 0),
      longTasksMs: probe.longTasks,
    }
  } finally {
    await app.close()
    await fs.promises.rm(runRoot, { recursive: true, force: true })
  }
}

/** 中位数：偶数个样本取中间两值的平均。时间类指标用它而不是平均——对偶发卡顿不敏感 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function round(value) {
  return Math.round(value * 10) / 10
}

async function main() {
  if (!fs.existsSync(path.join(repoRoot, 'out', 'main'))) {
    console.error('[perf:render] 缺少 out/ 产物，请先 npm run build')
    process.exit(2)
  }

  fs.mkdirSync(perfDir, { recursive: true })
  // 串行执行：多个 Electron 实例会争抢 CPU/内存，数字就不可比了
  const results = []
  for (let index = 0; index < runs; index += 1) {
    const result = await runOnce(index)
    results.push(result)
    console.log(
      `[perf:render] #${index + 1} fps=${result.fps} longTasks=${result.longTaskCount} (${result.longTaskTotalMs}ms) window=${result.windowMs}ms`,
    )
  }

  const summary = {
    timestamp: new Date().toISOString(),
    runs,
    workload: '视图切换 ×5 + 审计刷新 ×5（无模型参与）',
    fps: { median: round(median(results.map((r) => r.fps))), min: round(Math.min(...results.map((r) => r.fps))), max: round(Math.max(...results.map((r) => r.fps))) },
    longTaskCount: { median: median(results.map((r) => r.longTaskCount)), min: Math.min(...results.map((r) => r.longTaskCount)), max: Math.max(...results.map((r) => r.longTaskCount)) },
    longTaskTotalMs: { median: round(median(results.map((r) => r.longTaskTotalMs))), min: round(Math.min(...results.map((r) => r.longTaskTotalMs))), max: round(Math.max(...results.map((r) => r.longTaskTotalMs))) },
    perRun: results,
  }

  const stamp = Date.now()
  fs.writeFileSync(path.join(perfDir, `render-summary-${stamp}.json`), JSON.stringify(summary, null, 2))
  console.log(`[perf:render] 汇总已写入 .state/perf/render-summary-${stamp}.json`)
  console.log(
    `[perf:render] fps 中位数 ${summary.fps.median}（${summary.fps.min}–${summary.fps.max}），长任务中位数 ${summary.longTaskCount.median} 次 / ${summary.longTaskTotalMs.median}ms`,
  )
}

main().catch((error) => {
  console.error('[perf:render] 失败:', error)
  process.exit(1)
})
