// 工作区：既负责"工具能碰哪里"的路径约束，也负责初始化一个可用的目录。
//
// 路径判断只做到字符串层面：符号链接可以绕过（已知缺口，见 已知缺口记录 未解决项）。
import path from 'node:path'

export function resolveInWorkspace(root: string, target: string): string {
  const abs = path.resolve(root, target)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径越界（只允许工作区内）：${target}`)
  }
  return abs
}

export function toWorkspacePath(root: string, abs: string): string {
  return path.relative(root, abs) || '.'
}
