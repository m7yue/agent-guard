// 工具 manifest：定义、handler 工厂与 effect 类型的单一聚合点。
//
// 这里不做名字→effect 的运行时派发；agentLoop 的 switch 才是业务映射。
// manifest 只负责：
// - 给模型看的定义表（toolDefinitions）；
// - 按 effect 类型生成 handler map（createToolHandlers）；
// - 从各工具模块推导 ToolEffect union，避免在 agent-loop 手写 7 个类型。
import type { EffectHandler } from '../core/effects'
import type { ToolDefinition } from '../core/types'
import { readFileTool } from './read-file'
import { readMemoryTool } from './read-memory'
import { runCommandTool } from './run-command'
import { searchConversationsTool } from './search-conversations'
import { selectMemoryTool } from './select-memory'
import type { ToolContext } from './types'
import { writeFileTool } from './write-file'
import { writeMemoryTool } from './write-memory'

export const toolModules = [
  readFileTool,
  writeFileTool,
  runCommandTool,
  searchConversationsTool,
  writeMemoryTool,
  readMemoryTool,
  selectMemoryTool,
] as const

type ToolModule = (typeof toolModules)[number]

type ToolEffectOf<Module> = Module extends {
  createHandler: (ctx: ToolContext) => EffectHandler<infer EffectType>
}
  ? EffectType
  : never

/** 所有工具 effect 的 union；AgentEffect 直接包含它。 */
export type ToolEffect = ToolEffectOf<ToolModule>

/** effect 类型 → 对应 handler；由 manifest 生成，避免手写 7 行。 */
export type ToolHandlers = {
  [Module in ToolModule as Module['effectType']]: ReturnType<Module['createHandler']>
}

export function createToolHandlers(ctx: ToolContext): ToolHandlers {
  const entries = toolModules.map(
    (tool) => [tool.effectType, tool.createHandler(ctx)] as const,
  )
  return Object.fromEntries(entries) as ToolHandlers
}

/** 给模型看的 tools schema；顺序与 manifest 一致。 */
export function toolDefinitions(): ToolDefinition[] {
  return toolModules.map((tool) => tool.definition)
}
