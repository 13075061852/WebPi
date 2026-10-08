# Windows 环境自动配置

## 当前流程

- 只检测和配置 Python、Node.js、Git。已经可用的工具不升级、不重复安装。
- 读取进程和系统持久化 PATH；补查标准安装目录、Store 包专属 Python 目录和 Halo 管理的 Node 目录。
- 发现可运行程序但 PATH 缺失时显示「待配置 PATH」，点击配置后只追加当前用户 PATH，并重新验证。
- 检测 Python 时关闭新版/旧版启动器的自动下载行为，检测本身不安装程序。
- Python、Git 优先使用 WinGet 的当前用户安装。旧 WinGet 不支持代理参数时，直接使用官方备用安装。
- 缺少 WinGet 或 WinGet 源/下载/适用安装器失败时使用官方备用安装。Node 优先采用官方 ZIP，避免 MSI 的管理员权限要求。
- 备用方案面向 Windows x64/ARM64：Python 和 Git 为当前用户安装；Node 放在 `%LOCALAPPDATA%\Pi Halo\environment\node-v<version>-win-<arch>` 并加入用户 PATH。
- 下载使用应用当前的网络/代理设置。执行前必须通过固定 SHA-256 校验；不关闭 TLS、哈希或系统策略检查。
- 取消、超时、校验失败、组织策略、安装器忙、磁盘不足及需要重启时停止后续配置。返回成功退出码后还必须检测到可用程序。

任意自定义安装目录不会被遍历。官方站点被网络阻断、系统安全策略不允许安装，或者 PowerShell 被禁用时，仍可能需要手动处理。已打开的终端需要重新打开才能继承新 PATH。

## 收集另一台电脑的失败原因

在环境配置页点击「复制诊断」，可获取 Windows 内核版本、应用进程架构、WinGet 版本/路径、工具检测结果和本次配置日志。日志中的代理认证和常见凭据会隐藏；不包含 GitHub、Cloudflare 授权状态。用户目录路径仍在诊断中，用于排查路径问题。

界面先显示简短原因，完整安装器输出放在「查看详细日志」中。

## 维护与验证

备用安装包的 URL 和 SHA-256 一起维护于 `src/main/environment-fallback.mjs`。应与官方 manifest/发布校验文件核对后同时更新，不能只改 URL 或跳过校验。

相关依据：

- [WinGet 安装参数](https://learn.microsoft.com/windows/package-manager/winget/install)
- [WinGet 1.8 代理支持](https://github.com/microsoft/winget-cli/releases/tag/v1.8.1791)
- [Python 当前用户安装参数](https://docs.python.org/3.14/using/windows.html#installing-without-ui)
- [Git 官方静默安装](https://gitforwindows.org/silent-or-unattended-installation)

本次验证：

```powershell
node test/verify-environment-detection.mjs
node test/verify-environment-manager.mjs
node test/verify-environment-fallback.mjs
node test/e2e/e2e-environment-compatibility.mjs
```

检测、管理器、27 项备用安装离线检查及 6 组 Electron UI 场景通过。PowerShell 解压实际覆盖中文/空格/方括号路径；PATH 写入脚本仅对内存模拟注册表验证。当前电脑只读检测通过，六组备用安装器 URL/摘要与官方清单一致。

未在其他实体机执行真实首次安装，未修改本机已安装环境或用户 PATH；这些隔离结果不能替代有问题电脑上的实际复测。
