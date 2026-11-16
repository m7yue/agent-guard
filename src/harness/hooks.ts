// 工具生命周期钩子：横切逻辑（权限、审计、事件）的挂载点。
//
// 与工具生命周期 FireHook 同形，但把“拦截”收窄成 PermissionResult：
// - PreToolUse 的 hook 返回 allow / ask / deny；多个 hook 的结果按 deny > ask > allow 合并；
// - PostToolUse / Stop 只观察，不改变工具结果。
// 业务步骤（准备记忆、执行工具）不放在 hook 里；hook 只做横切，避免变成第二套业务逻辑。
import type { Message } from './core/types'
import type { PermissionResult } from './permission'

export interface PreToolUseHookInput {
  /** 模型请求的工具名 */
  toolName: string
  /** 模型给出的原始入参（尚未经过工具自己的 zod 校验） */
  args: Record<string, unknown>
}

export interface PostToolUseHookInput {
  toolName: string
  args: Record<string, unknown>
  /** 工具返回的文本；失败时是回灌给模型的错误文本 */
  result: string
  /** 工具是否失败；审计与界面据此区分成功/失败 */
  isError: boolean
}

export interface StopHookInput {
  /** 本次运行实际用掉的模型轮次 */
  rounds: number
  /** 运行结束时的完整消息列表 */
  messages: Message[]
}

export interface ToolDeniedHookInput {
  /** 被拒绝的工具名 */
  toolName: string
  /** 模型给出的原始入参 */
  args: Record<string, unknown>
  /** 拒绝发生在哪一步 */
  stage: 'permission' | 'approval' | 'unknown'
  /** 权限管线/审批/未知工具给出的原因 */
  reason: string
}

export type PreToolUseHook = (
  input: PreToolUseHookInput,
) => Promise<PermissionResult | void> | PermissionResult | void
export type PostToolUseHook = (
  input: PostToolUseHookInput,
) => Promise<void> | void
export type ToolDeniedHook = (
  input: ToolDeniedHookInput,
) => Promise<void> | void
export type StopHook = (input: StopHookInput) => Promise<void> | void

/** 工具生命周期钩子注册表；每个 run 创建一个，随 run 结束丢弃 */
export class HookManager {
  private readonly preToolUseHooks: PreToolUseHook[] = []
  private readonly postToolUseHooks: PostToolUseHook[] = []
  private readonly toolDeniedHooks: ToolDeniedHook[] = []
  private readonly stopHooks: StopHook[] = []

  registerPreToolUse(hook: PreToolUseHook): void {
    this.preToolUseHooks.push(hook)
  }

  registerPostToolUse(hook: PostToolUseHook): void {
    this.postToolUseHooks.push(hook)
  }

  registerToolDenied(hook: ToolDeniedHook): void {
    this.toolDeniedHooks.push(hook)
  }

  registerStop(hook: StopHook): void {
    this.stopHooks.push(hook)
  }

  /**
   * 跑全部 PreToolUse hook，按 deny > ask > allow 合并。
   * 不在第一个 deny 处提前返回：审计 hook 需要看到被拒绝的调用。
   */
  async runPreToolUse(input: PreToolUseHookInput): Promise<PermissionResult> {
    let result: PermissionResult = { decision: 'allow', reason: '允许' }

    for (const hook of this.preToolUseHooks) {
      const outcome = await hook(input)
      if (!outcome?.decision) continue
      if (outcome.decision === 'deny') {
        result = outcome
      } else if (outcome.decision === 'ask' && result.decision === 'allow') {
        result = outcome
      }
    }
    return result
  }

  async runPostToolUse(input: PostToolUseHookInput): Promise<void> {
    for (const hook of this.postToolUseHooks) {
      await hook(input)
    }
  }

  async runToolDenied(input: ToolDeniedHookInput): Promise<void> {
    for (const hook of this.toolDeniedHooks) {
      await hook(input)
    }
  }

  async runStop(input: StopHookInput): Promise<void> {
    for (const hook of this.stopHooks) {
      await hook(input)
    }
  }
}
