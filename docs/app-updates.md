# 软件更新发布

软件启动后 30 秒、之后每 6 小时检查 GitHub Releases；主界面左下角“设置”旁常驻“检查更新”入口。
发现新版本在左下角设置旁显示“有更新”，点击后下载并校验文件，显示百分比，下载完成自动退出安装并重新启动。点击前请先结束任务。
离线启动不打扰用户，开发模式不更新。

更新源由 package.json 的 build.publish 指定。必须是所有安装用户可访问的公开 Releases；不要把 GitHub 私人令牌写入客户端。
当前配置为 13075061852/WebPi，启用发布前须确认该仓库公开可访问，或换成公开的发布仓库。

发布步骤：
1. 用 `npm version patch --no-git-tag-version` 递增版本并同步锁文件。
2. 提交修改，创建与版本一致的标签，例如 v1.0.2，然后推送标签。
3. release.yml 会在 Windows 构建并上传 EXE、blockmap 和 latest.yml 到草稿 Release。
4. 检查草稿文件完整后发布 Release。仅覆盖同版本 EXE 不会触发更新。

手动发布也可将 dist 中的安装 EXE、对应 blockmap、latest.yml 一起上传到同一个 Release。
手动上传时文件名必须与 latest.yml 完全一致（GitHub 更新元数据使用连字符，例如 Pi-Halo-Setup-1.0.1.exe 和 Pi-Halo-Setup-1.0.1.exe.blockmap）；自动发布工作流会处理名称转换。
首次启用此功能，旧版用户需要手动安装一次带更新功能的安装包。
若更新源使用另一个仓库，工作流需要对应仓库的发布权限和 GH_TOKEN；默认 GITHUB_TOKEN 仅用于当前仓库。
