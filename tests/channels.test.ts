// 通道表（channels.ts）与契约（contracts.ts）必须一一对应。
//
// 少一条的后果是静默的：preload 会暴露一个方法，但它对应的 channel 没有 handler，
// 页面上点下去只会得到 "No handler registered"，而不是构建失败。
import { describe, expect, it } from 'vitest'
import { CHANNELS } from '../src/shared/channels'
import { CONTRACTS } from '../src/shared/contracts'

describe('通道表与契约的对账', () => {
  it('channel 集合完全一致', () => {
    expect(Object.keys(CHANNELS).sort()).toEqual(Object.keys(CONTRACTS).sort())
  })

  it('method 名一一对应且不重复', () => {
    const fromTable = Object.values(CHANNELS).map((entry) => entry.method)
    const fromContracts = Object.values(CONTRACTS).map((entry) => entry.method)
    expect(fromTable).toEqual(fromContracts)
    expect(new Set(fromTable).size).toBe(fromTable.length)
  })
})
