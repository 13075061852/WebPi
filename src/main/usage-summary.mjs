import fs from 'node:fs';
import path from 'node:path';
import { estimateSubscriptionCost, isSubscriptionProvider } from '../shared/subscription-cost.mjs';

export async function usageSummary(root, days, modelRuntime, reader) {
    const since = Date.now() - days * 86400000;
    const sessionDetails = [];
    const localDate = (value) => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; };
    const todayKey = localDate(Date.now());
    const byModel = new Map();   // provider/model -> 聚合
    const byDay = new Map();     // YYYY-MM-DD -> 聚合
    const byProject = new Map(); // cwd -> 聚合
    let sessions = 0;
    const emptyAgg = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, unpriced: 0 });
    const add = (map, key, u, amount) => {
      const a = map.get(key) || emptyAgg();
      a.calls++; a.input += u.input || 0; a.output += u.output || 0;
      a.cacheRead += u.cacheRead || 0; a.cacheWrite += u.cacheWrite || 0;
      a.totalTokens += u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      if (amount == null) a.unpriced++;
      else a.cost += amount;
      map.set(key, a);
    };
    const files = new Set();
    const scan = async (dir) => {
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { await scan(full); continue; }
        if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
        // 流式逐行处理：会话文件可能很大，整文件读入会撑高内存峰值
        let cwd = "";
        let counted = false;
        let title = "", modified = "";
        const usageBySession = new Map();
        files.add(full);
        for await (const record of reader.read(full)) {
          if (record.type === 'session') { cwd = record.cwd || cwd; continue; }
          if (record.type === 'title') { title = record.title; continue; }
          if (record.type === 'user') { title ||= record.title; continue; }
          const m = record;
          const obj = record;
          const ts = Date.parse(obj.timestamp || "");
          if (!Number.isFinite(ts) || ts < since) continue;
          if (!counted) { sessions++; counted = true; }
          const model = isSubscriptionProvider(m.provider) ? modelRuntime?.getModel(m.provider, m.model) : null;
          const amount = isSubscriptionProvider(m.provider)
            ? estimateSubscriptionCost(model, m.usage)
            : (m.usage.cost?.total || 0);
          add(byModel, `${m.provider || "?"}/${m.model || "?"}`, m.usage, amount);
          add(byDay, localDate(ts), m.usage, amount);
          add(usageBySession, "total", m.usage, amount);
          if (localDate(ts) === todayKey) add(usageBySession, "today", m.usage, amount);
          if (obj.timestamp > modified) modified = obj.timestamp;
          add(byProject, cwd || "未知项目", m.usage, amount);
        }
        if (counted) sessionDetails.push({ file: full, cwd, name: title || "未命名会话", modified, ...usageBySession.get("total"), today: usageBySession.get("today") || emptyAgg() });
      }
    };
    await scan(root);
    reader.prune(files);
    const r4 = (n) => Math.round(n * 10000) / 10000;
    const models = [...byModel.entries()].map(([key, a]) => ({ key, ...a, cost: r4(a.cost) }))
      .sort((x, y) => y.totalTokens - x.totalTokens);
    const daily = [...byDay.entries()].map(([date, a]) => ({ date, ...a, cost: r4(a.cost) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    const projects = [...byProject.entries()].map(([cwd, a]) => ({ cwd, ...a, cost: r4(a.cost) }))
      .sort((x, y) => y.totalTokens - x.totalTokens).slice(0, 8);
    const totals = [...byModel.values()].reduce((s, a) => ({
      calls: s.calls + a.calls, input: s.input + a.input, output: s.output + a.output,
      cacheRead: s.cacheRead + a.cacheRead, cacheWrite: s.cacheWrite + a.cacheWrite,
      totalTokens: s.totalTokens + a.totalTokens, cost: s.cost + a.cost, unpriced: s.unpriced + a.unpriced,
    }), emptyAgg());
    totals.cost = r4(totals.cost);
    sessionDetails.sort((a, b) => b.modified.localeCompare(a.modified));
    return { days, sessions, totals, models, daily, projects, sessionDetails, today: { ...(byDay.get(todayKey) || emptyAgg()), date: todayKey } };
  }

