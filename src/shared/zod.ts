// 统一的 zod 错误摘要：契约校验与工具入参校验共用一份，避免两处格式漂移。
import type { z } from 'zod'

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
    .join('; ')
}
