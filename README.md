# DSH Discussion Mode

> **为复杂思考设计的 DSH 讨论模式：保持用户意图、控制讨论焦点，把探索收敛成有依据的下一步。**

<p align="center">
  <a href="#core">核心卖点</a> ·
  <a href="#quick-start">快速开始</a> ·
  <a href="#rail">四行 Rail</a> ·
  <a href="#continuity">讨论可续</a> ·
  <a href="#boundaries">设计边界</a>
</p>

<p align="center">
  <img src="docs/assets/discussion-mode-map-v2.png" width="960" alt="DSH Discussion Mode 防漂移导图：用户目标、边界与当前焦点始终处于中心；用户原话和模型理解分开呈现，新方案与证据参与比较，Rail 和自动检查点让讨论持续校准并可恢复">
</p>

<p align="center"><sub>概念导图：图中文字对应实际产品能力，不代表 DSH 界面截图。</sub></p>

Discussion Mode 让你守住目标、边界和评价标准；模型负责拆解、比较和收敛。`/discussion` 只设深度，不装主题。下一句才开始讨论。你明确说过的话和模型理解分开呈现；改根问题必须 `/discussion accept`，工作焦点可以随讨论下沉；问卷选择算你说过的话。适合研究方向、产品策略、技术路线和跨方案取舍。

<a id="core"></a>

## ✨ 核心卖点

- **意图不漂移**：目标、边界、评价标准和否定项持续注入。根问题须你接受才改；工作焦点可下沉。问卷选择算你说过的话。新证据先当候选。建议和下一步不得与仍有效的否定矛盾。
- **子代理模型自选**：点顶栏芯片或 `/discussion model` 从当前 catalog 选择并记住。未选就 spawn 会失败。父线程模型不变。
- **从模糊到可执行**：不必先填主题。`/discussion 1|2|3` 只设深度。改题须你接受。
- **四行 Rail 随时纠偏**：`当前焦点 / 你明确说过 / 当前理解 / 下一步`。顶栏显示讨论强度和当前子代理 model · effort。Pending 时多一行，直接 accept/reject。
- **讨论可续**：检查点写入工作区，重启可恢复。保存失败会提示。

## 🧭 为什么不是普通聊天或长记忆

| 普通 AI 对话 | Discussion Mode |
| --- | --- |
| 模型可能按最近的信息重述问题 | 用户明确的目标、边界、否定项与评价标准持续作为讨论依据 |
| 模型总结容易看起来像用户已作出的决定 | 明确分开呈现“你已明确”与“当前理解” |
| 新论文、局部机制或子问题可能直接成为叙事中心 | 新信息先作为候选；升格为根问题必须 `/discussion accept`；工作焦点可带 `returnTo` 下沉 |
| 深入局部后容易忘记原本要解决什么 | Rail 显示工作焦点；根问题已锁定且不同时，同一行写出 `工作焦点 · ↑根问题` |
| 讨论结束时可能只有观点，没有决策路径 | 收敛为建议、风险、待验证点与下一步行动 |

它是**单场复杂讨论**的控制层，不是长记忆，也不是一次性问答。Discussion Mode 是插件内部服务（`1=fast | 2=default | 3=deep`），不是 DSH 全局模式。不改 DSH 主仓，不写自定义会话事件。

<a id="quick-start"></a>

## 🚀 快速开始

```sh
dsh plugin --profile web add @jinplu/dsh-plugin-discussion-intent
```

```text
/discussion              start or resume, default intensity, no topic
/discussion 1|2|3        set depth only
/discussion model        list catalog and current subagent model
/discussion model <p>/<id>  persist subagent model for the next spawn
/discussion accept <id>  accept a pending topic/frame change
/discussion reject <id>  reject it
/discussion off          pause; state kept
```

不要在命令后写 topic。`3` 是深度。缺偏好或方向时用原生 `ask_user_question`；能检索的事实不反问。

<a id="rail"></a>

## 🗺️ 讨论状态与四行 Rail

- 标题 / 目标 / 根问题：你接受后才生效。首句只装工作焦点；之后打字的 decision，或带 `？/?` 的 goal，才可锁定空的根问题
- 工作焦点可随合格的 `returnTo` 下沉；改根问题仍须 `/discussion accept`
- You：仍有效的决定、否定、非目标和评价标准；过程句（`spawn subagents`）和刷新句不算
- 问卷选择由宿主写入 decision，算你说过的话，但不自动变成根问题
- 候选方案、证据、当前理解、建议、下一步

Web 输入框上方是只读 Rail（`Focus / You / Understanding / Next`）。值列默认两行，点一行展开全文。顶栏芯片显示强度和子代理 `model · effort`（进行中会加 `running`；未选不写 default）；点芯片选下次 spawn 的模型。Pending 时五行。`/discussion off` 后消失。

<a id="continuity"></a>

## 💾 讨论可续、过程可信

实质更新前先写 Markdown，再写 JSON：

```text
.dsh/discussions/<session-id>.json   权威状态
.dsh/discussions/<session-id>.md     人类可读检查点
```

写入失败会报错。重启同一会话即可恢复。不写自定义会话事件。

<a id="boundaries"></a>

## 🛡️ 设计边界

```text
/discussion 1|2|3
  → 只设深度，未命名检查点，不推断主题
  → 用户下一句开始讨论
  → 每次实质回复前更新讨论状态（先写 Markdown，再写 JSON）
  → 标题/目标/根问题改写变成 Pending Frame Changes；合格的工作焦点下沉立即生效
  → /discussion accept <id> 或 /discussion reject <id>
  → 系统提示策略重注 Human Frame + Web Rail
  → 完全退出 DSH 后从侧车恢复
  → 继续讨论或 /discussion off
```

依赖已发布的 DSH `0.1.0-rc.6` 公共接口。无 `webServer` 时功能完整，只是没有 Rail。

子代理模型一开始为空。第一次 spawn 时从当前 catalog 提问；跳过不会继承父线程模型。

官方 rc.6 没有 `contributeRun`。研究证据保持为候选，升格须 Pending Frame Change。

细节见 [Runtime integration](docs/EXTRACTION.md)，状态见 [Roadmap](docs/ROADMAP.md)。

## 🧪 本地开发

需要 Node.js 22+ 和 package.json 指定的 pnpm 版本。

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
pnpm test:consumer
```

`test:consumer` 把真实 tarball 装进临时 DSH profile，验收 dump-config、启动、命令、工具、落盘、Rail 与重启恢复。可用 `DSH_SMOKE_DSH_REPO` / `DSH_SMOKE_DSH_VERSION` 覆盖 DSH 版本。

## Contributing

参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 说明报告。
