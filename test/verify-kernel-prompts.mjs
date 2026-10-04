import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolatePi } from './helpers/isolated-real-pi.mjs';

const isolated = isolatePi('kernel-prompts');
const { fixture, agentDir, project } = isolated;
const root = fileURLToPath(new URL('../', import.meta.url));
const deliveryFile = path.join(root, 'assets', 'delivery-policy.md');
const policy = fs.readFileSync(deliveryFile, 'utf8');
let bridge;

function write(relative, text) {
  const file = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function promptHashes() {
  const files = [path.join(root, 'AGENTS.md')];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file);
    }
  }
  collect(path.join(root, 'assets'));
  return files.sort().map(file => ({
    file: path.relative(root, file).replaceAll('\\', '/'),
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  }));
}

try {
  const before = promptHashes();
  const userContext = '# User context\nUSER_CONTEXT_SENTINEL：保留原文。\n';
  const projectContext = '# Project context\nPROJECT_CONTEXT_SENTINEL：按项目规则执行。\n';
  write('.pi/agent/AGENTS.md', userContext);
  write('project/AGENTS.md', projectContext);
  const userTemplate = 'USER_TEMPLATE_SENTINEL $1\n';
  const projectTemplate = 'PROJECT_TEMPLATE_SENTINEL $1 / $2\n';
  write('.pi/agent/prompts/user-fixture.md', `---\ndescription: User template\n---\n${userTemplate}`);
  write('project/.pi/prompts/project-fixture.md', `---\ndescription: Project template\n---\n${projectTemplate}`);
  write('.pi/agent/agents/inspector.md', '---\nname: inspector\ndescription: User role\n---\nUSER_ROLE_SENTINEL\n');
  const projectAgentFile = write('project/.pi/agents/inspector.md', '---\nname: inspector\ndescription: Project role\n---\nPROJECT_ROLE_SENTINEL\n第二行规则原样保留。\n');
  write('project/.agents/alternate.md', '---\nname: alternate\n---\nALTERNATE_ROLE_SENTINEL\n');
  write('project/.pi/agents/external.md', '---\nname: external\nrunner:\n  type: codex\n---\nEXTERNAL_ROLE_MUST_NOT_LOAD\n');
  write('project/.pi/agents/skipped.chain.md', 'CHAIN_MUST_NOT_LOAD\n');

  const { PiBridge, HaloStore, loadPi, scanAgents } = await import('../src/main/pi-bridge.mjs');
  const { resolvePiEntry } = await import('../src/main/pi-runtime.mjs');
  const sdk = await loadPi();
  const sdkRoot = path.resolve(path.dirname(resolvePiEntry()), '..');
  const sdkVersion = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'package.json'), 'utf8')).version;
  const declaredSdkVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent'];
  assert.equal(sdkVersion, declaredSdkVersion, 'Production SDK must be the pinned bundled version');
  const { buildSystemPrompt } = await import(new URL('./core/system-prompt.js', pathToFileURL(resolvePiEntry())).href);
  const { expandPromptTemplate } = await import(new URL('./core/prompt-templates.js', pathToFileURL(resolvePiEntry())).href);
  assert.equal(sdk.getAgentDir(), agentDir);
  const store = new HaloStore(path.join(fixture, 'halo.json'));
  store.set('defaultAgent', 'inspector');
  bridge = new PiBridge(store, {}, { sessionDir: path.join(fixture, 'sessions') });
  bridge.modelRuntime = await sdk.ModelRuntime.create({ allowModelNetwork: false });
  assert.equal((await bridge.start(project)).ready, true);
  const loader = bridge.services.resourceLoader;
  assert.ok(loader instanceof sdk.DefaultResourceLoader, 'Exercise the real production resource loader');
  const skillNames = ['halo-word', 'halo-excel', 'halo-powerpoint', 'halo-pdf', 'halo-imagegen', 'halo-video-prompt'];
  for (const name of skillNames) {
    const skill = loader.getSkills().skills.find(item => item.name === name);
    assert.ok(skill, `Bundled ${name} must be discoverable`);
    assert.equal(path.resolve(skill.filePath), path.join(root, 'assets', 'skills', name, 'SKILL.md'));
    assert.ok(bridge.session.systemPrompt.includes(name), `Agent base prompt must expose ${name}`);
  }
  const contexts = loader.getAgentsFiles().agentsFiles;
  assert.ok(contexts.some(item => path.resolve(item.path) === path.join(agentDir, 'AGENTS.md') && item.content === userContext));
  assert.ok(contexts.some(item => path.resolve(item.path) === path.join(project, 'AGENTS.md') && item.content === projectContext));
  assert.ok(bridge.session.systemPrompt.includes(userContext.trim()));
  assert.ok(bridge.session.systemPrompt.includes(projectContext.trim()));
  assert.ok(!contexts.some(item => path.resolve(item.path) === path.join(root, 'AGENTS.md')), 'Fixture must not inherit repository instructions');

  const templates = loader.getPrompts().prompts;
  assert.equal(templates.find(item => item.name === 'user-fixture').content, userTemplate.trim());
  assert.equal(templates.find(item => item.name === 'project-fixture').content, projectTemplate.trim());
  assert.equal(expandPromptTemplate('/project-fixture 第一 "第二 参数"', templates), 'PROJECT_TEMPLATE_SENTINEL 第一 / 第二 参数');
  assert.equal(expandPromptTemplate('/user-fixture 原文', bridge.session.promptTemplates), 'USER_TEMPLATE_SENTINEL 原文');
  const agents = await scanAgents(project);
  assert.deepEqual(agents.map(item => item.name), ['alternate', 'inspector']);
  assert.equal(agents.find(item => item.name === 'inspector').scope, 'project');
  const role = 'PROJECT_ROLE_SENTINEL\n第二行规则原样保留。';
  assert.equal(agents.find(item => item.name === 'inspector').prompt, role);

  const base = bridge.session.systemPrompt;
  const hook = async () => buildSystemPrompt((await bridge.session.extensionRunner.emitBeforeAgentStart('检查提示词', undefined, {
    cwd: project,
    forceSystemPrompt: base,
  })).systemPromptOptions);
  const injected = await hook();
  assert.ok(injected.startsWith(`${base}\n\n${policy}`), 'Delivery policy must be appended verbatim to the actual SDK base prompt');
  assert.equal(injected.split(policy).length - 1, 1, 'One turn must include exactly one delivery policy');
  assert.ok(injected.endsWith(`# 当前智能体设定：inspector\n\n${role}`));
  assert.ok(!injected.includes('USER_ROLE_SENTINEL'), 'Project agent must override the same user agent');
  assert.match(injected, /# 多服务器协作/);
  assert.match(injected, /"status":"没有打开预览"/);

  fs.writeFileSync(projectAgentFile, '---\nname: inspector\n---\nUPDATED_ROLE_SENTINEL\n');
  const updated = await hook();
  assert.ok(updated.endsWith('# 当前智能体设定：inspector\n\nUPDATED_ROLE_SENTINEL'), 'Agent edits must apply on the next turn without restart');
  assert.ok(!updated.includes('PROJECT_ROLE_SENTINEL'));
  store.set('defaultAgent', '');
  const unselected = await hook();
  assert.ok(!unselected.includes('# 当前智能体设定：'));
  assert.ok(unselected.includes(policy), 'Unselecting a custom role must retain delivery rules');

  const userSystem = 'USER_SYSTEM_SENTINEL\n逐字保留。\n';
  const projectSystem = 'PROJECT_SYSTEM_SENTINEL\n逐字保留。\n';
  const userAppend = 'USER_APPEND_SENTINEL\n';
  const projectAppend = 'PROJECT_APPEND_SENTINEL\n';
  write('.pi/agent/SYSTEM.md', userSystem);
  write('.pi/agent/APPEND_SYSTEM.md', userAppend);
  const projectSystemFile = write('project/.pi/SYSTEM.md', projectSystem);
  const projectAppendFile = write('project/.pi/APPEND_SYSTEM.md', projectAppend);
  await bridge.session.reload();
  assert.equal(loader.getSystemPrompt(), projectSystem, 'Trusted project SYSTEM.md retains priority over user SYSTEM.md');
  assert.deepEqual(loader.getAppendSystemPrompt(), [projectAppend]);
  assert.ok(bridge.session.systemPrompt.startsWith(projectSystem.trim()));
  assert.ok(bridge.session.systemPrompt.includes(projectAppend.trim()));
  const customInjected = buildSystemPrompt((await bridge.session.extensionRunner.emitBeforeAgentStart('检查自定义系统提示', undefined, {
    cwd: project,
    forceSystemPrompt: bridge.session.systemPrompt,
  })).systemPromptOptions);
  assert.ok(customInjected.includes(projectSystem.trim()));
  assert.ok(customInjected.includes(policy));
  fs.unlinkSync(projectSystemFile);
  fs.unlinkSync(projectAppendFile);
  await bridge.session.reload();
  assert.equal(loader.getSystemPrompt(), userSystem);
  assert.deepEqual(loader.getAppendSystemPrompt(), [userAppend]);
  assert.ok(bridge.session.systemPrompt.startsWith(userSystem.trim()));
  assert.deepEqual(promptHashes(), before, 'Bundled prompt sources must remain byte-identical during the regression');
  isolated.assertOffline();

  fs.mkdirSync(path.join(root, 'test', 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'results', 'kernel-prompts.json'), JSON.stringify({
    at: new Date().toISOString(), sdkVersion, isolated: true, networkRequests: isolated.networkRequests,
    skills: skillNames, contextFiles: contexts.length, promptTemplates: templates.map(item => item.name),
    checked: ['verbatim-delivery-policy', 'project-agent-priority', 'dynamic-agent-reload', 'unselect-agent', 'SYSTEM-priority', 'APPEND_SYSTEM-priority'],
    promptHashes: before,
  }, null, 2));
  console.log(`PASS kernel ${sdkVersion} real resource loader, ${skillNames.length} bundled skills, AGENTS.md, prompt templates, verbatim delivery policy and dynamic custom agents (0 network requests)`);
} finally {
  try { await bridge?.dispose(); } finally { isolated.restore(); }
}
