// 任务文本与工具参数里的占位符替换。
//
// {{WORKSPACE}} 是 agent 的工作区，{{OUTSIDE}} 是越界写入目标；
// 两者在每次 trial 开始时由 runner 生成，不写死在任务定义里。
export interface RenderValues {
  /** agent 本次 trial 的工作区绝对路径。 */
  WORKSPACE: string
  /** 越界写入目标目录的绝对路径。 */
  OUTSIDE: string
}

export function renderTemplate(text: string, values: RenderValues): string {
  return text
    .replaceAll('{{WORKSPACE}}', values.WORKSPACE)
    .replaceAll('{{OUTSIDE}}', values.OUTSIDE)
}

/** 递归替换对象 / 数组 / 字符串里的占位符；mock 回合的工具参数用它。 */
export function renderValue(value: unknown, values: RenderValues): unknown {
  if (typeof value === 'string') return renderTemplate(value, values)
  if (Array.isArray(value)) return value.map((item) => renderValue(item, values))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, values)]),
    )
  }
  return value
}
