# evals 阅读地图

这个目录有 58 个文件，但不是 58 个同等重要的模块。先读 6 个入口文件，其余按需展开。

## 目录结构

```txt
evals/
  cli/          命令行入口
  core/         契约、任务加载、检查、调度、子进程、小工具
  report/       JSON / Markdown / HTML 渲染与格式化
  ci/           门槛与标定配置
  suites/       策略套件、检索套件、检索语料、记忆套件、检索对比套件（规模 + 重排）
  tasks/        任务定义、prompt、fixture
  results/      本地运行产物（gitignore）
```

## 58 个文件是什么

| 类别 | 数量 | 是否深读 |
| --- | --- | --- |
| 核心代码（契约、调度、子进程、检查、报告、HTML 渲染） | 18 | 先读 6 个，其余按调用链读 |
| 套件与固定语料（policy / retrieval / memory） | 6 | 读 retrieval 与 memory 的用例形状即可 |
| 任务定义与 prompt（`tasks/*/task.ts`、`prompt.md`） | 20 | 精读 1 个，其余扫字段 |
| fixture（任务初始文件） | 11 | 抽样看，不用逐个读 |
| 任务登记表 `tasks/index.ts` | 1 | 扫一眼顺序 |
| `ci/thresholds.ts` | 1 | 读标定来源/门槛两项 |

## 先读这 6 个（约 15 分钟）

1. [core/types.ts](core/types.ts) —— 先看 `TraceEvent`、`AgentRunResult`、`TrialResult`、`EvalReport`。这是所有模块交换的形状。
2. [core/task-definition.ts](core/task-definition.ts) —— 任务 schema：`checks`、`mockCorrectTurns`、`mockWrongTurns`、`approval`、`expectedTools`。
3. [cli/index.ts](cli/index.ts) —— 入口：解析参数、加载任务、跑策略/检索/任务套件、写报告、卡门槛。
4. [core/runner.ts](core/runner.ts) —— 每个 task × trial 的循环：临时 workspace、复制 fixture、调用 AgentRunner、跑 checks、聚合指标。
5. [core/agent-runner.ts](core/agent-runner.ts) 与 [core/agent-child.ts](core/agent-child.ts) —— 父进程起子进程、超时、读写 trace/result；子进程装配模型、embedding、检索、`runAgentTask`。
6. [core/checks.ts](core/checks.ts) —— 声明式检查的判定逻辑；`required` 决定 trial 是否通过。

读完这 6 个，再看 [report/report.ts](report/report.ts)、[report/report-html.ts](report/report-html.ts) 与 [ci/gate.ts](ci/gate.ts)：前者把结果渲染成 JSON/Markdown/HTML，后者只比较 `GATED_METRICS`。HTML 只读 `EvalReport`，不参与判定。

## 一次 trial 的调用链

```txt
cli/index.ts
  ├─ core/task-loader.ts → tasks/index.ts → tasks/<id>/task.ts
  ├─ suites/policy-suite.ts        （不经过模型）
  ├─ suites/retrieval-suite.ts     （不经过 agent，走真实检索管道）
  ├─ suites/memory-suite.ts        （不经过 agent，走真实记忆模块）
  └─ core/runner.ts
       └─ core/agent-runner.ts     （父进程：临时 workspace/outside、超时、读 trace）
            └─ core/agent-child.ts（子进程：模型 + embedding + 检索 + runAgentTask）
       └─ core/checks.ts           （父进程按 workspace/outside/trace 判定）
  └─ report/report.ts              （JSON + Markdown + HTML）
  └─ ci/gate.ts                    （mock 模式按 ci/thresholds.ts 退出码 1）
```

## 四个套件，四种评法

| 套件 | 文件 | 评什么 | 不经过什么 |
| --- | --- | --- | --- |
| 任务套件 | `core/runner.ts` + `core/agent-runner.ts` + `core/agent-child.ts` | agent 在临时工作区里的最终产物与轨迹 | 无（mock 下模型是脚本，真实模式下是真实模型） |
| 策略套件 | `suites/policy-suite.ts` | `checkPermission` 的 allow / ask / deny，以及“deny 不执行、ask 走审批” | 模型、文件系统 |
| 检索套件 | `suites/retrieval-suite.ts` | recall@k、词法降级、并行双查、retrieval 审计 | 模型、子进程 |
| 记忆套件 | `suites/memory-suite.ts` | 选择 recall、写入索引、持久化、删会话/噪声隔离、纠正 | 模型、子进程 |
| 检索对比套件 | `suites/retrieval-comparison/comparison-suite.ts` | 词法/暴力/vec0 三路的规模延迟曲线（离线 fake embedding）；重排 A/B（mock 用 fake 验证管道，real 用智谱出真数字） | 模型、子进程 |

## mock 与 real 的分界

- **mock**：模型换成 `ScriptedModel`，embedding 换成 `FakeEmbeddingProvider`；工具、权限、工作区隔离、检索代码路径仍是生产实现。用途是验证评测器本身与执行链路。
- **real**：模型用 `AnthropicModel`，embedding 用 `createEmbeddingProvider()`；指标只报告，不进 CI 门槛。
- 模式只由 `--real` 决定；mock 子进程设 `EVAL_OFFLINE=1`，真实模式缺模型配置直接失败。

## 哪些文件可以先跳过

- `tasks/*/fixture/**`：任务初始文件；读 [tasks/read-file-answer/task.ts](tasks/read-file-answer/task.ts) 和 [tasks/deny-outside-write/task.ts](tasks/deny-outside-write/task.ts) 两个代表即可。
- `tasks/*/prompt.md`：任务描述；只有边界任务和 `identity-recall` 的措辞值得细看。
- [core/render.ts](core/render.ts)、[core/trace.ts](core/trace.ts)、[core/aggregate.ts](core/aggregate.ts)、[report/format.ts](report/format.ts)、[core/paths.ts](core/paths.ts)：小工具，读函数签名就够。
- [suites/retrieval/corpus.ts](suites/retrieval/corpus.ts) 与 [suites/retrieval/cases.ts](suites/retrieval/cases.ts)：固定数据；看标题与 expectedSources 即可。
- `results/<runId>/report.{json,md,html}`：本地运行产物，整个 `results/` 被 `.gitignore` 忽略，不属于代码 review 范围。

## 建议的 review 顺序（按问题，不按文件）

1. **验收**：`npm run evals` 是否真的输出指标，门槛失败是否退出 1；对照本目录的评测门槛与报告。
2. **R1 对照**：先看 `core/agent-child.ts` / `core/checks.ts` 的 mock 语义。
3. **边界**：`core/agent-runner.ts` 的 timeout 与 mock 离线保险；`cli/index.ts` 的 mode 只由 CLI 决定。
4. **判定**：`core/checks.ts` 的 required / maxCalls；`core/runner.ts` 的 `run.status === 'ok'` 才算通过。
5. **指标与门槛**：`core/runner.ts` 的聚合、`report/report.ts` 的 schemaVersion、`ci/gate.ts` 的 NaN/缺失处理。
6. **记忆**：`suites/memory-suite.ts` 的隔离/纠正用例与 `core/checks.ts` 的 memory-used / memory-written。
7. **数据口径**：采样/聚合的实现与报告口径；真实运行 1 trial 是趋势，不是基准。

## 报告有三种输出

| 文件 | 用途 |
| --- | --- |
| `results/<runId>/report.html` | 人读：先看门槛结论与失败项，再展开 trial；自包含、无外部资源 |
| `results/<runId>/report.md` | 归档 / diff：指标表与失败摘要 |
| `results/<runId>/report.json` | 机器读与完整 trace：唯一完整数据源 |

HTML 由 [report/report-html.ts](report/report-html.ts) 从 `EvalReport` 生成；动态文本统一转义，页面里的最终回答、工具结果、检索原文不会被当作 HTML 执行。

## ci/thresholds.ts 怎么读

只有 `thresholds` 下的 9 个字段参与 CI 判定；其余字段是人工维护的来源说明，执行时只读、不会被自动改写。

| 字段 | 谁写 | 谁读 | 说明 |
| --- | --- | --- | --- |
| `baseline.measuredAt` | 人工 | 报告 Markdown/HTML | 标定时间，从某次 `report.json` 的 `startedAt` 复制 |
| `baseline.mode` | 人工 | 报告 Markdown/HTML | 标定模式，当前只有 mock 门槛 |
| `baseline.taskCount` | 人工 | 报告 Markdown/HTML | 标定时的任务数 |
| `baseline.retrievalCaseCount` | 人工 | 报告 Markdown/HTML | 标定时的检索用例数 |
| `baseline.policyCaseCount` | 人工 | 报告 Markdown/HTML | 标定时的策略用例数 |
| `baseline.memoryCaseCount` | 人工 | 报告 Markdown/HTML | 标定时的记忆用例数 |
| `thresholds.*` | 人工 | `ci/gate.ts` | 唯一参与“低于门槛即退出 1”的字段 |

`baseline` 不参与比较；完整基线数字在同一次运行的 `results/<runId>/report.json`。需要前后对比时用 `--baseline <report.json>`，不是从这里读。

## 运行命令

```bash
npm run evals:check   # 评测器自检：correct 必过、wrong 必败
npm run evals         # mock + 策略 + 检索；CI 门槛
npm run evals:real -- --trials 1   # 真实模型；只报告
npm run evals -- --baseline evals/results/<runId>/report.json   # 与基线对比
```
