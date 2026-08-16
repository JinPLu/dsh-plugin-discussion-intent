# Runtime integration

> **单场复杂讨论的意图校准与防漂移控制层。**

基于已发布的 DSH `0.1.0-rc.6` 公共接口。不改 DSH 主仓，不写自定义会话事件。

## 插件边界

- `@jinplu/dsh-plugin-discussion-intent/capabilities` 只是可验证声明，不宣称宿主已执行 capability policy。
- Host / Client 调用集中在命名 adapter；领域契约与侧车不直接依赖 DSH。
- 唯一落盘路径：`src/sidecar.ts`。目录相对 session workspace。

## 子代理模型

选择一开始为空，存在 `discussion-intent` settings 段。在顶栏芯片或 `/discussion model` 写入，不在对话里用 `ask_user_question` 选模。未选就 spawn 会失败并提示去选，不继承父线程。之后记住选择；显式 `request.agentOptions` 优先。Rail 顶栏显示该选择的短 model 名与 `resolveCallConfig` 物化的 effort；未选只写 `子代理 未选`，不写 `default`。`subagent/start` / `subagent/end` 可把芯片加上 `进行中`。该 overlay 只在 HTTP/SSE 快照上，不写入侧车。旧线程里未答完的选模问卷仍跳过，不写成 You。

## 最小运行闭环

| 部分 | 作用 | 用户可见结果 |
| --- | --- | --- |
| `/discussion` 命令 | 开始、切换强度、选子代理模型、退出或恢复 | `/discussion [1=fast | 2=default | 3=deep]`、`/discussion model [<provider>/<id>]` 与 `/discussion off` |
| Discussion policy | 按档位约束讨论方法 | 不推断主题；守住否定与决定 |
| `discussion_update` | 实质回复前更新状态 | 理解可写；建议 / 下一步 / favored 不得与有效否定矛盾；合格 `returnTo` 下沉工作焦点，改根问题仍 Pending |
| 侧车文件 | 权威 JSON + 可读 Markdown | `.dsh/discussions/<session-id>.json` / `.md` |
| Web Rail | `webServer` 上的 HTTP 快照 + SSE | 空闲四行，Pending 时五行；值列默认两行，点一行展开；顶栏芯片列出 catalog 并 POST 选模 |

## 使用的 DSH 公共接口（rc.6）

- `commands`：注册 `/discussion`；裸命令默认 `2=default`。
- `sessions` + `sessionPersistence`：按 workspace 与 session id 定位侧车。
- `systemPrompt`：`discussion-intent:policy` 仅在讨论 active 时输出。
- `tools`：`discussion_update`，带 `expectedRevision`；原话必须绑定同会话用户消息，或同会话 `ask_user_question` 的 option label / custom。
- `invariants`：启动与 `session/created` 时校验侧车；损坏则明确报错。
- `webServer`（可选）：`/dsh/discussion-intent/state`、`/events`、`GET /models`、`POST /subagent`。无 `webServer` 时其余功能完整，只是没有 Rail。
- `subagents` + `llm` + `settings`（可选）：子代理模型由芯片或 `/discussion model` 写入 settings；未选 spawn 失败。
- `subagents`（可选）：wrap 公开 `start` / `startContinuable`。无此服务时其余功能完整。
- `userQuestions`（可选）：wrap `ask`；Discussion active 且问题 id 不是子代理选模问卷时，把答案写成 decision。不包装 DSH 主仓 `ask_user_question` 源码。

## 状态与持久化

运行时只保留讨论所需字段：强度、Human Frame、工作焦点、根问题、Pending、候选与证据、理解 / 建议 / 下一步、简短历史。旧侧车缺 `rootFocus` 时复制当时的 `focus`，以免丢掉已锁定的根问题。

- 实质更新先写 Markdown，再写 JSON（tmp + rename）。JSON 是权威状态。
- 各消费者按需读侧车；mtime 缓存与进程内回退取较高 revision。
- `/discussion off` 保留文件；恢复时沿用状态并递增 revision。
- 无工作区路径仍可进程内工作；写入失败会在状态与 Rail 中报错。

## 深度讨论原则

`3=deep` 应同时做到：从第一性原理说明约束；站在已有最佳工作上前进；区分事实、假设、偏好和推断；保留被否定方向；管好分支并回到主问题。

## 不采用的上游机制

- 会话投影（rc.6 无公开 setter）
- ApiProxy events 域
- 自定义会话事件（rc.6 会拒绝未知类型）
- DSH 全局 Work Mode 枚举
