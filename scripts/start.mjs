/**
 * Halo 启动器。
 *
 * Electron 内置的 Node 24 fetch（undici）默认无视 HTTP(S)_PROXY 环境变量，
 * 直连会被墙的供应商（openai-codex 等）会报 "fetch failed"；
 * NODE_USE_ENV_PROXY=1 让内置 fetch 走系统代理 —— 与 pi CLI 的行为保持一致。
 * 该变量在 Node 启动时读取，因此必须在 Electron 进程启动前由这里注入。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_USE_ENV_PROXY = "1";

/* 取消监听器上限警告（本进程仅做转发，无泄漏风险） */
process.setMaxListeners?.(0);

const electron = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

const child = spawn(electron, ["."], { stdio: "inherit", cwd: root, env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
