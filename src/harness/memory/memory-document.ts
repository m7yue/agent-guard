// 记忆文档：结构化字段的文本化。
//
// 落盘形态是 memories 表的列（name / description / type / body）；
// frontmatter 只是喂给模型与工具时的渲染形态——参照项目 记忆选择 用文件存 frontmatter，
// 我们的状态在 SQLite 里，列与渲染分开，索引与更新不需要解析文本。
//
// 两层索引的文本层：
// - 目录（toMemoryIndexText）：name + type + description，常驻 system prompt，约 20 token/条；
// - 正文（toMemoryMarkdown）：选中后按需加载，带 frontmatter，模型能看清字段。
import type { MemoryDocument } from '../store'

/** 记忆在 chunks 表里的 source_type；与会话语料分开，检索互不混排名 */
export { MEMORY_SOURCE_TYPE } from '../../shared/memory'

/** 目录：常驻 system prompt 的第一层索引；空库返回空串（调用方据此不注入） */
export function toMemoryIndexText(memories: MemoryDocument[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(
    (memory) => `- ${memory.name} [${memory.type}] — ${toSingleLine(memory.description)}`,
  )
  return ['记忆目录：', ...lines].join('\n')
}

/** 正文：选中的记忆注入 system，read_memory 工具也返回这个形态 */
export function toMemoryMarkdown(memory: MemoryDocument): string {
  return [
    '---',
    `name: ${toSingleLine(memory.name)}`,
    `description: ${toSingleLine(memory.description)}`,
    `type: ${memory.type}`,
    '---',
    '',
    memory.body.trim(),
  ].join('\n')
}

/** 本次注入的相关记忆块；标题里的 `记忆:name` 就是回答的引用格式 */
export function toMemoryRelevantText(memories: MemoryDocument[]): string {
  if (memories.length === 0) return ''
  const parts = ['<relevant_memories>']
  for (const memory of memories) {
    parts.push(`## 记忆:${memory.name}`, toMemoryMarkdown(memory))
  }
  parts.push('</relevant_memories>')
  return parts.join('\n\n')
}

/**
 * frontmatter 是一行一个键，值里的换行会把后面的行挤成无效行。
 * 落盘前把 name / description 折成单行；正文允许换行。
 */
export function toSingleLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
}
