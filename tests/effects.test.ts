import { describe, expect, it } from 'vitest'
import { runEffects } from '../src/harness/core/effects'
import type { Effect, Perform } from '../src/harness/core/effects'

type Ping = Effect<'Ping', { n: number }, number>
type Boom = Effect<'Boom', Record<string, never>, never>
type TestEffect = Ping | Boom

describe('runEffects', () => {
  it('把 handler 的返回值注回 generator', async () => {
    function* program(perform: Perform<TestEffect>): Generator<TestEffect, number, unknown> {
      const a = yield* perform({ type: 'Ping', input: { n: 1 } })
      const b = yield* perform({ type: 'Ping', input: { n: a + 1 } })
      return b
    }

    // n=1 → 10；第二次传 11 → 110
    const result = await runEffects(program, {
      Ping: (effect) => effect.input.n * 10,
      Boom: () => {
        throw new Error('unused')
      },
    })
    expect(result).toBe(110)
  })

  it('handler 抛错时把错误注回 generator', async () => {
    function* program(perform: Perform<TestEffect>): Generator<TestEffect, string, unknown> {
      try {
        yield* perform({ type: 'Boom', input: {} })
        return 'no-error'
      } catch (error) {
        return `caught:${(error as Error).message}`
      }
    }

    const result = await runEffects(program, {
      Ping: (effect) => effect.input.n,
      Boom: () => {
        throw new Error('boom')
      },
    })
    expect(result).toBe('caught:boom')
  })

  it('handler 抛错后 generator 在 catch 内 yield 的新效应会被执行', async () => {
    const calls: number[] = []
    function* program(perform: Perform<TestEffect>): Generator<TestEffect, number, unknown> {
      try {
        yield* perform({ type: 'Ping', input: { n: 1 } })
        return 0
      } catch {
        return yield* perform({ type: 'Ping', input: { n: 2 } })
      }
    }

    const result = await runEffects(program, {
      Ping: (effect) => {
        calls.push(effect.input.n)
        if (effect.input.n === 1) throw new Error('flaky')
        return effect.input.n * 10
      },
      Boom: () => {
        throw new Error('unused')
      },
    })
    expect(result).toBe(20)
    expect(calls).toEqual([1, 2])
  })
})
