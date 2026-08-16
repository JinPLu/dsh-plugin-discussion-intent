# Roadmap

交付完整而强力的日常 Discussion Mode：守住目标、边界与当前焦点，并把探索收敛为有依据的下一步。只依赖已发布的 DSH `0.1.0-rc.6` 公共接口。`v1.0.0` 已发布；后续版本须先完成发布验收。

官方 rc.6 没有原生 `contributeRun`。研究证据不能改写已锁定的问题。

## 第一阶段：核心纵向闭环

- [x] `/discussion` 无参数开始，未命名，不推断主题
- [x] `/discussion [1=fast | 2=default | 3=deep]` 只切换讨论强度
- [x] `/discussion accept <id>` / `/discussion reject <id>` 处理 Pending Frame Changes
- [x] `/discussion off` 退出，并保留可恢复状态
- [x] 三档讨论 policy；深度档落实“第一性原理 + 站在巨人的肩膀往前进”
- [x] 每轮重注 active Human Frames；新论文和工具结果不能替换它们
- [x] 原生 `ask_user_question` 仅用于偏好、边界和方向选择
- [x] `discussion_update` 可捕获原话、追加候选证据、修订暂定理解；标题/目标/根问题改写变成待确认变更
- [x] 首句只装工作焦点，不填 Goal、不锁根问题；之后打字的 decision 或带 `？/?` 的 goal 可锁定空的根问题
- [x] 合格 `returnTo` 立即下沉工作焦点；其余 focus 写仍是 Pending 根问题
- [x] 问卷选择由宿主写入 decision，算你说过的话，但不自动变成根问题
- [x] 理解可写；建议、下一步和选项升格不得与 active 否定/非目标矛盾
- [x] 空闲时四行只读 Web Rail；Focus 显示工作焦点，根问题不同时同一行写出 `↑根问题`；You 露出决定/否定/非目标/评价标准并排除过程句与刷新句；有 Pending 时单独露出，不显示假主题
- [x] 每次实质更新先写 Markdown 再写 JSON 侧车（`.dsh/discussions/*.md` / `.json`），`pendingFrameChanges` 落在 version `1`，旧文件缺省为 `[]`
- [x] 保存失败可见，不静默丢失讨论检查点
- [x] 子代理模型自选：顶栏芯片或 `/discussion model` 写入 settings，不进对话、不继承父线程

## 第二阶段：对已发布 rc.6 的真实消费验收

- [x] 从生成的真实 tarball 安装到全新临时 DSH profile
- [x] `dump-config` 能看到插件及默认强度
- [x] `dump-config` 不再给 tool-subagent 行写死 agentOptions
- [x] DSH 实际 boot 成功，不依赖开发仓库中未打包的文件
- [x] `/discussion` 命令、`discussion_update` 工具 schema、policy 段 live smoke 全部通过
- [x] Markdown 与 JSON 侧车在临时工作区真实生成且内容正确
- [x] 客户端 Rail bundle 被 web profile 页面注入，HTTP 状态快照与 SSE 推送验证通过
- [x] 真实浏览器中 `/discussion 3` 显示四行 Rail 与已落盘状态，`/discussion off` 后隐藏，控制台零错误
- [x] 完整停止 → 二次启动 → 恢复同一 session 与档位 → 继续更新并再次落盘
- [x] 会话日志保持零自定义事件（重启恢复不再依赖任何上游 seam）
- [x] 在最低支持版、latest 和 canary DSH 上重跑消费矩阵
- [x] WorldModel / Codex-thread 防漂移契约测试：研究证据不能静默改根问题；研究型 nextStep/favored 不得覆盖人类否定；合格下沉只改工作焦点；`supersedeStatementIds` 必须带新的同会话证明原话
- [x] session-5c9c59e2 形状回放：三次用户句 + 一次问卷选择后，Rail Focus 不再是 Codex URL，You 不再只剩 `spawn subagents`

## 第三阶段：发布准备

- [x] README 安装说明与实际包一致
- [x] npm tarball 包含预构建 host、invariant、client、contract 和类型声明
- [x] peer compatibility 范围与消费矩阵一致（当前 `>=0.1.0-rc.6 <0.2.0-0`）
- [x] `v1.0.0` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [x] `v1.1.0` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [x] `v1.1.1` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [x] `v1.2.0` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [x] `v1.3.0` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [x] `v1.4.0`–`v1.5.2` 仅本地安装，并入 `v1.6.0` 发布
- [ ] `v1.6.0` 的 npm provenance、Git tag、GitHub Release 和包版本一致
- [ ] 真实用户 profile 再执行一次安装、启动、开始讨论、切档、落盘和退出验收

## 后续增强原则

只做能直接改善讨论质量或日常使用的增强。可选能力须独立探测、独立降级，不能阻断 `/discussion` 核心闭环。官方 rc.6 上不假装已有原生 Research Run 冻结。
