// 性能埋点：启动阶段打点、内存采集、报告落盘。
//
// 只做"测量"，不做优化。目标是把"打开快不快、占多少内存、包多大"变成可重复的数字，
// 预算与 CI 回归检测都建立在这套数字上。
import { app } from 'electron'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface PerfMark {
  /** 阶段名（process-start / app-ready / window-created / …） */
  name: string
  /** 距进程启动的毫秒数（时间线位置） */
  sinceStartMs: number
  /** 距上一个打点的毫秒数（这一段花了多久） */
  sincePrevMs: number
}

export interface ProcessMemory {
  /** 进程类型：Browser / Tab / Utility / GPU … */
  type: string
  pid: number
  /** 常驻内存（MB），即 workingSetSize */
  workingSetMB: number
}

/** 本次采集的条件（静置时长、节流、DevTools、profile），用于判断不同报告之间是否可比 */
export interface PerfMeasurement {
  /** 加载完成后静置多久才采集（毫秒） */
  idleMs: number
  /** 窗口的 backgroundThrottling 配置值：false 表示采集时关掉了节流（rAF 正常执行） */
  backgroundThrottling: boolean
  /** 采集时是否挂着 DevTools（挂着会显著拖慢） */
  devToolsOpen: boolean
  /** 本次运行使用的 user-data-dir（是否全新 profile 可据此判断） */
  userDataDir: string
}

export interface PerfReport {
  /** 采集时间（ISO 8601） */
  timestamp: string
  /** 采集口径（静置时长、节流、DevTools、profile） */
  measurement: PerfMeasurement
  app: { version: string; electron: string; node: string; chrome: string; platform: string; arch: string }
  /** 全部打点，按发生顺序 */
  marks: PerfMark[]
  /** 启动各阶段耗时（从进程启动算起） */
  startup: Record<string, number>
  /** 页面自报的首帧时间（相对页面加载），主进程侧打点会包含 IPC 往返 */
  pageFirstPaintMs: number | null
  memory: {
    /** 所有进程 workingSet 之和（MB） */
    totalWorkingSetMB: number
    /** 主进程 V8 堆已用（MB） */
    mainHeapUsedMB: number
    processes: ProcessMemory[]
  }
  /** out/ 产物体积（打包前的量级参考） */
  bundle: { totalMB: number; files: Array<{ file: string; kb: number }> }
}

const startedAt = Date.now()
const marks: Array<{ name: string; sinceStartMs: number }> = []
let pageFirstPaintMs: number | null = null

/** 记一个阶段。名字用短横线，和日志里的 message 区分开 */
export function mark(name: string): void {
  marks.push({ name, sinceStartMs: Date.now() - startedAt })
}

/** 渲染层自报的首帧时间（相对页面加载），只做记录，不参与主进程时间线 */
export function setPageFirstPaint(ms: number): void {
  pageFirstPaintMs = ms
}

/** 取某个阶段的相对时间；没打过点返回 undefined */
function timeOf(name: string): number | undefined {
  return marks.find((markItem) => markItem.name === name)?.sinceStartMs
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** 关闭时的打点顺序即阶段顺序，delta 用相邻两项相减 */
function toPerfMarks(): PerfMark[] {
  return marks.map((item, index) => ({
    name: item.name,
    sinceStartMs: item.sinceStartMs,
    sincePrevMs:
      index === 0 ? item.sinceStartMs : item.sinceStartMs - marks[index - 1].sinceStartMs,
  }))
}

/** 逐进程内存：app.getAppMetrics() 覆盖 Browser / Tab / Utility / GPU */
function collectMemory(): PerfReport['memory'] {
  const processes: ProcessMemory[] = app.getAppMetrics().map((metric) => ({
    type: metric.type,
    pid: metric.pid,
    workingSetMB: round(metric.memory.workingSetSize / 1024),
  }))

  return {
    totalWorkingSetMB: round(processes.reduce((sum, item) => sum + item.workingSetMB, 0)),
    mainHeapUsedMB: round(process.memoryUsage().heapUsed / 1024 / 1024),
    processes,
  }
}

/** 递归统计 out/ 下每个文件的大小（KB），返回总量与最大的若干个 */
function scanBundle(dir: string): PerfReport['bundle'] {
  const files: Array<{ file: string; kb: number }> = []

  const walk = (current: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.join(current, entry)
      const stat = statSync(full)

      if (stat.isDirectory()) {
        walk(full)
      } else {
        files.push({ file: path.relative(dir, full), kb: round(stat.size / 1024) })
      }
    }
  }

  walk(dir)
  files.sort((a, b) => b.kb - a.kb)

  return {
    totalMB: round(files.reduce((sum, item) => sum + item.kb, 0) / 1024),
    files: files.slice(0, 10),
  }
}

/** 组装报告：打点 + 内存 + 包体 */
export function buildReport(bundleDir: string, measurement: PerfMeasurement): PerfReport {
  return {
    timestamp: new Date().toISOString(),
    measurement,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
      chrome: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
    },
    marks: toPerfMarks(),
    startup: {
      toAppReadyMs: timeOf('app-ready') ?? -1,
      toWindowCreatedMs: timeOf('window-created') ?? -1,
      toReadyToShowMs: timeOf('ready-to-show') ?? -1,
      toDidFinishLoadMs: timeOf('did-finish-load') ?? -1,
      toFirstPaintMs: timeOf('first-paint') ?? -1,
    },
    pageFirstPaintMs,
    memory: collectMemory(),
    bundle: scanBundle(bundleDir),
  }
}

/** 写到 <dir>/perf-<时间戳>.json，返回路径 */
export function writeReport(dir: string, report: PerfReport): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `perf-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(report, null, 2), 'utf8')
  return file
}
