import assert from 'node:assert/strict';
import {userMessageText, userMessageFiles} from '../src/renderer/js/user-message.mjs';
const expanded='<skill name="halo-imagegen" location="C:\\skills\\SKILL.md">\nReferences are relative to C:\\skills.\n\nInternal instructions\n</skill>\n\n生成指定的图片';
assert.equal(userMessageText(expanded),'/skill:halo-imagegen 生成指定的图片');
assert.equal(userMessageText(expanded.replaceAll('\n','\r\n')),'/skill:halo-imagegen 生成指定的图片');
for(const text of ['普通正文','/skill:halo-imagegen 生图','解释 <skill name="x">abc</skill>','```xml\n'+expanded+'\n```'])assert.equal(userMessageText(text),text);
assert.equal(userMessageText(expanded.slice(0,expanded.indexOf('</skill>'))),expanded.slice(0,expanded.indexOf('</skill>')));
console.log('PASS skill display projection and literal text preservation');
const attachments = '整理这些资料\n@"C:/微信文件/家长参与不足.docx"\n@"C:\\资料\\数据(1).XLSX"\n@"/tmp/原稿.pptx"\n@"\\\\server\\share\\报告.pdf"';
const projected = userMessageFiles(attachments);
assert.equal(projected.text, '整理这些资料');
assert.deepEqual(projected.files.map(file => file.name), ['家长参与不足.docx', '数据(1).XLSX', '原稿.pptx', '报告.pdf']);
assert.equal(projected.files[0].path, 'C:/微信文件/家长参与不足.docx');
assert.equal(userMessageFiles('@"C:/file.pdf"').text, '');
assert.equal(userMessageFiles(attachments.replaceAll('\n', '\r\n')).files.length, 4);
for (const literal of ['正文 @"C:/a.pdf"', '@"relative.pdf"', '@"https://example.com/a.pdf"', '    @"C:/a.pdf"', '```text\n@"C:/a.pdf"\n```', '~~~~\n@"C:/a.pdf"\n~~~~', '@"C:/a.pdf" 后面还有说明']) {
  assert.deepEqual(userMessageFiles(literal), { text: literal, files: [] });
}
assert.deepEqual(userMessageFiles('@"C:/<img onerror=alert(1)>.pdf"').files[0].name, '<img onerror=alert(1)>.pdf');
console.log('PASS display-only attachment projection, Windows/UNC/POSIX paths and literal/code preservation');
