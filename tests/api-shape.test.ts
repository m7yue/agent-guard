import { describe, expect, it } from 'vitest'
import { extraMethods, missingMethods } from '../src/shared/api-shape'
import { CONTRACTS } from '../src/shared/contracts'

const contracts = { 'app:a': { method: 'a' }, 'app:b': { method: 'b' } }

describe('preload 暴露面自检', () => {
  it('找出契约里缺失的方法', () => {
    expect(missingMethods(contracts, ['a'])).toEqual(['b'])
  })

  it('找出契约里不存在的方法', () => {
    expect(extraMethods(contracts, ['a', 'b', 'c'])).toEqual(['c'])
  })

  it('真实契约的方法名互不重复', () => {
    const methods = Object.values(CONTRACTS).map((contract) => contract.method)
    expect(new Set(methods).size).toBe(methods.length)
  })
})
