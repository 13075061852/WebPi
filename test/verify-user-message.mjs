import assert from 'node:assert/strict';
import {userMessageText} from '../src/renderer/js/user-message.mjs';
const expanded='<skill name="halo-imagegen" location="C:\\skills\\SKILL.md">\nReferences are relative to C:\\skills.\n\nInternal instructions\n</skill>\n\n生成指定的图片';
assert.equal(userMessageText(expanded),'/skill:halo-imagegen 生成指定的图片');
assert.equal(userMessageText(expanded.replaceAll('\n','\r\n')),'/skill:halo-imagegen 生成指定的图片');
for(const text of ['普通正文','/skill:halo-imagegen 生图','解释 <skill name="x">abc</skill>','```xml\n'+expanded+'\n```'])assert.equal(userMessageText(text),text);
assert.equal(userMessageText(expanded.slice(0,expanded.indexOf('</skill>'))),expanded.slice(0,expanded.indexOf('</skill>')));
console.log('PASS skill display projection and literal text preservation');
