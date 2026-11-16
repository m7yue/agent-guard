import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// 架构守卫：这几条一旦破，后面就再也拆不回去了
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function sources(dir: string): string[] {
  return walk(join(process.cwd(), dir)).filter((file) => /\.tsx?$/.test(file))
}

const ELECTRON = /from ['"]electron['"]/
const HARNESS = /from ['"][^'"]*harness\//
const NODE_BUILTIN = /from ['"](node:|fs|path|os|child_process)/

describe('模块边界', () => {
  it('harness 层不依赖 Electron', () => {
    for (const file of sources('src/harness')) {
      expect(readFileSync(file, 'utf8'), `${file} 不应依赖 electron`).not.toMatch(ELECTRON)
    }
  })

  it('shared 层只放契约：不依赖 Electron，也不依赖 harness', () => {
    for (const file of sources('src/shared')) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} 不应依赖 electron`).not.toMatch(ELECTRON)
      expect(source, `${file} 不应依赖 harness`).not.toMatch(HARNESS)
    }
  })

  it('renderer 不碰 harness 与 Node 内置模块', () => {
    for (const file of sources('src/renderer')) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} 不应依赖 harness`).not.toMatch(HARNESS)
      expect(source, `${file} 不应依赖 Node 内置模块`).not.toMatch(NODE_BUILTIN)
    }
  })
})
