/* 独立验证：完整 Extension 对象（path 指向真实文件）注入 + prompt 后检查人设生效 */
import fs from "node:fs";
import path from "node:path";
import { loadPi, scanAgents } from "../src/main/pi-bridge.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmpDir = "D:/GitHub/WebPi/.halo-test";
fs.mkdirSync(tmpDir, { recursive: true });
const storeFile = path.join(tmpDir, "halo-settings.json");
const storeData = { defaultAgent: "halo-test-agent", cwd: "D:/GitHub/WebPi" };
const extFile = path.join(tmpDir, "halo-default-agent-ext.mjs");
fs.writeFileSync(storeFile, JSON.stringify(storeData));
fs.writeFileSync(extFile, "/* halo default agent placeholder */\nexport default function () {}\n");

const { createAgentSessionRuntime, createAgentSessionFromServices, createAgentSessionServices, SessionManager, getAgentDir } = await loadPi();
const makeExt = () => ({
  path: extFile,
  resolvedPath: extFile,
  hidden: true,
  sourceInfo: { path: extFile, source: "halo", scope: "temporary", origin: "top-level" },
  handlers: new Map([
    ["before_agent_start", [async (event) => {
      const want = storeData.defaultAgent;
      if (!want) return undefined;
      try {
        const agents = await scanAgents(storeData.cwd);
        const ag = agents.find((a) => a.name === want);
        if (!ag || !ag.prompt) return undefined;
        console.log("[halo-ext] injecting agent prompt for:", ag.name);
        return { systemPrompt: (event.systemPrompt || "") + "\n\n# 当前智能体设定：" + ag.name + "\n\n" + ag.prompt };
      } catch { return undefined; }
    }]],
  ]),
  tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
});

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      extensionsOverride: (base) => {
        const extensions = base.extensions.filter(Boolean);
        extensions.push(makeExt());
        return { ...base, extensions };
      },
    },
  });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd: "D:/GitHub/WebPi",
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create("D:/GitHub/WebPi", path.join(tmpDir, "sessions")),
});
const session = runtime.session || runtime;
console.log("session built:", !!session);
await session.prompt("请确认你收到的人设：只回答你在本次会话人设里最关键的一条规则是什么。");
await sleep(400);
const msgs = session.messages || [];
const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
const text = typeof lastAssistant?.content === "string" ? lastAssistant.content : (lastAssistant?.content || []).map((c) => c.text || "").join("");
console.log("reply:", String(text).slice(0, 300));
process.exit(0);
