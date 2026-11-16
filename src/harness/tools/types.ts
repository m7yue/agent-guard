// 工具的公共约定：工具执行时需要的能力上下文。
//
// 工具 effect 的声明在各自工具模块里（类型名 PascalCase）；模型看到的工具名是
// snake_case，两者在 agentLoop 的 switch 里显式对应。manifest 负责聚合定义与 handler。
import type { ConversationSearchOutcome } from '../knowledge/searcher'
import type { MemoryRuntime } from '../memory/runtime'

export interface ToolContext {
  /** 工具只能在这个目录内读写；越界一律拒绝 */
  workspaceRoot: string
  /** 跨会话历史检索（执行器按 run 绑定审计上下文后注入） */
  searchConversationHistory: (query: string, topK: number) => Promise<ConversationSearchOutcome>
  /** 记忆能力；未配置时用 NO_MEMORY 空实现 */
  memory: MemoryRuntime
}
