// 更新状态的形状与推送通道（主进程 → 渲染进程）。
//
// 更新是一个长过程：检查 → 下载 → 待重启。每一步都要让用户看见，
// 所以用"状态推送"而不是一次性的请求响应。
// channel 常量的唯一定义在 channels.ts（那里零依赖，preload 可以直接引）
import { PUSH_CHANNELS } from './channels'
export const UPDATE_CHANNEL = PUSH_CHANNELS.updateStatus

export type UpdateStatus =
  | { phase: 'idle' } // 还没检查
  | { phase: 'checking' } // 正在请求 feed
  | { phase: 'available'; version: string } // 有新版本
  | { phase: 'not-available'; version: string } // 已是最新
  | { phase: 'downloading'; percent: number } // 下载中，percent 为 0–100
  | { phase: 'downloaded'; version: string } // 下载完成，等待重启
  | { phase: 'error'; message: string } // 出错
  | { phase: 'unavailable'; message: string } // 未启用（开发态或未配置更新源）
