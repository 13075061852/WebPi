/**
 * Halo 启动器。
 *
 * 代理由主进程 env-proxy.mjs 统一初始化，开发版与安装版使用相同逻辑。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* 取消监听器上限警告（本进程仅做转发，无泄漏风险） */
process.setMaxListeners?.(0);

const electron = process.platform === "win32"
  ? path.join(root, "node_modules", "electron", "dist", "electron.exe")
  : path.join(root, "node_modules", ".bin", "electron");

const child = spawn(electron, ["."], { stdio: "inherit", cwd: root, env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
