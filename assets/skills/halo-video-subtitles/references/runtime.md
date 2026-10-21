# 轻量运行时

- Node脚本及说明约几十KB，源码不捆绑模型或二进制。
- 本地后端：whisper.cpp v1.9.2 Windows x64纯CPU发布包，新安装器只保留whisper-cli/whisper/ggml必要文件，约10MB；当前测试环境保留完整CPU发布包约21MB，含模型实际约80.6MB；不安装Python、venv、PyTorch或CUDA。
- 模型：多语言ggml-base-q5_1.bin，59,707,625字节。它是小型base的5位量化，精度与大模型有取舍，不宣称更准。英文/中文均可离线识别。
- 复用本机已有FFmpeg，首次检测不到时要求给出现有路径，不自动安装另一份。FFmpeg负责压制，体积不属于ASR模型；更换设备需要实际可用的FFmpeg。
- 用户级配置：`~/.pi/tools/video-subtitles-lite/config.json`，只保存工具路径，无凭证。模型和CPU程序也在同目录；不会写入项目node_modules或安装包。

来源（MIT）：https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2

量化模型：https://huggingface.co/ggerganov/whisper.cpp

安装脚本对发布包和模型校验SHA256，下载不匹配时停止。skill本身不包含上传音频的代码，不能悄悄切换到在线服务。

## 可选免费在线识别

截至2026-10-21，Groq官方文档列出Whisper免费计划额度：20请求/分钟、2000请求/天、每小时7200音频秒、每天28800音频秒；免费层文件上限25MB。需要账号和API Key，实际额度以账号为准，不代表所有账号都是免费计划。未配置时直接使用本地量化模型，不让用户为了本skill注册付费服务。

https://console.groq.com/docs/rate-limits

https://console.groq.com/docs/speech-to-text

只在用户已配置免费识别工具、确认额度和上传授权后，按现成工具的用法调用。429/额度不足/需付费时停止在线路径并转本地，不轮换账号或绕过地区与额度限制。

