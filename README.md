# DSH Discussion Mode

一个独立维护的 DeepSeek Harness（DSH）插件，基于已发布的 DSH `0.1.0-rc.6` 公共接口构建。安装后输入 `/discussion`，当前对话就进入更专注、更可持续的讨论模式：模型从上下文提炼主题与目标，持续记住用户约束、当前焦点、已比较方案与证据、被否定方向和下一步，并在每次实质性回复前把讨论状态写入工作区，主动收敛到可执行结论。

Discussion Mode 是**插件内部的服务与状态**（档位 `1=fast | 2=default | 3=deep`，由本插件定义与解析），不是 DSH 的全局模式枚举；插件不修改 DSH 主仓，也不向会话日志写入任何自定义事件。

## 安装与使用

```sh
dsh plugin --profile web add @jinplu/dsh-plugin-discussion-intent
```

启动 DSH 后输入：

```text
/discussion [1=fast | 2=default | 3=deep | off]
```

- `/discussion`：开始 Discussion Mode；新讨论默认 `2=default`，恢复已有讨论时保留上次档位。
- `/discussion 1`：快速讨论——简洁取舍，尽快形成可执行答案。
- `/discussion 2`：标准讨论——比较主要方案与证据，主动发现偏题并收敛。
- `/discussion 3`：深度讨论——从第一性原理拆解，核对强先验，管理假设、分支与反例。
- `/discussion off`：暂时退出；讨论状态与落盘记录保留，之后可继续。

不需要在命令后写 topic。模型结合当前会话先提炼**暂定主题和目标**，再随着讨论修正；如果真正缺少的是你的偏好、边界或方向选择，模型用 DSH 原生 `ask_user_question` 一次问清，能检索或推理的事实不反问用户。

## 讨论状态与四行 Rail

插件维护一份紧凑的、随讨论推进的私有状态：

- 目标与模型提炼的暂定主题；
- 用户明确说过的约束和偏好（保留原话与来源，模型重述与原话严格分离）；
- 当前焦点问题、所在层级、完成后要回到哪里；
- 已比较的方案、证据、被否定方向；
- 当前理解、建议、下一步和简短历史摘要。

Web profile 会在输入框上方显示四行只读 Rail（`Focus / You / Understanding / Next`，中文界面显示 `当前焦点 / 你明确说过 / 当前理解 / 下一步`）。Rail 通过插件注册的 HTTP/SSE 通道实时刷新，只用于快速校准，不要求用户维护表单；`/discussion off` 后 Rail 立即消失，重新开始或恢复讨论时重新出现。

## 自动落盘与重启恢复

每次实质性更新都会在继续回复**之前**写入当前工作区：

```text
.dsh/discussions/<session-id>.json   权威状态（插件私有侧车文件）
.dsh/discussions/<session-id>.md     人类可读的讨论检查点
```

Markdown 先写入（原子替换），JSON 侧车随后落盘。写入失败会明确报告保存错误，不会让用户误以为讨论已经持久化。插件不会写入自定义 DSH 会话事件或改变日志格式；激活时只写入一条标准 plugin notice 来唤醒模型。DSH 完全退出、重启并重新打开同一会话后，讨论状态从侧车恢复，`/discussion`、`discussion_update` 工具、系统提示策略与 Web Rail 都能看到同一份恢复后的状态。

## 设计边界

```text
/discussion
  → 模型提炼主题与目标
  → 每次实质回复前更新讨论状态（先写 Markdown，再写 JSON）
  → 系统提示策略 + Web Rail（HTTP 快照 / SSE 推送）
  → 完全退出 DSH 后从侧车恢复
  → 继续讨论或 /discussion off
```

插件只依赖已发布的 DSH `0.1.0-rc.6` 公共接口：`commands`、`sessions`、`systemPrompt`、`tools`、`invariants`，以及 web profile 中可选的 `webServer`（用于 Rail 通道）。没有 `webServer` 的 headless/TUI profile 下功能完整、只是没有 Rail。实现细节见 [Runtime integration](docs/EXTRACTION.md)，交付状态见 [Roadmap](docs/ROADMAP.md)。

## 本地开发

需要 Node.js 22+ 和 package.json 指定的 pnpm 版本。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm test:consumer
```

`test:consumer` 把真实 tarball 安装进全新临时 DSH profile（默认使用 `pnpm dlx @deepseek-ai/dsh@0.1.0-rc.6`，可用 `DSH_SMOKE_DSH_REPO`/`DSH_SMOKE_DSH_VERSION` 覆盖），验收：配置 dump、实际启动、`/discussion` 命令、`discussion_update` 工具、Markdown/JSON 落盘、客户端 Rail bundle 与页面注入、HTTP 状态快照与 SSE 推送、完整停止 → 二次启动 → 恢复同一会话并继续更新。

## Contributing

参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 说明报告。
