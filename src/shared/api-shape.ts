// 契约与 preload 暴露面的一致性检查：纯函数，可在测试里直接验证。
export interface MethodCarrier {
  method: string
}

// 契约里声明的方法，有哪些没有出现在 preload 暴露的 API 上
export function missingMethods(
  contracts: Record<string, MethodCarrier>,
  exposed: readonly string[],
): string[] {
  const expected = new Set(Object.values(contracts).map((contract) => contract.method))
  return [...expected].filter((method) => !exposed.includes(method))
}

// 反向检查：暴露了契约里不存在的方法（拼写错误会在这里暴露）
export function extraMethods(
  contracts: Record<string, MethodCarrier>,
  exposed: readonly string[],
): string[] {
  const expected = new Set(Object.values(contracts).map((contract) => contract.method))
  return exposed.filter((method) => !expected.has(method))
}
