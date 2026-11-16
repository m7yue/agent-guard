// 固定检索语料（corpus）：评测用的一组固定文本；这里是短会话，每篇 < 500 字，切块后每个会话只有 #0。
//
// 语料刻意包含三类干扰：
// - 「寒暄」里的 7yue 会与日程查询共享专有名词；
// - 「无相关记录」会与 favicon 查询共享字面词；
// - 「托盘菜单」「向量检索笔记」是无关但可能被词法命中的噪声。
import type { Message } from '../../../src/harness/core/types'

export interface CorpusDocument {
  /** 会话 UUID，写入 chunks.source_id。 */
  conversationId: string
  /** 引用来源的展示名，写入 chunks.title。 */
  title: string
  /** 会话语料；索引时只取其中的 text 块。 */
  messages: Message[]
}

export const RETRIEVAL_CORPUS: CorpusDocument[] = [
  {
    conversationId: 'conv-favicon',
    title: 'favicon 方案讨论',
    messages: [
      { role: 'user', content: 'favicon 用什么方案？' },
      { role: 'assistant', content: '建议用 svg：缩放不失真、文件小，暗色模式还能换色。' },
    ],
  },
  {
    conversationId: 'conv-schedule',
    title: '下午的安排',
    messages: [
      { role: 'user', content: '7yue 下午有什么安排？' },
      { role: 'assistant', content: '7yue 下午 3 点去锻炼，4 点回来开会。' },
    ],
  },
  {
    conversationId: 'conv-greeting',
    title: '寒暄',
    messages: [
      { role: 'user', content: '我是 7yue。' },
      { role: 'assistant', content: '你好，7yue！' },
    ],
  },
  {
    conversationId: 'conv-noise',
    title: '无相关记录',
    messages: [
      { role: 'user', content: '之前有没有记录过 favicon 方案？' },
      { role: 'assistant', content: '历史会话里没有相关记录。' },
    ],
  },
  {
    conversationId: 'conv-tray',
    title: '托盘菜单',
    messages: [
      { role: 'user', content: '托盘菜单怎么实现？' },
      { role: 'assistant', content: '用 Tray + Menu.buildFromTemplate，退出项调用 app.quit。' },
    ],
  },
  {
    conversationId: 'conv-vector',
    title: '向量检索笔记',
    messages: [
      { role: 'user', content: '向量检索怎么算相似度？' },
      { role: 'assistant', content: '用余弦相似度比较查询向量与块向量，越大越相关。' },
    ],
  },
]
