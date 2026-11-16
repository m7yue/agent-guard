// 切块：把一篇文档切成可被 embedding 的等长段。
//
// 输入是"带元数据的文档"而不是裸字符串——元数据（来源类型、来源 id、标题）
// 由调用方负责（会话索引在 conversation-documents.ts，记忆 的记忆索引同理），
// 切块只管文本本身。
//
// 参数可配置（默认 500 字 / 80 重叠），不写死：评测 要对比不同切块策略。
// 算法是纯字符滑窗——中文按"字"切是自然单位；句界感知的切块留给 评测 对比时再加。

export interface ChunkOptions {
  /** 每块的目标长度（字符数） */
  chunkSize: number
  /** 相邻块的重叠长度（字符数），必须小于 chunkSize */
  overlap: number
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { chunkSize: 500, overlap: 80 }

export interface TextChunk {
  /** 块在本文档内的序号（从 0 开始；跨文档的全局序号由索引器续号） */
  chunkIndex: number
  text: string
}

export function chunkText(text: string, options: Partial<ChunkOptions> = {}): TextChunk[] {
  const { chunkSize, overlap } = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  if (overlap >= chunkSize) {
    throw new Error(`切块参数不合法：overlap(${overlap}) 必须小于 chunkSize(${chunkSize})`)
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const chunks: TextChunk[] = []
  let start = 0
  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length)
    chunks.push({ chunkIndex: chunks.length, text: trimmed.slice(start, end) })
    // 走到文末就收；步长 = chunkSize - overlap > 0，不会死循环
    if (end === trimmed.length) break
    start += chunkSize - overlap
  }
  return chunks
}
