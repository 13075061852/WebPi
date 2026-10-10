import { Linter } from 'eslint';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const linter = new Linter();
const equalityMethods = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual']);
const propertyName = node => node?.computed ? node.property?.value : node?.property?.name;
const contains = (node, predicate) => {
  if (!node || typeof node !== 'object') return false;
  if (predicate(node)) return true;
  return Object.entries(node).some(([key, value]) => key !== 'parent' && (Array.isArray(value)
    ? value.some(item => contains(item, predicate)) : contains(value, predicate)));
};

// Intentionally narrow: a single assertion mixes an explicitly injected OS with
// a host-dependent expected value. A genuine host-only branch is allowed.
const rule = {
  meta: { type: 'problem', schema: [], messages: {
    hostExpected: 'An explicitly injected platform must have a fixture-defined expected value, not process.platform/os.platform().',
  } },
  create(context) {
    const assertions = new Set(), equalities = new Set(), osObjects = new Set(), osPlatforms = new Set();
    const hostPlatform = node => (node.type === 'MemberExpression' && node.object?.type === 'Identifier'
      && node.object.name === 'process' && propertyName(node) === 'platform')
      || (node.type === 'CallExpression' && ((node.callee.type === 'Identifier' && osPlatforms.has(node.callee.name))
        || (node.callee.type === 'MemberExpression' && osObjects.has(node.callee.object?.name) && propertyName(node.callee) === 'platform')));
    return {
      ImportDeclaration(node) {
        if (['node:assert', 'node:assert/strict', 'assert', 'assert/strict'].includes(node.source.value)) {
          for (const item of node.specifiers) {
            if (item.type === 'ImportDefaultSpecifier' || item.type === 'ImportNamespaceSpecifier') assertions.add(item.local.name);
            else if (equalityMethods.has(item.imported.name)) equalities.add(item.local.name);
          }
        }
        if (['node:os', 'os'].includes(node.source.value)) for (const item of node.specifiers) {
          if (item.type === 'ImportDefaultSpecifier' || item.type === 'ImportNamespaceSpecifier') osObjects.add(item.local.name);
          else if (item.imported.name === 'platform') osPlatforms.add(item.local.name);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        const assertion = (callee.type === 'Identifier' && equalities.has(callee.name))
          || (callee.type === 'MemberExpression' && assertions.has(callee.object?.name) && equalityMethods.has(propertyName(callee)));
        if (!assertion || node.arguments.length < 2) return;
        const explicitPlatform = contains(node.arguments[0], value => value.type === 'Property'
          && (value.computed ? value.key.value : value.key.name ?? value.key.value) === 'platform'
          && value.value?.type === 'Literal' && ['win32', 'linux', 'darwin'].includes(value.value.value));
        if (explicitPlatform && contains(node.arguments[1], hostPlatform)) context.report({ node: node.arguments[1], messageId: 'hostExpected' });
      },
    };
  },
};

export function fixturePortabilityMessages(source) {
  return linter.verify(source, [{ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { fixture: { rules: { portability: rule } } }, rules: { 'fixture/portability': 'error' } }]);
}

export function checkFixturePortability(directory = path.join(root, 'test')) {
  const issues = [];
  let files = 0;
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !['results', 'node_modules'].includes(entry.name)) visit(file);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) {
        files++;
        for (const message of fixturePortabilityMessages(readFileSync(file, 'utf8'))) issues.push({ file: path.relative(root, file), ...message });
      }
    }
  };
  visit(directory);
  return { files, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, issues } = checkFixturePortability();
  for (const issue of issues) console.error(`${issue.file}:${issue.line}:${issue.column} ${issue.message}`);
  console.log(`Fixture portability: ${files} files, ${issues.length} issues`);
  process.exitCode = issues.length ? 1 : 0;
}
