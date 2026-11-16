// evals/ 目录的绝对路径；只依赖 URL，不加载任务或套件。
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const EVALS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
