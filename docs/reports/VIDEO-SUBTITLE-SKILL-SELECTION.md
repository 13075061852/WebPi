# 视频字幕 Skill 当前配置

更新日期：2026-10-21。用户要求轻量、免费；在线服务只接受免费额度，不可确认可用时优先本地。

## 当前选择

已移除上一版默认faster-whisper + turbo + Python虚拟环境的技能入口，替换为 `halo-video-subtitles` 轻量版。Codex个人技能 `video-chinese-subtitles` 同步替换，避免再次自动安装重型后端。

- skill本体：4个文本/脚本文件，约22KB。
- 执行层：Node内置模块，无npm包、Python、venv、PyTorch、CUDA依赖。
- 本地识别：whisper.cpp v1.9.2纯CPU程序 + 多语言base Q5_1模型。模型59,707,625字节；当前完整CPU发布包约21MB，整个新运行时约80.6MB。后续安装器只取必要CPU文件，可进一步减少。
- FFmpeg复用本机已有文件，没有额外下载或复制一份。
- 用户级配置：`~/.pi/tools/video-subtitles-lite/config.json`。项目/安装包不包含识别模型。
- 保留硬字幕MP4与SRT，CPU单线程、保守限速、完整解码、原片/成片哈希与实际抽帧验收。
- 小型量化模型的准确率有取舍，仍需当前智能体结合原声和术语校对；未做正式WER评测，不能宣称与turbo同等准确。仅当确实不满足要求再讨论较大模型。

## 在线免费识别

Groq官方文档存在Whisper免费计划额度，但需要已配置账号/API Key并确认免费计划及可用额度。当前没有已配置、可确认免费的在线识别能力，因此没有注册账号、调用付费接口或上传视频，默认使用离线量化模型。

- https://console.groq.com/docs/rate-limits
- https://console.groq.com/docs/speech-to-text

## 本地来源

- https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2
- https://huggingface.co/ggerganov/whisper.cpp

安装器校验CPU包及模型的固定SHA256，失败不会默默改用其它包。

## 验证

真实Pi加载器发现8个内置技能；技能开关与同名用户技能保留；ASAR外脚本物理路径；Node语法、lint、平台fixture检查；SRT时间/重叠验证；已有结果拒绝覆盖均通过。

已用本机视频的6秒片段测试原声识别和硬字幕交付：新Node辅助脚本能完成本地识别、SRT、硬字幕编码、全片解码、抽帧。编码加解码约9.15秒；哈希复用后抽3帧约0.38秒。只代表该短片和本机，不是长视频速度保证或语义准确率证明。中文抽帧已实际查看。

## 旧版清理限制

旧版Python辅助程序、重型安装器和术语脚本已从技能目录移除。旧的turbo模型与专用Python运行时不再被新skill引用，但磁盘缓存尚未删除：自动审批拒绝了批量删除和精确旧模型文件删除，只返回blocked by policy，没有具体理由。因此不能声称已释放旧缓存空间。

本次仍为源码配置，没有修改版本号、打包安装器或发布Release；旧安装版EXE需后续构建才包含新内容。
