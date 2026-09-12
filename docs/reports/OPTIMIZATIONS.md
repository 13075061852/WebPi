# Pi Halo 优化手册 v1（已全部实施 ✅）

> 基于 2024-08 实测探针数据（pi SDK 0.84.4 真实事件流）+ 用户截图审查。
> 事件真相：`message_start/end` 的 message 带 `stopReason/errorMessage`；`agent_end` 带 `willRetry`；失败后有 `auto_retry_start/end` 与 `agent_settled`；user/assistant 消息都会发 message_start。

## A 级 — 功能性缺陷（必须修）

| # | 问题 | 根因 | 方案 |
|---|------|------|------|
| A1 | **模型报错时聊天区毫无反馈**，只剩"正在思考…"转圈（截图现象） | `message_end` 携带 `errorMessage`/`stopReason:'error'`，UI 未处理 | message_end 时检查 `errorMessage`，渲染红色错误卡（含原始错误 + 友好解读 + 重试按钮） |
| A2 | **自动重试期间 UI 状态闪烁**：agent_end(willRetry) 复位按钮/光球，2s 后又 busy | 未处理 willRetry / agent_settled | willRetry=true 时保持 busy；监听 `agent_settled`、`auto_retry_end` 后才最终复位；重试中状态显示"自动重试中 (n/3)" |
| A3 | **文本流可能静默丢失**：text_delta 到达时若 assistant 容器未建立则直接丢弃 | onMessageUpdate 前置 return | 兜底：delta 到达且无容器时自动创建；message_end 同理可从 message.content 重建 |
| A4 | **发送后 prompt 抛错时用户文本丢失**（气泡已渲染、输入已清空） | 未校验 ready / 未回滚 | 发送前校验 state.ready；失败时把文本+附件还原回输入框 |
| A5 | **错误文案晦涩**："429 余额不足"、"fetch failed" 直接透出 | 无错误映射 | 错误分类映射：余额类→提示切换模型（附快捷按钮）；网络类→提示代理/网络；鉴权类→提示重新登录 |
| A6 | **ctxBadge/统计不实时** | pushState 时机少 | bridge 在 message_end / agent_end / agent_settled 后均 pushState |
| A7 | **usage 全 0 时界面显示假数据**（↑0 ↓0 $0.0000） | 网关未回 usage | 全 0 时渲染 "—"，并按字符数估算输出 tokens 标注"≈" |
| A8 | **工具产物文件名提取不可靠**（从渲染后的 DOM 反取） | onToolEnd 用 desc.textContent | onToolStart 缓存 args.path/command；write/edit 用 args.path 提取文件名 |
| A9 | 切换到同一目录时也提示"已切换项目"并清屏 | pickProject 无 diff 判断 | 目录相同直接 return，不清屏不提示 |

## B 级 — 体验优化

| # | 问题 | 方案 |
|---|------|------|
| B1 | 会话名是原始 UUID 文件名（胶囊/标题/列表三处） | 友好化：`MM-DD HH:mm · uuid前6位`，优先 pi 的 session name |
| B2 | 用户消息 "你 你" 双重头部冗余 | 去掉 who 行，仅保留右对齐气泡 + 小圆点头像融合进气泡 |
| B3 | 滚轮误触导致星环缩到 62% | zoom clamp 0.75–1.6；双击缩放数值复位 100%；项目切换后复位 |
| B4 | 会话胶囊超长名挤压缩放控件 | max-width 420px + ellipsis |
| B5 | 强制自动滚动剥夺回看权 | 仅当滚动位置接近底部（<80px）才跟随 |
| B6 | 空助手容器残留（只有工具调用无文本时留下孤立"星环"头） | finalize 时若无文本且无思考则移除容器 |
| B7 | 工具卡片信息弱 | 图标按工具类型区分；显示执行耗时；出错自动展开输出 |
| B8 | 助手回复无复制入口 | 气泡 hover 显示复制按钮 |
| B9 | 未就绪即可输入，报错难懂 | 未就绪 placeholder="核心唤醒中…"，发送按钮禁用态 |
| B10 | Esc 只在输入框聚焦时中止任务 | 全局 Esc：有弹层关弹层，否则运行中则中止 |
| B11 | 重试/队列缺感知 | 重试 notice 显示次数；steer 入队 toast |
| B12 | 窗口最大化按钮状态不反馈 | 监听 winstate 切换还原/最大化图标 |
| B13 | 顶栏统计与胶囊信息重复感 | 统计保留在 header，胶囊只留状态+名称 ✓（已对齐） |

## C 级 — 视觉打磨

| # | 方案 |
|---|------|
| C1 | 用户气泡渐变加浓 + 右下角 5px 圆角保持（已做）+ 边框提亮 |
| C2 | 错误卡样式：左红条 + 背景 rgba(253,164,175,.06) + 重试按钮 |
| C3 | 工具卡耗时徽标（mono 字体，done 后显示） |
| C4 | 复制按钮 hover 淡入 |
| C5 | agent-sub 状态文案分级：待命/思考中/工具名/重试中 |

## 实施顺序

1. app.js 事件层重构（A1/A2/A3/A6/A8 + B5/B6/B10）
2. 发送链路加固（A4/A9 + B9/B11）
3. 文案与状态映射（A5 + C5）
4. 视觉与 CSS（B2/B3/B4/B7/B8/B12 + C1–C4）
5. nebula.js 缩放钳制（B3）
6. pi-bridge.mjs pushState 时机（A6）
