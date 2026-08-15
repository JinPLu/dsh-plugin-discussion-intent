# Roadmap

目标是在交互最简单的前提下，交付完整而强力的日常 Discussion Mode，并且只依赖已发布的 DSH `0.1.0-rc.6` 公共接口。当前是 pre-release；npm 发布、Git tag 与 GitHub Release 之前必须先完成发布验收。

## 第一阶段：核心纵向闭环

- [x] `/discussion` 无参数开始，模型从上下文提炼暂定主题
- [x] `/discussion [1=fast | 2=default | 3=deep]` 切换讨论强度
- [x] `/discussion off` 退出，并保留可恢复状态
- [x] 三档讨论 policy；深度档落实“第一性原理 + 站在巨人的肩膀往前进”
- [x] 原生 `ask_user_question` 仅用于偏好、边界和方向选择
- [x] 一个模型更新工具维护目标、用户原话、焦点、方案、证据、综合判断和下一步
- [x] 四行只读 Web Rail（HTTP 快照 + SSE 推送，off 后立即消失）
- [x] 每次实质更新先写 Markdown 再写 JSON 侧车（`.dsh/discussions/*.md` / `.json`）
- [x] 保存失败可见，不静默丢失讨论检查点

## 第二阶段：对已发布 rc.6 的真实消费验收

- [x] 从生成的真实 tarball 安装到全新临时 DSH profile
- [x] `dump-config` 能看到插件及默认强度
- [x] DSH 实际 boot 成功，不依赖开发仓库中未打包的文件
- [x] `/discussion` 命令、`discussion_update` 工具 schema、policy 段 live smoke 全部通过
- [x] Markdown 与 JSON 侧车在临时工作区真实生成且内容正确
- [x] 客户端 Rail bundle 被 web profile 页面注入，HTTP 状态快照与 SSE 推送验证通过
- [x] 真实浏览器中 `/discussion 3` 显示四行 Rail 与已落盘状态，`/discussion off` 后隐藏，控制台零错误
- [x] 完整停止 → 二次启动 → 恢复同一 session 与档位 → 继续更新并再次落盘
- [x] 会话日志保持零自定义事件（重启恢复不再依赖任何上游 seam）
- [x] 在最低支持版、latest 和 canary DSH 上重跑消费矩阵

## 第三阶段：发布准备

- [x] README 安装说明与实际包一致
- [x] npm tarball 包含预构建 host、invariant、client、contract 和类型声明
- [x] peer compatibility 范围与消费矩阵一致（当前 `>=0.1.0-rc.6 <0.2.0-0`）
- [ ] npm provenance、Git tag、GitHub Release 和包版本一致
- [ ] 真实用户 profile 再执行一次安装、启动、开始讨论、切档、落盘和退出验收

## 后续增强原则

发布后的增强必须直接改善讨论质量或日常使用体验，例如更好的断点恢复、Rail 呈现或讨论文件浏览。可选增强要独立探测、独立降级，不能迫使用户配置额外服务，也不能阻断 `/discussion` 核心闭环。

不会预先加入复杂审批、哈希校验或用户不可见的抽象层。只有真实问题和可验证收益出现时，才扩展运行时设计。
