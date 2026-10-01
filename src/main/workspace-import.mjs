import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { isInsideWorkspace } from './workspace-path.mjs';

export async function importWorkspaceFiles(root, target, sources) {
  if (!isInsideWorkspace(root, target) || !(await fs.stat(target)).isDirectory()) throw Error('导入位置不在当前项目内');
  const destination = await fs.realpath(target);
  const imported = [], failed = [];
  for (const source of sources) {
    try {
      if (!(await fs.stat(source)).isFile()) throw Error('请选择文件');
      const name = path.basename(source), parsed = path.parse(name);
      if (await fs.realpath(source) === path.join(destination, name)) throw Error('文件已在此目录');
      for (let index = 0; ; index++) {
        const output = path.join(destination, index ? `${parsed.name} (${index})${parsed.ext}` : name);
        try {
          await fs.copyFile(source, output, constants.COPYFILE_EXCL);
          imported.push(output); break;
        } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    } catch (error) { failed.push({ name: path.basename(source), error: error.message }); }
  }
  return { imported, failed };
}
