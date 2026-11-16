// 权限管线：工具调用前先过这里，决定 allow / ask / deny。
//
// 与参照项目的 modules/permission.ts 同构：硬拒绝清单 → 规则 → 交给用户审批。
import { resolveInWorkspace } from './workspace'

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export interface PermissionResult {
  decision: PermissionDecision
  reason: string
}

// 命中即拒绝，不给审批机会
const DENY_PATTERNS = ['rm -rf /', 'rm -rf ~', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if=', '> /dev/sda']

function isInsideWorkspace(root: string, target: string): boolean {
  try {
    resolveInWorkspace(root, target)
    return true
  } catch {
    return false
  }
}

export function checkPermission(
  tool: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): PermissionResult {
  if (tool === 'run_command') {
    const command = String(args.command ?? '')
    const hit = DENY_PATTERNS.find((pattern) => command.includes(pattern))
    if (hit) return { decision: 'deny', reason: `命中硬拒绝规则：${hit}` }
    return { decision: 'ask', reason: '执行命令' }
  }

  if (tool === 'write_file') {
    const target = args.path
    if (typeof target !== 'string' || !isInsideWorkspace(workspaceRoot, target)) {
      return { decision: 'deny', reason: '写入路径越界' }
    }
    return { decision: 'ask', reason: '写入文件' }
  }

  if (tool === 'read_file') {
    const target = args.path
    if (typeof target !== 'string' || !isInsideWorkspace(workspaceRoot, target)) {
      return { decision: 'deny', reason: '读取路径越界' }
    }
    return { decision: 'allow', reason: '只读操作' }
  }

  if (tool === 'search_conversations') {
    // 只读检索历史会话：query 是自由文本，没有路径参数，没有可越界的东西
    return { decision: 'allow', reason: '只读检索历史会话' }
  }

  if (tool === 'write_memory') {
    // 写应用状态而不是工作区；但记忆会跨会话影响后续回答，必须由人看见内容再放行。
    // 「本会话允许」不适用于它：一次授权会让后续所有记忆写入静默通过（见 executor 的守卫）。
    return { decision: 'ask', reason: '写入记忆（同名会更新）' }
  }

  if (tool === 'read_memory' || tool === 'select_memory') {
    // 只读记忆：没有路径参数，读取/选择本身不改变数据
    return { decision: 'allow', reason: '只读记忆' }
  }

  // 未知工具默认拒绝：新增工具必须先登记规则，否则不会被放行
  return { decision: 'deny', reason: `未知工具：${tool}` }
}
