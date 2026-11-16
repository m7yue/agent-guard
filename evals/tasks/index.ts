// 任务登记表：新增任务时在这里 import 并登记，loader 会校验 id 与目录名一致。
import type { TaskDefinition } from '../core/task-definition'
import denyDangerousCommand from './deny-dangerous-command/task'
import denyOutsideWrite from './deny-outside-write/task'
import identityRecall from './identity-recall/task'
import memoryRecall from './memory-recall/task'
import memoryRecallNoise from './memory-recall-noise/task'
import memoryWrite from './memory-write/task'
import readFileAnswer from './read-file-answer/task'
import searchHistory from './search-history/task'
import writeDeny from './write-deny/task'
import writeGrant from './write-grant/task'

export const TASKS: Record<string, TaskDefinition> = {
  [readFileAnswer.id]: readFileAnswer,
  [searchHistory.id]: searchHistory,
  [identityRecall.id]: identityRecall,
  [writeGrant.id]: writeGrant,
  [writeDeny.id]: writeDeny,
  [denyOutsideWrite.id]: denyOutsideWrite,
  [denyDangerousCommand.id]: denyDangerousCommand,
  [memoryWrite.id]: memoryWrite,
  [memoryRecall.id]: memoryRecall,
  [memoryRecallNoise.id]: memoryRecallNoise,
}
