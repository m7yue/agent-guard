// 工具执行的两个公共函数：
// - withToolErrors：把工具实现包成 effect handler，并翻译 zod 错误；
// - toToolErrorMessage：把失败原因压成给模型看的单行文本。
//
// 这里不做名字查找；工具名与实现由各工具模块自己的 createHandler 绑定。
import { ZodError } from 'zod'
import { formatZodIssues } from '../../shared/zod'
import type { Effect, EffectHandler } from '../core/effects'

export function withToolErrors<Type extends string>(
  name: string,
  run: (input: Record<string, unknown>) => Promise<string>,
): EffectHandler<Effect<Type, Record<string, unknown>, string>> {
  return async (effect) => {
    try {
      return await run(effect.input)
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(`工具 ${name} 入参不合法，${formatZodIssues(error)}`)
      }
      throw error
    }
  }
}

/** 只给模型看错误原因：单行、截断，不带 stack。 */
export function toToolErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/\s+/g, ' ').trim() || '未知错误'
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}
