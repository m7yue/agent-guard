// 合成语料：规模可参数化的确定性语料，供规模对比（词法 / 暴力 / vec0）用。
//
// 设计约束：
// - 确定性：无随机数，同参数永远生成同语料，延迟与 recall 数字可复现（R12）；
// - 块长 ~500 字符：对齐产品切块参数，让扫描/解码成本与真实语料同量级；
// - 查询带构造目标：每条查询从目标块派生（主题 + 唯一编号），
//   recall@k 的含义是「构造目标是否进 top-k」——它衡量管道保真，
//   不衡量语义质量（那由 会话检索 检索套件在真实 embedding 下评）。
import type { KnowledgeChunkInsert } from '../../../src/harness/store'

/** 主题池：40 个工程话题，块按 i % 40 归入主题（同主题块互为硬干扰） */
const TOPICS = [
  '窗口生命周期', '托盘常驻', '进程隔离', '权限管线', '审计事件', '会话持久化',
  '断点恢复', '崩溃上报', '日志诊断', '启动性能', '内存基线', '打包签名',
  '自动更新', '灰度发布', 'IPC 通道', '契约校验', '预加载桥', '沙箱模型',
  '上下文隔离', '文件系统', '原生模块', 'ABI 兼容', '向量检索', '切块策略',
  '重排序模型', '评测框架', '召回率门槛', '记忆文档', '双层索引', '工具清单',
  '审批等待', '超时退避', '限流重试', '批量嵌入', '余弦相似度', '词法降级',
  '磁盘映像', '更新源', '性能打点', '工作区准备',
] as const

/** 填充句池：中性工程语句，只撑长度不贡献区分度 */
const FILLERS = [
  '这一段先交代背景，再给出结论，方便后续复查。',
  '实现上有两个入口，主进程负责装配，执行器负责执行。',
  '边界情况单独列出来，避免与主流程混在一起。',
  '指标以中位数报告，采样方法写进 limitations。',
  '失败路径只记日志不阻塞，增强动作不改变主流程语义。',
  '跨进程数据一律先校验形状，不假设对面送来的结构。',
  '默认值站在安全一侧，没有人确认就不执行。',
  '同一段文本重放多少次，id 不变，写入零行。',
  '这一版的取舍是显式配置优先，自动推断留到下一版。',
  '量级估算按字符计，精确分词不影响排序结论。',
] as const

/** 单块目标长度（字符）：对齐产品切块的 500 字 */
const TARGET_CHUNK_CHARS = 500

/** 块内唯一的签名句：目标识别的锚点，编号保证块间可区分 */
function toSignature(chunkIndex: number, topic: string): string {
  return `记录编号 ${chunkIndex} 的${topic}要点`
}

/** 块 id 的构造规则；comparison-suite 用它对齐 recall 目标 */
export function toSyntheticChunkId(chunkIndex: number): string {
  return `syn-${chunkIndex}`
}

export interface SyntheticCorpusChunk {
  /** 块 id（syn-<序号>）：recall 目标与 vec0 主键共用 */
  id: string
  text: string
}

export interface SyntheticCorpusQuery {
  /** 查询文本：主题 + 签名，从目标块派生 */
  query: string
  /** 构造目标：这条查询应当命中的块 id */
  targetChunkId: string
}

export interface SyntheticCorpus {
  chunks: SyntheticCorpusChunk[]
  queries: SyntheticCorpusQuery[]
}

/** 会话切分：每 25 块归入一个会话，块序号在会话内续号（对齐产品元数据形状） */
const CHUNKS_PER_CONVERSATION = 25

export function generateSyntheticCorpus(chunkCount: number, queryCount: number): SyntheticCorpus {
  const chunks: SyntheticCorpusChunk[] = []
  for (let index = 0; index < chunkCount; index += 1) {
    const topic = TOPICS[index % TOPICS.length]!
    const parts: string[] = [`${topic}的讨论记录。`, toSignature(index, topic) + '：']
    let fillerPosition = 0
    while (parts.join('').length < TARGET_CHUNK_CHARS) {
      parts.push(FILLERS[(index * 3 + fillerPosition) % FILLERS.length]!)
      fillerPosition += 1
    }
    chunks.push({ id: `syn-${index}`, text: parts.join('') })
  }

  // 查询均匀铺开：目标间隔 chunkCount / queryCount，覆盖整个语料（不同主题、不同会话）
  const queries: SyntheticCorpusQuery[] = []
  for (let index = 0; index < queryCount; index += 1) {
    const targetIndex = Math.min(chunkCount - 1, Math.floor((index * chunkCount) / queryCount))
    const topic = TOPICS[targetIndex % TOPICS.length]!
    queries.push({
      query: `查一下${toSignature(targetIndex, topic)}`,
      targetChunkId: `syn-${targetIndex}`,
    })
  }

  return { chunks, queries }
}

/** 合成块 → store 写入项：会话 id / 标题 / 块序号按上面的切分规则派生 */
export function toSyntheticChunkInserts(
  chunks: SyntheticCorpusChunk[],
  vectors: Float32Array[],
): KnowledgeChunkInsert[] {
  return chunks.map((chunk, index) => {
    const conversationOrdinal = Math.floor(index / CHUNKS_PER_CONVERSATION)
    return {
      id: chunk.id,
      sourceType: 'conversation',
      sourceId: `synthetic-conversation-${conversationOrdinal}`,
      chunkIndex: index % CHUNKS_PER_CONVERSATION,
      title: `合成会话 ${conversationOrdinal}`,
      text: chunk.text,
      tokens: chunk.text.length,
      vector: vectors[index]!,
    }
  })
}
