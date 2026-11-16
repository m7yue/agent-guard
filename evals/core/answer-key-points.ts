// 答案要点命中率：最终回答里出现了多少个 expectKeywords。
//
// 只做字面包含判断，不理解同义表达；这是确定性指标，
// 真实模型的能力判断还要结合工具选择、引用与人工复核。
export interface AnswerKeyPointScore {
  /** 命中的关键词数。 */
  hit: number
  /** 关键词总数。 */
  total: number
  /** hit / total；没有关键词时为 0。 */
  hitRate: number
  /** 未命中的关键词。 */
  missing: string[]
}

export function scoreAnswerKeyPoints(answer: string, keyPoints: string[]): AnswerKeyPointScore {
  const normalizedAnswer = answer.toLowerCase()
  const missing = keyPoints.filter((point) => !normalizedAnswer.includes(point.toLowerCase()))
  const hit = keyPoints.length - missing.length
  return {
    hit,
    total: keyPoints.length,
    hitRate: keyPoints.length === 0 ? 0 : hit / keyPoints.length,
    missing,
  }
}
