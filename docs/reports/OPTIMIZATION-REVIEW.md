# Pi Halo 全面优化审查报告 v2

> 审查范围：`src/main/*`（主进程 2234 行）、`src/renderer/*`（渲染层 ~5300 行）、`scripts/`、`package.json`、仓库卫生。
> 审查方式：逐文件通读 + 实测验证（GBK 分块解码、xterm 依赖重复、CSP、shell 注入面等）。
> 优先级：P0 安全 / P1 正确性 Bug / P2 性能 / P3 架构与可维护性 / P4 工程化。

## 实施状态总览（2026-08-31 已实施）

| 类别  | 项                        | 状态  | 验证方式                                                                                             |
| --- | ------------------------ | --- | ------------------------------------------------------------------------------------------------ |
| P0  | #1 sandbox               | ✅   | e2e-render 实测通过                                                                                  |
| P0  | #2 CSP                   | ✅   | e2e-render 实测通过（零 console 错误）                                                                    |
| P0  | #3 spawnPi 去 shell + 白名单 | ✅   | cmd 引号方案实测；e2e-reallink 真实链路通过                                                                   |
| P0  | #4 AutoClaw 密钥可覆盖        | ✅   | env/store 覆盖 + 内置回退首次使用告警（轮换需用户在后台操作）                                                            |
| P0  | #5 保管库 safeStorage 加密    | ✅   | 加密/解密/回退单元测试通过                                                                                   |
| P0  | #6 外链 https-only         | ✅   | 代码审查                                                                                             |
| P1  | #7 GBK 流式解码              | ✅   | 逐字节分片实测还原无损                                                                                      |
| P1  | #8 错误提示可见性               | ✅   | 错误/警告 toast 常显，成功默认静音（尊重原偏好）                                                                     |
| P1  | #9 看门狗空转                 | ✅   | 移除全部死代码                                                                                          |
| P1  | #10 writeAgentExt 死代码    | ✅   | 存根化，逻辑收敛到 pi-bridge                                                                              |
| P1  | #11 Store 原子写            | ✅   | 代码审查 + vault 测试覆盖                                                                                |
| P1  | #12 normP TDZ 序          | ✅   | 提升至模块顶部                                                                                          |
| P1  | #13 相对路径基准               | ✅   | 代码审查                                                                                             |
| P1  | #14 预览 URL 编码            | ✅   | 编解码往返测试通过                                                                                        |
| P2  | #16 流式增量渲染               | ✅   | 全前缀等价性测试（13 组用例）通过                                                                               |
| P2  | #17 文件树异步 + watcher      | ✅   | e2e-treewatch 实测（外部写/删自动刷新）                                                                      |
| P2  | #18 usageSummary 流式      | ✅   | 真实数据聚合验证（36 会话）                                                                                  |
| P2  | #19 预览协议异步 + charset     | ✅   | e2e-workspace 实测                                                                                 |
| P2  | #20 删除异步                 | ✅   | 代码审查                                                                                             |
| P2  | #21 会话恢复分块               | ✅   | e2e 链路通过                                                                                         |
| P3  | #23 注入脚本抽文件              | ✅   | check-touch-script 语法验证                                                                          |
| P3  | #24 xterm 依赖去重           | ✅   | 删 npm 依赖，vendor 保留；lockfile 已同步                                                                  |
| P3  | #26 错误协议统一               | ✅   | use-project 改为 throw + 包装                                                                        |
| P3  | #27 魔法数字                 | ✅   | 主进程 LIMITS + 渲染层 CONFIRM_RESET_MS/TRUNC_TOOL_ARG/PTY_SCROLLBACK/PTY_RESUME_MS/IMG_DOWNSCALE 全部收敛 |
| P3  | #28 平台说明                 | ✅   | README 声明                                                                                        |
| P3  | #29 markdown.js 拆分       | ✅   | e2e 实测                                                                                           |
| P3  | #30 事件缓冲                 | ✅   | 代码审查                                                                                             |
| P4  | #31 .tmp-re2.mjs         | ✅   | 已删除                                                                                              |
| P4  | #33 eslint               | ✅   | src/scripts 零告警                                                                                  |
| P4  | #34 CI                   | ✅   | check + lint + inject                                                                            |
| P4  | #35 test/ 重组             | ✅   | test/e2e（5 个维护套件）+ test/tools（66 个探针）+ test/ 根（截图/注入检查）                                          |
| P4  | #36 打包发布                 | ✅   | electron-builder：dir 免安装版 + NSIS 安装器均实测启动                                                        |
| P4  | #37 LICENSE/engines      | ✅   | 已添加                                                                                              |
| P4  | #38 npm scripts          | ✅   | check/lint/test:*/dist/dist:dir 已补全                                                              |
| 附加  | 依赖健康                     | ✅   | npm ls 干净；npm audit 0 漏洞                                                                         |
| 附加  | 性能基准                     | ✅   | 流式渲染 DOM 写入量 -96.6%（14.6M → 0.49M 字符）                                                            |
| 附加  | nebula.js 死代码            | ✅   | 4c0d779 已移除引用，文件/README/测试残留 → 已清理                                                               |
| 附加  | e2e 测试陈旧引用               | ✅   | render/workspace 测试修正后全绿                                                                         |

### 明确推迟（附理由）

- **#22 nebula 空闲停帧**：呼吸核心冻结会被误判为卡死，且已完成节点常驻导致空闲判定几乎不触发 —— 收益低回归风险高。nebula.js 本身已作为死代码移除。
- **#25 IPC 通道清单化**：preload 手写 60+ 方法但已与主进程 1:1 且被 e2e 覆盖，重构纯属风格收益，风险大于价值。
- **#32 重写 commit 历史**：改动他人历史不可逆，留给作者自行决定。
- **#39 调试钩子门控**：e2e-render 依赖 `window.__haloDispatch` 无条件可用；无浏览器环境检测手段，保留并文档化。
- **prettier**：代码风格已由 eslint + 人工保持一致，全量格式化会产生巨大噪音 diff，不做。

---

## P0 安全（建议优先处理）

### 1. `sandbox: false` 无必要，且失去纵深防御

`main.mjs` 中 splash 与主窗口的 `webPreferences` 都设了 `sandbox: false`。但 `preload.cjs` 只 `require("electron")`（contextBridge/ipcRenderer），完全兼容 sandbox 模式。

- **建议**：改为 `sandbox: true`。渲染层一旦出现 XSS，preload 暴露的 `pkgInstall` / `ptyWrite` / `deleteEntry` / `pickImages` 等能力可被直接利用。

### 2. 无 Content-Security-Policy（两处 HTML 都没有）

`index.html` / `splash.html` 均无 CSP meta。虽然 `esc()/rich()` 转义整体严谨，但渲染层有大量 `innerHTML` 拼接（工具卡、auth 弹窗、md 渲染），任何一处转义遗漏即 XSS。

- **建议**：加 CSP meta（`default-src 'self'; img-src 'self' data: halo-preview:; frame-src halo-preview:; style-src 'self' 'unsafe-inline'`），注意头部内联主题脚本需要 nonce 或 hash。

### 3. `spawnPi` 使用 `shell: true` + 用户可控字符串 → 命令注入面

`main.mjs` 的 `spawnPi` 以 `shell: true` 执行 `pi install/remove/update <source>`，而 `source` 来自渲染层的 `halo:pkg-install` 输入（未做字符白名单，`ensureSource` 只校验前缀）。当前是"自 XSS 才可利用"，但配合 #1/#2 就是完整 RCE 链。

- **建议**：去掉 `shell: true`，直接 `spawn("pi", args)`；Windows 下如需 `.cmd` shim，用 `spawn("cmd", ["/c", "pi", ...args])` 并逐参数引号包裹，或解析 `pi.cmd` 真实路径后 spawn。

### 4. 硬编码 AutoClaw APP_KEY 已提交到公开仓库

`pi-bridge.mjs:1066` 硬编码 `APP_ID = "100003"` 与 `APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"`，而仓库 `origin` 指向 GitHub 公开远程。

- **建议**：确认该密钥是否敏感；敏感则立即轮换，并改为运行时配置（环境变量 / 本地配置文件，不入库）。

### 5. 凭据保管库明文存储

`~/.pi/agent/halo-accounts.json` 明文保存 OAuth access/refresh token 与 API Key（README 已提示敏感，但与 pi 的 auth.json 同目录同明文）。

- **建议**：用 Electron `safeStorage`（Windows DPAPI / macOS Keychain）加密 access token 字段，读取时解密；至少对 refresh token 加密。

### 6. `setWindowOpenHandler` 放行任意 URL 到系统浏览器

`main.mjs` 对 `window.open` / `target=_blank` 的任意 url（含 `file://`、自定义协议、`halo-preview://`）都 `shell.openExternal`。agent 生成的 markdown 链接可触发。

- **建议**：仅放行 `^https?://`，其余 deny。

---

## P1 正确性 Bug

### 7. PTY 输出 GBK 按 chunk 独立解码 → 中文乱码（已实测复现）

`main.mjs:545` 与 `:571` 对每个 data chunk 独立 `iconv.decode(chunk, "gbk")`。GBK 汉字是双字节，跨 chunk 截断时产生乱码。实测：`iconv.encode('中文字符串','gbk')` 在 offset 1 处切开后解码为 `"�形淖址�"`。

- **影响**：cmd 输出含中文文件名/文本（`chcp 936` 环境很常见）时偶发乱码。
- **建议**：改用有状态解码 `iconv.decodeStream("gbk")`（或自维护残余字节缓冲）。

### 8. `toast()` 是空函数，但错误事件也走 toast → 用户对故障完全无感知

`app.js` 中 `toast` 被改为 no-op（78 处调用点保留），包括 `window.halo.onError`（主进程 bridge 启动失败、核心错误）与 `auth_event` 错误、`send()` 失败回滚提示等。**主进程 `halo:error` 通道实际是哑的**。

- **建议**：至少恢复错误级 toast（`kind === "err"` 时弹出），操作成功提示可继续静默；或将 `toast` 彻底删除并显式处理错误路径。

### 9. 停滞看门狗空转

`showStallHint` 空实现（注释"用户要求不再显示"），但 `startStallWatchdog` 仍每 1s 跑 `setInterval`，`stopStallWatchdog` 每轮还尝试 `hideStallHint()` 移除不存在的 `#stallHint`。

- **建议**：要么移除整个看门狗（含 `S.stallTimer`、`S.lastEventAt`、`hideStallHint` 调用），要么恢复功能；保留空转无意义。

### 10. `writeAgentExt` 生成的扩展文件内容实际是死代码（双份逻辑）

`main.mjs` 的 `writeAgentExt` 生成 ~120 行含完整 `scanAgents` 实现的扩展文件，但 `pi-bridge.mjs` 的 `extensionsOverride` 里 push 的扩展对象**自带内联 handler**，只检查该文件存在性，文件内容从未被执行。两处各维护一份 `scanAgents` 副本。

- **建议**：删掉生成文件的内容逻辑，只保留空壳（`export default () => {}`）或直接删文件、内联 handler 用 `resolvedPath` 指向任意存在的文件；把 agent 扫描统一收敛到 `pi-bridge.mjs` 一处。

### 11. `HaloStore.save()` 非原子写

`pi-bridge.mjs` 的 `HaloStore.save()` 直接 `writeFileSync`（同文件的 `HaloAuthVault.save()` 用的是 tmp+rename 原子写）——崩溃/断电时 `halo-settings.json` 可能损坏。

- **建议**：统一为 tmp+rename 原子写。

### 12. `halo:pick-project` 引用 `normP` 于声明之前（TDZ 脆弱序）

`main.mjs` 中 `handle("halo:pick-project", ...)` 注册在 `const normP = ...` 之前。目前运行期没问题（handler 延迟执行），但重排 bootstrap 代码即抛 ReferenceError。

- **建议**：把 `normP` 提升到文件顶部工具函数区。

### 13. `halo:read-file` / `halo:open-path` 对相对路径解析到主进程 cwd

`path.resolve(p)` 未以 `bridge.cwd` 为基准。当前渲染层传绝对路径所以正常，但接口不健壮，未来复用易踩坑。

- **建议**：统一 `resolve(p, bridge.cwd)`，并保留 `isInsideProject` 校验。

### 14. 预览 URL 未处理文件名中的 `#` / `?`

`previewURL()` 用 `encodeURI`（不编码 `#?`），文件名含这些字符时 iframe 加载错误路径。

- **建议**：改用 `encodeURIComponent` 分段编码（或替换 `#`→`%23`、`?`→`%3F`）。

### 15. `usageSummary` 的 `sessions` 计数偏差

`counted` 标志在首次命中后置位，但多会话文件共享计数逻辑在 `cwd` 切换时可能重复/漏计——低危，建议核对。另外 `byDay` 用 `obj.timestamp` 而非 message 时间戳，跨天边缘可能错位一天（取决于 pi 写入格式，需验证）。

---

## P2 性能

### 16. 流式 markdown 全量重渲染（长回复 O(n²)）

`onMessageUpdate` 每收到 `text_delta` 就把**整段累积文本** `rich()` 一遍再 `innerHTML` 全量替换；thinking 块同样每次全量渲染。长回复（数千 token）时每 token 都重解析全文。

- **建议**：按段落切分累积，只重渲染最后一段（此前段落渲染后冻结）；或引入节流（已有 rAF 合并，但仍是全量）。收益：长流回复 CPU 占用显著下降。

### 17. 文件树全量同步扫描，阻塞主进程

`halo:read-tree` 用同步 `readdirSync` + 每文件 `statSync` 递归（CAP 1200），且每次工具 write/edit 后 1.2s 全树重扫。大项目下主进程 IPC 事件循环被阻塞（statSync 是同步 I/O）。

- **建议**：改用 `fs.promises` 异步遍历；配合 `fs.watch`（项目根）做增量失效 + mtime 缓存，只在文件集变化时重扫。

### 18. `usageSummary` 全量读入每个 jsonl 再 split

会话文件动辄数 MB，`fs.readFileSync` 整文件 + `split("\n")` 全部驻留内存，30 天统计可能读取数百 MB。

- **建议**：用 `readline` 逐行流式处理，只解析含 `"usage"` 的行（现已有预筛，但整文件读取仍可省）。

### 19. `halo-preview` 协议同步读文件（最多 8MB）

`protocol.handle` 里 `fs.readFileSync` 阻塞主进程；iframe 每次重载都全量重读。

- **建议**：异步读 + `Response` 流式返回；加 `Cache-Control`（内容变更由版本号/etag 控制）减少重复读盘。

### 20. `halo:delete-entry` 递归同步删除

`fs.rmSync(recursive)` 删除大目录（如含 node_modules 之外的庞大目录）阻塞主进程。

- **建议**：`fs.promises.rm` 异步化 + 渲染层 loading 态。

### 21. 会话恢复全量重建 DOM

`restoreHistory` 对几百条消息的会话一次性构建全部 DOM（无虚拟滚动）。超大会话（长输出）恢复时卡顿数秒。

- **建议**：分批渲染（每帧 N 条）+ 长列表虚拟化（只渲染可视区），或至少对超长 turn 折叠为"点击展开"。

### 22. nebula 动画常驻 rAF

空闲时（无节点、无脉冲）仍持续全帧绘制星空。后台标签页 rAF 会自动暂停，但前台空闲仍耗电。

- **建议**：空闲检测——节点与脉冲都为空时停帧，新事件到来再恢复（`running` 变量已有雏形但从未置 false）。

---

## P3 架构与可维护性

### 23. `main.mjs` 内嵌三大段 JS 字符串（TOUCH_ON / TOUCH_OFF / SCROLL_STYLE，~150 行）

拼接字符串形式的注入脚本无法 lint、无法语法检查、修改易错。

- **建议**：拆为 `src/main/inject/touch-on.js` 等独立文件，`fs.readFile` 读取后注入（用字符串占位符替换设备宽度等参数）。

### 24. xterm 依赖双份

`package.json` 声明 `@xterm/xterm@6.0.0` + `@xterm/addon-fit`，但代码实际使用 `src/renderer/vendor/` 里的 vendored 副本（版本同为 6.0.0），npm 包从未被引用。

- **建议**：二选一——要么删 npm 依赖用 vendor（加说明文件注明来源版本），要么删 vendor 改为构建期拷贝/直接引用 node_modules。

### 25. IPC 桥接层手写 60+ 方法，无集中清单

`preload.cjs` 每个方法手写 `ipcRenderer.invoke`，主进程 `handle()` 一一对应，新增通道容易漏配或拼错 channel 名。

- **建议**：主进程导出通道清单（`const CH = { ... } as const`），preload 用循环生成（保持类型安全的简单替代：集中定义 channel 常量文件）。

### 26. 错误处理风格不统一

部分 handler 走 `{ok,error}` 包装（`handle()` 包装器），部分直接 throw（ipcMain.handle reject → invoke 抛异常），渲染层两种都兼容（`r?.ok` 与 `.catch`）导致代码分支混乱。

- **建议**：统一为 `handle()` 包装器的 `{ok,error}` 协议，渲染层只处理一种形态。

### 27. 魔法数字散落

`CAP=1200`、`8MB` 预览上限、`512KB` 读文件上限、`400KB` 图片压缩阈值、`2.6s` 两步确认、`60s/15s` 额度缓存、`10s` 停滞阈值……分散在代码各处。

- **建议**：收敛为常量（主进程 `const LIMITS = {...}`、渲染层 `const CONFIG = {...}`），便于调参。

### 28. 平台假设未声明

cmd.exe / taskkill / chcp 936 / GBK / 反斜杠路径贯穿主进程，README 未声明 Windows-only。

- **建议**：README 明确平台支持范围；若未来跨平台，PTY 层需抽象（node-pty 或 cross-spawn + utf8 终端）。

### 29. 渲染层 2840 行单文件

零构建架构下可接受，但 `md 渲染`（~300 行）、`hlFile` 语法高亮（~80 行）、`auth`（~400 行）、`pkg 市场`（~300 行）已可独立成文件，通过多个 `<script>` 引入（保持零构建）。

- **建议**：至少把 `mdRender/hlFile` 拆出为 `js/markdown.js`，降低单文件复杂度。

### 30. 事件丢失窗口

`bridge.start()` 在 splash 阶段（最长 7s）即启动，此时 `mainWin` 尚不存在，`emit` 直接丢弃事件（如 auth_event、快速完成的第一轮消息通知）。

- **建议**：主进程侧加环形事件缓冲（如最近 200 条），`halo:window-shown` 后重放。

---

## P4 工程化 / 仓库卫生

| #   | 问题                                                                    | 建议                                                                     |
| --- | --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 31  | `.tmp-re2.mjs` 调试残留文件在仓库根目录                                           | 删除                                                                     |
| 32  | 提交信息全部是 "1"（7 个 commit）                                               | 规范 commit message（可加 conventional commits 或至少描述性信息）                    |
| 33  | 无 lint / format 配置                                                    | 加 `eslint` + `prettier`（零构建不影响，仅开发期检查）                                 |
| 34  | 无 CI                                                                  | GitHub Actions：lint + `npm run test:render` 冒烟                         |
| 35  | test/ 下 ~50 个一次性脚本 + 5MB 截图无组织                                        | 归类：`test/e2e/`、`test/tools/`、`test/artifacts/`（截图），清理已验证废弃的探针脚本        |
| 36  | 无打包发布（electron-builder / forge）                                       | 若需分发：加打包配置 + 内置/检测 pi SDK 策略（当前依赖全局 `@earendil-works/pi-coding-agent`） |
| 37  | `package.json` 无 `engines`、无 `LICENSE` 文件（声明 MIT）                     | 补 `engines.node`、`LICENSE` 文件                                          |
| 38  | README 的测试命令只有 `test:render` 有 npm script                             | 把 `e2e-reallink`、`e2e-workspace` 等加入 `scripts`                         |
| 39  | `window.__haloDispatch` / `__renderUserMsg` / `__mdRender` 调试钩子留在生产代码 | 用 `if (location.hash === "#debug")` 或环境标志包裹                            |

---

## 快速收益排序（建议实施顺序）

1. **P0 安全**（#1–#6）：sandbox、CSP、spawnPi 去 shell、密钥轮换——半天内可完成，消除最大风险。
2. **P1 关键 Bug**（#7 GBK 乱码、#8 错误不可见、#10 死代码双份）——改动小、收益直接。
3. **P2 性能**（#16 流式渲染、#17 文件树异步化）——日常体验提升最明显。
4. 其余按需推进。

---

*报告生成时间：2026-08-31 · 基于当前 HEAD（79564f7）代码逐行审查*
