import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled SKILL.md metadata uses plain, single-line name/description fields.
// Read application assets only: this list must not depend on a session or user packages.
export function listBuiltinSkills(settings = {}) {
  const disabled = new Set(settings.disabledBuiltinSkills || []);
  const root = fileURLToPath(new URL('../../assets/skills/', import.meta.url));
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const file = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!header) throw Error(`内置技能元数据缺失：${entry.name}`);
    const field = key => header[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^("|')(.*)\1$/, '$2') || '';
    const name = field('name'), description = field('description');
    if (!name || !description) throw Error(`内置技能元数据不完整：${entry.name}`);
    const title = raw.slice(header[0].length).match(/^#\s+(.+)$/m)?.[1]?.trim() || name;
    return [{ name, title, description, type: 'skill', enabled: !disabled.has(name) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function setBuiltinSkillEnabled(store, name, enabled) {
  if (typeof enabled !== 'boolean' || !listBuiltinSkills().some(item => item.name === name)) {
    throw Error('无效的内置技能配置');
  }
  const disabled = new Set(store.data.disabledBuiltinSkills || []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  store.set('disabledBuiltinSkills', [...disabled]);
  return listBuiltinSkills(store.data);
}

export function filterBuiltinSkills(result, settings) {
  const disabled = new Set(settings.disabledBuiltinSkills || []);
  const root = fileURLToPath(new URL('../../assets/skills/', import.meta.url));
  return { ...result, skills: result.skills.filter(skill => {
    const relative = path.relative(root, skill.filePath || '');
    const builtin = relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    return !builtin || !disabled.has(skill.name);
  }) };
}

export function builtinDeliveryPolicy(policy, settings) {
  const disabled = settings.disabledBuiltinSkills || [];
  if (!disabled.length) return policy;
  // Remove forced skill routing from the shared policy when that skill is off.
  return policy.split('\n').filter(line => !disabled.some(name => line.includes('`' + name + '`'))).join('\n');
}
