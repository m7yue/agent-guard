// 端到端 端到端验收：一条命令跑通「发任务 → 审批 → 审计」及其主要分支。
//
// 场景清单（验收场景清单 端到端 + 作者 2026-11-12 要求的高/中价值补充）：
// 1. allow            发任务 → 审批弹窗 → 允许一次 → 文件写入 → 审计（含 decision=once 的 payload 断言）
// 2. deny             拒绝 → 文件未创建 → 审计 decision=deny
// 3. sessionGrant     本会话允许 → 第二次同类调用不再弹窗、直接执行
// 4. policyDeny       越界路径（../）→ 策略硬拒绝：不弹审批、审计 tool-denied、文件不落盘
// 5. restartRecovery  跑完一轮后重启应用 → 会话与消息从库里恢复
// 6. cancel           模型挂起 → 点停止 → run 以 cancelled 收尾、界面回到可发送
// 7. modelError       mock 端点 500 → run 以 failed 收尾、审计可见
//
// 模型确定性：本地 mock Anthropic 端点按脚本回放（e2e/mock-anthropic-server.ts），
// 不依赖任何真实 key；断言全部落在 UI 可见文案与工作区文件系统上。
import fs from 'node:fs'
import path from 'node:path'
import { launchAppGuard, type LaunchedAppGuard } from './launch-app'
import { startMockAnthropicServer, type MockAnthropicServer } from './mock-anthropic-server'

interface ScenarioResult {
  name: string
  passed: boolean
  detail: string
}

/** 在聊天框发一条任务 */
async function submitTask(page: LaunchedAppGuard['page'], prompt: string): Promise<void> {
  await page.getByPlaceholder(/交给 Agent 一个任务/).fill(prompt)
  // antd 给两个汉字的按钮自动插入空格（「发 送」），用正则兼容两种形态
  await page.getByRole('button', { name: /^发\s?送$/ }).click()
}

/** 等审批弹窗出现并确认是哪个工具 */
async function waitForApprovalModal(page: LaunchedAppGuard['page'], tool: string): Promise<void> {
  await page.getByText('需要你的批准').waitFor()
  await page.locator('.approval-fact code', { hasText: tool }).first().waitFor()
}

async function scenarioAllow(server: MockAnthropicServer): Promise<ScenarioResult> {
  server.setScript([
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: 'e2e-allow.txt', content: 'e2e: 审批通过后写入的内容' },
      text: '我需要写一个文件，先请求批准。',
    },
    { kind: 'final', text: '文件已写入（e2e 允许路径）' },
  ])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '请把 e2e 的允许路径内容写入文件')
    await waitForApprovalModal(guard.page, 'write_file')

    await guard.page.getByRole('button', { name: /^允\s?许\s?一\s?次$/ }).click()
    await guard.page.getByText('需要你的批准').waitFor({ state: 'hidden' })

    // 最终回合出现 = run 走完（拒绝/失败都不会有这条文本）
    await guard.page.getByText('文件已写入（e2e 允许路径）').waitFor()

    // 审计时间线：审批结果（摘要含 payload 的 decision）+ 工具调用
    await guard.page.getByText('write_file · once').first().waitFor()
    await guard.page.getByText('工具调用').first().waitFor()

    const content = await fs.promises.readFile(path.join(guard.workspaceRoot, 'e2e-allow.txt'), 'utf8')
    if (content !== 'e2e: 审批通过后写入的内容') {
      return { name: 'allow', passed: false, detail: `文件内容不符：${content}` }
    }
    return { name: 'allow', passed: true, detail: '文件写入 + 审计 write_file · once / 工具调用' }
  } finally {
    await guard.close()
  }
}

async function scenarioDeny(server: MockAnthropicServer): Promise<ScenarioResult> {
  server.setScript([
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: 'e2e-deny.txt', content: '不应该出现的内容' },
      text: '我想写文件。',
    },
    { kind: 'final', text: '好吧，你不让我写（e2e 拒绝路径）' },
  ])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '请尝试写入 e2e 的拒绝路径文件')
    await waitForApprovalModal(guard.page, 'write_file')

    await guard.page.getByRole('button', { name: /^拒\s?绝$/ }).click()
    await guard.page.getByText('需要你的批准').waitFor({ state: 'hidden' })
    await guard.page.getByText('好吧，你不让我写（e2e 拒绝路径）').waitFor()

    await guard.page.getByText('write_file · deny').first().waitFor()

    if (fs.existsSync(path.join(guard.workspaceRoot, 'e2e-deny.txt'))) {
      return { name: 'deny', passed: false, detail: '文件不该存在' }
    }
    return { name: 'deny', passed: true, detail: '文件未创建 + 审计 write_file · deny' }
  } finally {
    await guard.close()
  }
}

async function scenarioSessionGrant(server: MockAnthropicServer): Promise<ScenarioResult> {
  server.setScript([
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: 'e2e-session-1.txt', content: '第一次' },
    },
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: 'e2e-session-2.txt', content: '第二次' },
    },
    { kind: 'final', text: '两次写入都完成了（e2e 会话授权）' },
  ])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '连续写两个文件（会话授权场景）')
    await waitForApprovalModal(guard.page, 'write_file')

    // 本会话允许：写入 sessionGrants，同类调用不再询问
    await guard.page.getByRole('button', { name: /^本\s?会\s?话\s?允\s?许$/ }).click()
    await guard.page.getByText('需要你的批准').waitFor({ state: 'hidden' })

    // 若第二次调用仍弹审批，run 会挂起等待、最终文本永远不出现——
    // 最终文本到达即证明第二次直接放行
    await guard.page.getByText('两次写入都完成了（e2e 会话授权）').waitFor()

    const first = await fs.promises.readFile(path.join(guard.workspaceRoot, 'e2e-session-1.txt'), 'utf8')
    const second = await fs.promises.readFile(path.join(guard.workspaceRoot, 'e2e-session-2.txt'), 'utf8')
    if (first !== '第一次' || second !== '第二次') {
      return { name: 'sessionGrant', passed: false, detail: `文件内容不符：${first} / ${second}` }
    }
    return {
      name: 'sessionGrant',
      passed: true,
      detail: '第二次 write_file 未再弹审批，两个文件均已写入',
    }
  } finally {
    await guard.close()
  }
}

async function scenarioPolicyDeny(server: MockAnthropicServer): Promise<ScenarioResult> {
  server.setScript([
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: '../e2e-escape.txt', content: '越界内容' },
      text: '我想写到工作区外面。',
    },
    { kind: 'final', text: '策略不允许，好吧（e2e 越界路径）' },
  ])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '尝试写到工作区外面（越界场景）')

    // 硬拒绝不经过审批：策略层直接拦截，模型拿到拒绝结果后继续说下去
    await guard.page.getByText('策略不允许，好吧（e2e 越界路径）').waitFor()
    await guard.page.getByText('工具拒绝').first().waitFor()

    // 全程不应出现审批弹窗（run 已结束，此时 count 为 0 才成立）
    const modalCount = await guard.page.getByText('需要你的批准').count()
    const escapePath = path.join(path.dirname(guard.workspaceRoot), 'e2e-escape.txt')
    if (modalCount !== 0) {
      return { name: 'policyDeny', passed: false, detail: '越界路径不应触发审批弹窗' }
    }
    if (fs.existsSync(escapePath)) {
      return { name: 'policyDeny', passed: false, detail: '越界文件不该存在' }
    }
    return { name: 'policyDeny', passed: true, detail: '未弹审批、审计 tool-denied、工作区外无文件' }
  } finally {
    await guard.close()
  }
}

async function scenarioRestartRecovery(server: MockAnthropicServer): Promise<ScenarioResult> {
  const FINAL_TEXT = '文件已写入（e2e 重启恢复）'
  server.setScript([
    {
      kind: 'toolUse',
      tool: 'write_file',
      args: { path: 'e2e-restart.txt', content: '重启前写入' },
    },
    { kind: 'final', text: FINAL_TEXT },
  ])

  // 第一阶段：跑完一轮任务后关窗，但保留数据目录
  const first = await launchAppGuard({ modelBaseUrl: server.baseUrl, preserveData: true })
  const dirs = { workspaceRoot: first.workspaceRoot, stateDir: first.stateDir }
  try {
    await first.waitUntilWorkbenchReady()
    await submitTask(first.page, '重启恢复场景：写一个文件')
    await waitForApprovalModal(first.page, 'write_file')
    await first.page.getByRole('button', { name: /^允\s?许\s?一\s?次$/ }).click()
    await first.page.getByText(FINAL_TEXT).waitFor()
  } finally {
    await first.close()
  }

  // 第二阶段：同一份数据目录重启应用，会话列表应出现刚才的会话，点开能回放消息
  const second = await launchAppGuard({ modelBaseUrl: server.baseUrl, dirs })
  try {
    await second.waitUntilWorkbenchReady()
    // 会话标题 = 首条提问前 40 字（executor ensureConversation 的约定）
    await second.page.getByText('重启恢复场景：写一个文件').first().waitFor()
    await second.page.getByText('重启恢复场景：写一个文件').first().click()
    await second.page.getByText(FINAL_TEXT).waitFor()

    const content = await fs.promises.readFile(path.join(dirs.workspaceRoot, 'e2e-restart.txt'), 'utf8')
    if (content !== '重启前写入') {
      return { name: 'restartRecovery', passed: false, detail: `文件内容不符：${content}` }
    }
    return { name: 'restartRecovery', passed: true, detail: '重启后会话与消息恢复、文件仍在' }
  } finally {
    await second.close()
  }
}

async function scenarioCancel(server: MockAnthropicServer): Promise<ScenarioResult> {
  // 模型挂 30 秒不回：给「点停止」留足窗口
  server.setScript([{ kind: 'delay', text: '不应出现的回复', delayMs: 30_000 }])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '取消场景：这条任务会被手动停止')

    // 运行中：发送按钮换成停止
    const stopButton = guard.page.getByRole('button', { name: /^停\s?止$/ })
    await stopButton.waitFor()
    await stopButton.click()

    // 停止后回到可发送状态，审计记 cancelled 收尾
    await guard.page.getByRole('button', { name: /^发\s?送$/ }).waitFor()
    await guard.page.getByText('cancelled').first().waitFor()
    return { name: 'cancel', passed: true, detail: 'run 以 cancelled 收尾，界面回到可发送' }
  } finally {
    await guard.close()
  }
}

async function scenarioModelError(server: MockAnthropicServer): Promise<ScenarioResult> {
  // 空脚本：第一次请求就拿到 500，SDK 抛错 → run failed
  server.setScript([])

  const guard = await launchAppGuard({ modelBaseUrl: server.baseUrl })
  try {
    await guard.waitUntilWorkbenchReady()
    await submitTask(guard.page, '错误场景：模型端点会返回 500')

    await guard.page.getByRole('button', { name: /^发\s?送$/ }).waitFor()
    await guard.page.getByText('failed').first().waitFor()
    return { name: 'modelError', passed: true, detail: 'run 以 failed 收尾（mock 500）' }
  } finally {
    await guard.close()
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.resolve(import.meta.dirname, '../out/main'))) {
    console.error('[e2e] 缺少 out/ 产物，请先 npm run build')
    process.exit(2)
  }

  const server = await startMockAnthropicServer()
  const results: ScenarioResult[] = []
  const scenarios: Array<(server: MockAnthropicServer) => Promise<ScenarioResult>> = [
    scenarioAllow,
    scenarioDeny,
    scenarioSessionGrant,
    scenarioPolicyDeny,
    scenarioRestartRecovery,
    scenarioCancel,
    scenarioModelError,
  ]

  for (const scenario of scenarios) {
    try {
      results.push(await scenario(server))
    } catch (error) {
      results.push({
        name: scenario.name,
        passed: false,
        detail: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
      })
    }
  }
  await server.close()

  for (const result of results) {
    console.log(`[e2e] ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}  ${result.detail}`)
  }
  const failed = results.filter((result) => !result.passed)
  if (failed.length > 0) console.error(`[e2e] ${failed.length}/${results.length} 个场景失败`)
  process.exit(failed.length === 0 ? 0 : 1)
}

void main()
