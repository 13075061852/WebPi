import assert from 'node:assert/strict';
import { GitHubAuth } from '../src/main/github-auth.mjs';

const calls = [];
let accounts = 'octocat\nsecond-user', failure = false;
const auth = new GitHubAuth({ run: async (args) => {
  calls.push(args);
  if (args.includes('login') && failure) throw Error('Cancelled');
  if (args.includes('list')) return accounts;
  if (args.includes('logout')) accounts = 'second-user';
  return '';
} });
assert.deepEqual((await auth.status()).accounts, ['octocat', 'second-user']);
assert.equal((await auth.login()).busy, false);
assert.ok(calls.some(args => args.includes('--browser')));
assert.deepEqual(calls.find(args => args[0] === 'config'), ['config', '--global', '--replace-all', 'credential.https://github.com.helper', 'manager']);
assert.deepEqual((await auth.logout('octocat')).accounts, ['second-user']);
await assert.rejects(auth.logout('--arbitrary-option'), /未找到/);
calls.length = 0; failure = true;
await assert.rejects(auth.login(), /Cancelled/);
assert.equal(auth.busy, false);
assert.equal(calls.some(args => args[0] === 'config'), false, 'Failed login must not alter Git config');
const missing = new GitHubAuth({run: async () => { throw Error('Git unavailable'); }});
assert.equal((await missing.status()).available, false);
assert.equal(calls.some(args => args.includes('push') || args.includes('pull')), false);
console.log('PASS GitHub accounts, browser login, host-scoped helper, logout, failed login and missing Git');
