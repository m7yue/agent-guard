// 记忆选择用的文本模型接口。
//
// 选择 / 读取不需要工具调用，只要一段文本回来；用独立的窄接口而不是直接复用 Model：
// - 评测与测试可以注入脚本模型，不会消费主循环的 ScriptedModel 回合；
// - 将来抽取/合并若要恢复，也复用同一个入口。
import type { Model } from '../core/types'
import { createModel } from '../model'

export interface MemoryTextModel {
  /** 发送一条 user 消息，返回模型文本；signal 用于取消 */
  completeText(prompt: string, options?: { signal?: AbortSignal }): Promise<string>
}

// 选择器需要明确的行为约束；空 system 在部分兼容端点上行为不稳定。
const MEMORY_SYSTEM_PROMPT =
  '你是一个记忆选择器。只根据用户给出的记忆目录与当前对话返回 JSON 整数数组，不要解释。'

/**
 * 输入：一个完整的 Model（提供 complete()）。
 * 输出：MemoryTextModel，只有 completeText(prompt, { signal? }) -> Promise<string>。
 *
 * 适配器内部固定 system = MEMORY_SYSTEM_PROMPT、messages = 一条 user(prompt)、
 * tools = []，返回 turn.content；解析、选记忆、降级都不属于这个函数。
 *
 * @example
 * const textModel: MemoryTextModel = createMemoryTextModel(model)
 * const raw: string = await textModel.completeText([
 *   '下面是当前对话与记忆目录。选出与当前对话明确相关的记忆下标。',
 *   '只返回一个 JSON 整数数组，例如 [0, 3]；没有相关记忆返回 []。',
 *   '不要解释，不要输出数组以外的内容。',
 *   '',
 *   '当前对话：我叫什么？favicon 方案是什么？',
 *   '',
 *   '记忆目录：',
 *   '0: user-name — 用户的名字/称呼',
 *   '1: editor-preference — 编辑器偏好',
 *   '2: favicon-scheme-svg — favicon 方案',
 * ].join('\n'))
 * // 一种可能的返回：'[0, 2]'。模型也可能返回 '[0,2]'、'[ 0, 2 ]' 或坏 JSON；
 * // 适配器只透传文本，解析、越界过滤与降级由 memory-selector 负责。
 */
export function createMemoryTextModel(model: Model): MemoryTextModel {
  return {
    async completeText(prompt, options = {}) {
      const turn = await model.complete({
        system: MEMORY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        signal: options.signal,
      })
      return turn.content
    },
  }
}

/**
 * 生产环境的默认选择器。
 *
 * 只有真实模型配置存在时才返回；零配置启动时 createModel() 给的是演示脚本
 * （ScriptedModel），拿它做记忆选择会返回与记忆无关的演示回合。
 * 返回 null 时选择器直接走向量降级——目录仍然常驻，功能不消失。
 */
export function createMemorySelectorModel(): MemoryTextModel | null {
  const model = createModel()
  if (model.mode !== 'real') return null
  return createMemoryTextModel(model)
}
