# Runtime integration

> **产品定位：单场复杂讨论的意图校准与防漂移控制层，不是通用长期记忆，也不是一次性的需求问答。**

本插件对用户表现为 DSH 中多出的一个 Discussion Mode：它把用户明确的目标、边界与否定项，同模型的暂定理解、方案证据和下一步分开维护，让新信息参与比较而不悄悄改题。所有能力都基于已发布的 DSH `0.1.0-rc.6` 公共接口；插件不修改 DSH 主仓，也不向会话日志写入任何自定义事件。

## v1.1 插件边界

插件对外仍是一个普通 DSH 插件；新增的 `@jinplu/dsh-plugin-discussion-intent/capabilities` 导出只是可验证的能力声明，不宣称当前 DSH 已经在运行时执行 capability policy。所有 DSH Host / Client 调用集中在命名 adapter，领域契约与侧车存储不直接依赖 DSH；测试会阻止该边界被无意绕过。

讨论检查点只有一个落盘路径：`src/sidecar.ts`。配置目录必须相对于 session workspace，绝对路径、父目录越界和非文件名安全的 session id 会在接触文件系统前失败。

## 最小运行闭环

| 部分 | 作用 | 用户可见结果 |
| --- | --- | --- |
| `/discussion` 命令 | 开始、切换强度、退出或恢复讨论 | `/discussion [1=fast | 2=default | 3=deep]` 与 `/discussion off` |
| Discussion policy | 系统提示策略段，根据档位约束模型的讨论方法 | 模型提炼主题、守住目标，并在合适时收敛 |
| `discussion_update` | 在实质回复前更新紧凑状态 | 约束、焦点、证据、结论和下一步不会随上下文漂移 |
| 插件侧车文件 | 让讨论可续、过程可查的权威状态（JSON）与可读检查点（Markdown） | `.dsh/discussions/<session-id>.json` / `.md` |
| Web Rail 通道 | 插件通过 `webServer` 注册的 HTTP 快照 + SSE 推送 | 四行只读 Rail 实时对应当前会话状态 |
| 四行 Rail | 只读呈现 Focus / You / Understanding / Next | 用户一眼发现偏题或误解 |

## 使用的 DSH 公共接口（rc.6）

- `commands`：注册 `/discussion` 命令；裸命令默认 `2=default`，恢复已有讨论时保留上次档位。
- `sessions` + `sessionPersistence`：按 `session.header.cwd` 定位工作区，按 session id 定位侧车文件；不依赖任何会话事件扩展。
- `systemPrompt`：注册 `discussion-intent:policy` 策略段；只在 `state.active === true` 时输出内容，`/discussion off` 后立即消失。
- `tools`：注册 `discussion_update`，携带 `expectedRevision` 乐观锁与完整 schema；直接引用用户原话必须能绑定同会话直接用户消息，模型重述与原话严格分离。
- `invariants`：启动时与 `session/created` 时校验活动会话的侧车 JSON；损坏的侧车按契约违规明确报错并给出可删除重置的文件名。
- `webServer`（可选，web profile 提供）：注册前缀路由 `/dsh/discussion-intent`，`/state` 返回 JSON 快照（无状态时返回 `{ "active": false }`，HTTP 200，避免 EventSource 重连风暴），`/events` 提供 SSE 推送。没有 `webServer` 的 profile 下命令、工具、策略与落盘不受影响，只是没有 Rail。

## 状态保持什么

运行时只保持服务于有效讨论的信息：

- 暂定主题、目标和讨论强度；
- 有原话依据的用户约束与偏好（`statement` 恒等于来源消息中的原文片段）；
- 当前焦点、问题层级和返回点；
- 候选方案、关键证据、状态与否定理由；
- 当前理解、建议、开放问题和下一步；
- 简短的关键转折历史与保存状态。

用户无需管理这些字段。它们由模型从对话中维护，目的是防止遗忘、重复和偏离，而不是为讨论增加审批流程。

## 深度讨论原则

`3=deep` 应同时做到：

1. 从第一性原理说明问题真正受哪些约束；
2. 站在现有最佳理论、实践和开源工作的肩膀上，而不是重复已有方案；
3. 区分事实、假设、用户偏好和模型推断；
4. 保留被否定方向及理由，避免兜圈子；
5. 管理临时分支并回到主问题，最终形成有证据、有创新价值、可执行的判断。

讨论深度不是无限展开。没有新增信息价值的分支应及时停止。

## 持久化与恢复语义

- 每次实质性更新**先**原子写入 Markdown 检查点，再写入 JSON 侧车（tmp + rename）；JSON 侧车是权威状态，Markdown 是人读检查点。
- 每个消费者（命令、工具、策略段、Rail 端点）按需从侧车读取，并用 mtime 缓存与进程内回退（取较高 revision）保证一致性；因此 DSH 完全退出、重启并重新打开同一会话即可完整恢复。
- 没有工作区路径的会话仍然可以在进程内工作，但写入失败会以明确的保存错误呈现在状态与 Rail 中。
- `/discussion off` 保留文件与状态；恢复讨论沿用已有状态并递增 revision。

## 已明确不采用的上游机制

- 会话投影（rc.6 的事件驱动注册表没有公开 setter，无法由插件推送状态）；
- ApiProxy 的 events 域（只透传会话事件与固定帧类型）；
- 自定义会话事件（rc.6 重载会拒绝未知事件类型，且插件无法设置信封 ignorable 标记）；
- DSH 全局 Work Mode 枚举（Discussion Mode 是插件内部服务，不触碰全局定义）。
