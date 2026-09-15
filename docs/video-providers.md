# 视频模型

设置 → 视频模型中选择平台，打开「获取 API Key」，在对应官方控制台创建密钥后保存。各平台的 Key、模型和生成参数分别保存。「设为默认」会保存当前配置并切换默认厂家；在默认厂家内更换模型或参数并「保存」，会同步更新默认生成配置，保存其他厂家不切换默认。旧配置中默认模型与厂家已保存模型不一致时，读取时自动以该厂家的已保存模型为准。对话未指定的参数使用同一套 `default_config`，明确指定时仅覆盖对应值。平台网站订阅与 API 账户额度可能不同，实际可调用模型和费用以对应控制台为准。

## 平台入口

| 平台 | 接入模型 | 获取 API Key | 官方接口文档 |
| --- | --- | --- | --- |
| MiniMax | MiniMax-H3 | [MiniMax 密钥管理](https://platform.minimax.cn/console/access?tab=api-keys) | [视频生成 V2](https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create) |
| 通义万相 · 阿里云百炼（北京） | Wan 2.7 | [百炼 API Key](https://bailian.console.aliyun.com/?apiKey=1&tab=model) | [文生视频](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference) |
| Seedance · 火山方舟 | Seedance 2.5 / 2.0 / 1.5 Pro | [方舟 API Key](https://ark.volcengine.com/region:cn-beijing/apiKey) | [视频生成](https://www.volcengine.com/docs/82379/1520757) |
| 可灵 Kling（国内） | Kling 3.0 / 2.6 | [可灵 API Key](https://klingai.com/dev/api-key) | [可灵开放平台](https://klingai.com/document-api) |
| Vidu（国内） | Vidu Q3 Pro / Turbo | [Vidu 控制台](https://platform.vidu.cn/) | [文生视频](https://platform.vidu.cn/docs/text-to-video) |
| Google Veo | Veo 3.1 / Fast / Lite | [Google AI Studio](https://aistudio.google.com/apikey) | [Veo 生成指南](https://ai.google.dev/gemini-api/docs/veo) |
| Runway | Gen-4.5 / Gen-4 Turbo | [Runway Dev](https://dev.runwayml.com/) | [API 配置与密钥](https://docs.dev.runwayml.com/guides/setup/) |
| Luma | Ray 3.2 | [Luma API Platform](https://platform.lumalabs.ai/) | [Ray 3.2 视频生成](https://docs.agents.lumalabs.ai/guides/videos/generation/) |
| Grok | Grok Imagine Video 1.5 | [xAI API Keys](https://console.x.ai/team/default/api-keys) | [视频生成](https://docs.x.ai/developers/model-capabilities/video/generation) |

模型 ID 与可选参数的唯一来源是 `src/main/video-providers.mjs` 及对应的平台模块。界面按当前模型约束展示可用选项；这份文档记录 2026-09-14 接入时的范围。

## 连接测试的含义

「测试连接」只做免费、只读的接口鉴权检查，不创建视频。通过测试说明该 Key 在当前网络下可访问被测试的接口，不等于已开通每个视频模型，也不保证账户余额、地区、内容审核和视频生成配额满足要求。真实出片只会在对话提交生成任务时发生。

| 平台 | 只读检查 | 限制 |
| --- | --- | --- |
| MiniMax | `GET /v2/query/video_generation?page_num=1&page_size=1` | 验证任务列表权限，不创建视频。 |
| Grok | `GET /v1/models` | 验证 xAI API 鉴权，不验证视频模型的可用额度。 |
| 通义万相 | `GET /api/v1/tasks?page_no=1&page_size=1` | 查询北京区域 Key 所属账号的异步任务列表，不验证模型开通状态。[异步任务管理](https://help.aliyun.com/zh/model-studio/manage-asynchronous-tasks) |
| 火山方舟 | `GET /api/v3/contents/generations/tasks?page_num=1&page_size=1` | 验证按量计费 API Key 的任务列表权限；不是 Agent Plan 或 Coding Plan 的专属入口。[任务列表](https://www.volcengine.com/docs/82379/1521675) |
| 可灵 | `POST /tasks`，请求体 `{ "limit": 1 }` | 这是新版协议的只读游标查询接口；生成请求使用独立的 `/text-to-video/…` 或 `/image-to-video/…` 路径。[官方文档](https://klingai.com/document-api) |
| Vidu | `GET /ent/v2/credits` | 验证账户信息，余额为 0 时也能连接成功。[积分查询](https://platform.vidu.cn/docs/search-credits) |
| Google Veo | `GET /v1beta/models?pageSize=1` | 验证 Gemini API 鉴权，不验证 Veo 的付费权限或额度。 |
| Runway | `GET /v1/organization` | 验证 API 账户信息；余额为 0 时也能连接成功。 |
| Luma | `GET /v1/files?limit=1` | 验证 Luma Agents API 鉴权，不提交生成任务。 |

无法连接时会显示 HTTP 状态或网络错误。DNS、连接超时、代理端口错误和无效 Key 是不同问题；不要通过反复提交生成任务来测试连接。

## 模型约束与下载

- **MiniMax**：保留 H3，768P / 2K、4–15 秒，支持文字和本地首帧。
- **Grok**：使用 Imagine Video 1.5，480P / 720P / 1080P、1–15 秒，支持文字和本地首帧。[官方生成参数](https://docs.x.ai/developers/model-capabilities/video/generation)
- **通义万相**：接入 `wan2.7-t2v` 与 `wan2.7-i2v`，720P / 1080P、2–15 秒。图生模型要求首帧，比例由图片决定。接口固定为北京区域 `dashscope.aliyuncs.com`；官方确认通用域名仍可使用，Key 需来自匹配区域。任务和下载链接通常保留 24 小时。[文生参数](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference)、[图生参数](https://help.aliyun.com/zh/model-studio/image-to-video-general-api-reference)
- **火山方舟**：接入 Seedance 2.5、2.0、2.0 Fast、2.0 Mini、1.5 Pro。Seedance 2.5 时长 4–30 秒，2.0 系列为 4–15 秒，1.5 Pro 为 4–12 秒；不同版本的分辨率选择不同。2.5 首帧任务仅支持随图片比例的 `adaptive`。2.5 的 1080p 与 2.0 的 4k 使用 H.265 / HEVC，播放器是否支持取决于系统编解码环境。模型开通及输入素材要求以官方控制台为准。[当前模型 ID](https://www.volcengine.com/docs/82379/1330310)、[生成参数](https://www.volcengine.com/docs/82379/1520757)
- **可灵**：接入新版 `kling-3.0` 和 `kling-2.6`，使用普通 API Key。旧版 Access Key / Secret Key 的 JWT 仅适用于旧协议，不能用于当前新版路径。3.0 支持 720p / 1080p / 4k、3–15 秒；2.6 支持 720p / 1080p、5 或 10 秒。首帧为 PNG / JPEG，图生输出比例随首帧。此版没有接入多镜头、主体参考及音色设置。[新版接口及鉴权](https://klingai.com/document-api)
- **Vidu**：使用国内 `api.vidu.cn`，Key 从国内控制台获取。Q3 Pro / Turbo 支持 540p / 720p / 1080p、1–16 秒，文字生成可选五种比例，图生比例随首帧。首帧支持 PNG / JPEG / WebP，整个请求体不能超过 20 MB。[文生参数](https://platform.vidu.cn/docs/text-to-video)、[图生参数](https://platform.vidu.cn/docs/image-to-video)
- **Google Veo**：使用 Gemini API 的 Veo 3.1 Preview、Fast Preview 和 Lite Preview。720P 可选 4、6、8 秒，1080P 和 4K 仅支持 8 秒，Lite 不支持 4K；比例为 16:9 或 9:16。Veo 有独立的服务端提示词限制和地区规则，详情见上方官方指南。
- **Runway**：本次接入原生 Gen-4.5 和 Gen-4 Turbo，时长 2–10 秒；统一提供 16:9、9:16 的 720P 输出。Gen-4 Turbo 必须提供首帧图片。首帧以 Data URI 提交，编码后总长度不能超过 5 MB。[输入限制](https://docs.dev.runwayml.com/assets/inputs/)
- **Luma**：使用当前的 `agents.lumalabs.ai/v1` 和 Ray 3.2；支持 360P、540P、720P、1080P，5 或 10 秒，六种常用比例。首帧使用 `video.keyframes` 与 `keyframe_indexes: [0]`，兼容 10 秒视频。[首帧与多关键帧参数](https://docs.agents.lumalabs.ai/guides/videos/generation/)

Google 任务 ID 是完整的 `models/<model>/operations/<id>`。下载 Google Files 视频需要 `x-goog-api-key`，该鉴权头仅发送到 `https://generativelanguage.googleapis.com`；跳转到其他 CDN 时不能转发密钥。Runway 与 Luma 返回的签名视频 URL 使用无密钥下载。

生成任务提交成功后保存任务 ID；停止等待不会取消平台已经开始执行的任务。超时、断网或下载失败后应查询已有任务，避免重复创建。平台视频链接通常会过期，成功后应尽快保存本地文件。

视频下载并通过基本文件校验后立即显示含缩略画面与实际消耗的产出卡片，不等待助手完成后续回复；右侧不再重复大播放器，点击卡片在中间预览区播放。最终回复复用同一卡片，不重新加载缩略图。缩略画面由浏览器读取本地视频帧，不额外启动后端解码或抽帧工具；用户未要求时不外部发送。APIMart 每 5 秒查询一次生成状态，其它平台保持各自现有轮询策略；平台自身的生成时长不受此改动控制。

## 开发验证

`node test/verify-video-domestic.mjs` 使用本地 fixtures 验证国内四个平台的官方请求字段、只读连接测试、鉴权失败、首帧路径、状态映射、任务 ID / 模型防护和错误脱敏。协议在 2026-09-14 对照官方文档核对；可灵采用当天文档公布的新协议，而非旧版 `/v1/videos` 示例。

`node test/verify-video-international.mjs` 使用本地 HTTP fixtures 验证三个国际平台的鉴权头、只读连接测试、提交参数、状态映射、无效任务 ID、错误脱敏和下载鉴权范围。Google 的序列化请求还与已安装官方 `@google/genai` SDK 的实际请求进行对照，避免把 SDK 参数名直接当成 REST 字段。

Google REST 请求使用 `parameters.sampleCount` 和 `instances[0].image.bytesBase64Encoded`，与官方 SDK 的 [模型转换实现](https://github.com/googleapis/js-genai/blob/main/src/converters/_models_converters.ts) 一致。

这些测试不使用真实 Key，不产生视频费用，也不能替代有效 Key 的实际出片验证。

## APIMart

APIMart 使用独立密钥，获取地址：[API Key 管理](https://apimart.ai/keys)。在视频模型的厂家列表选择 APIMart，保存密钥即可使用，也可设为默认。

已适配 18 个模型：MiniMax-H3、Seedance 2.5 / 2.0 / Fast / Mini、Sora 2 / Pro、Veo 3.1 Fast / Quality / Lite 及 Fast / Quality 官方渠道、Kling v3、Vidu Q3 Pro / Turbo、Grok Imagine Video / 1.5、Wan 2.6。模型名称与参数以 APIMart 的接口契约为准，与厂家的直连接口分别保存配置。

- 文生视频、单张本地图片生成视频；Veo 3.1 Lite 仅文生视频。
- 本地图片先通过平台上传接口转成 URL；一般最大 20 MB，Sora 与 Veo 非官方渠道最大 10 MB。
- 支持默认模型、全局代理/直连选择、异步任务查询、失败后续查和视频下载播放。
- 测试连接使用只读 `GET /v1/balance`；提交 `POST /v1/videos/generations`；查询 `GET /v1/tasks/{task_id}?language=zh`。
- 当前不暴露视频编辑、多参考素材、尾帧或音频控制。可用性及计费以 APIMart 账户为准。

接口依据：[视频文档](https://docs.apimart.ai/cn)、[任务状态](https://docs.apimart.ai/cn/api-reference/tasks/status)、[图片上传](https://docs.apimart.ai/cn/api-reference/uploads/images)、[密钥状态](https://docs.apimart.ai/cn/api-reference/account/token-balance)。

### 费用预估

设置参数下方显示费用预估。APIMart 从[官方价格页](https://apimart.ai/pricing)的公开结构化数据读取 `fixed_prices.items[].after_discount`，按 1 USD = 10 Credits 换算。整张报价表共享缓存 5 分钟，模型列表不再逐个请求。只解析页面内 JSON 数据，不执行远程脚本；结构变化、档位缺失时显示暂无可靠折后报价。

2026-09-14 核对：`/api/pricing/model` 返回的 Seedance Mini 720P 原价为 0.0286 USD/秒、`discount_percent=0`，但官方价格页明确给出 `original_price=0.0286`、`after_discount=0.02288`。因此正确预估是 **0.02288 × 10 × 5 = 1.144 积分**，不是 1.43。代码直接采用折后字段，不写死 0.8，也不根据某次账单拟合折扣。对应任务保存的实际平台扣费为 1.144 积分，视频时长约 5.088 秒，差额并非只生成了 4 秒。

按秒模型乘请求时长；Veo 非 official 的 Fast / Quality / Lite 按条计费。Sora 使用 `official-分辨率` 档位，Kling 使用 default/pro/4k；禁止任意缺失档位回退 default。Seedance 的 `-input` 档位适用于参考视频，当前首帧图片不选此档位。生成任务的报价会纳入已接入的图片附加费及免费张数；设置面板预估无额外输入素材。Seedance 2.5 的按秒报价仅作预估，最终按 Token 结算。

实际消耗只取任务完成后的 `credits_cost`；缺少该字段但有 `cost` 时按美元换算并记录来源，不再次打折，不以预估替代实际。金额显示清理浮点尾数。[平台扣费字段说明](https://docs.apimart.ai/cn/api-reference/tasks/status)

视频产出卡片显示缩略画面、厂商、模型、生成用时和实际消耗；悬停可看阶段耗时和计费来源。任务文件 `~/.pi/agent/halo-video-jobs.json` 中保存请求参数、提交时的报价快照、结算原始数值白名单、差额及提交/生成查询/下载时间，不记录密钥、提示词或带签名的媒体 URL。查询已交付任务的 status 会更新平台结算，不重复生成或下载，也不改写原来的报价和耗时。报价获取与生成并行，报价失败不延迟视频交付。
