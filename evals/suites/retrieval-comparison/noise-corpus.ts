// 重排对比的噪声语料：与 会话检索 检索用例的查询共享表面词、但不包含期望答案的会话。
//
// 作用：把候选池从「几块几乎全相关」撑成「相关答案 + 表面相似的干扰」——
// 这是重排才有收益的条件（向量按相似度把干扰也捞进 top-N，重排按相关度精排）。
// 噪声块的期望是「可以进候选池，但不该挤掉期望来源」；recall 判分只看期望来源。
import type { Message } from '../../../src/harness/core/types'
import type { CorpusDocument } from '../retrieval/corpus'

export const RERANK_NOISE_CORPUS: CorpusDocument[] = [
  {
    conversationId: 'conv-noise-favicon-tool',
    title: 'favicon 工具调研',
    messages: [
      { role: 'user', content: '有没有自动生成 favicon 的在线工具？' },
      { role: 'assistant', content: '有，上传图片就能导出多种尺寸的 favicon。' },
    ],
  },
  {
    conversationId: 'conv-noise-favicon-cache',
    title: '浏览器图标缓存',
    messages: [
      { role: 'user', content: '浏览器里 favicon 不刷新怎么办？' },
      { role: 'assistant', content: '清缓存或强刷；多是缓存问题，不是代码问题。' },
    ],
  },
  {
    conversationId: 'conv-noise-svg-library',
    title: 'svg 图标库',
    messages: [
      { role: 'user', content: '哪里能找 svg 图标？' },
      { role: 'assistant', content: '开源图标库很多，按许可证筛选后直接下载。' },
    ],
  },
  {
    conversationId: 'conv-noise-schedule-app',
    title: '日程应用推荐',
    messages: [
      { role: 'user', content: '有什么好用的安排日程的应用？' },
      { role: 'assistant', content: '日历类应用都行，选一个支持提醒的。' },
    ],
  },
  {
    conversationId: 'conv-noise-exercise',
    title: '锻炼装备',
    messages: [
      { role: 'user', content: '下午去锻炼要带什么？' },
      { role: 'assistant', content: '水、毛巾、换洗衣物，天热再加电解质。' },
    ],
  },
  {
    conversationId: 'conv-noise-afternoon-tea',
    title: '下午茶',
    messages: [
      { role: 'user', content: '下午有什么安排？我想喝下午茶' },
      { role: 'assistant', content: '三点以后都有空，楼下新开了家茶馆。' },
    ],
  },
  {
    conversationId: 'conv-noise-meeting-room',
    title: '会议室预订',
    messages: [
      { role: 'user', content: '下午 4 点的会订哪间会议室？' },
      { role: 'assistant', content: '订小会议室就行，那次会人不多。' },
    ],
  },
  {
    conversationId: 'conv-noise-icon-design',
    title: '图标设计规范',
    messages: [
      { role: 'user', content: '应用图标设计有什么讲究？' },
      { role: 'assistant', content: '小尺寸可辨识优先，避免细线条与高密度细节。' },
    ],
  },
]
