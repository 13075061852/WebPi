import fs from 'node:fs';
let catalog;
const library = () => catalog ||= JSON.parse(fs.readFileSync(new URL('../../assets/icons/lucide.json', import.meta.url), 'utf8'));

export function iconLibraryTool() {
  return {
    name: 'icon_library', label: 'SVG 图标库',
    description: '离线 Lucide SVG 图标库。query 用英文语义搜索（lightbulb、shuffle、volume）；names 获取最多 12 个完整 SVG 和授权。可嵌入 HTML 或写入远程项目。禁止用 emoji 代替界面图标。',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: '英文名称或标签；空值列出前 40 项' },
      names: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    } },
    execute: async (_id, args, signal) => {
      if (signal?.aborted) throw Error('已取消');
      const data = library();
      let result;
      if (args.names !== undefined) {
        if (!Array.isArray(args.names) || !args.names.length || args.names.length > 12) throw Error('每次请选择 1–12 个图标');
        const icons = args.names.map(name => {
          if (typeof name !== 'string' || !Object.hasOwn(data.icons, name)) throw Error('未知图标：' + String(name));
          return { name, svg: data.icons[name] };
        });
        result = { library: 'Lucide', version: data.version, icons,
          license: fs.readFileSync(new URL('../../assets/icons/LICENSE', import.meta.url), 'utf8'),
          usage: 'SVG 内联 HTML，使用 currentColor；装饰图标加 aria-hidden="true"，纯图标按钮加 aria-label。随项目保留授权。React/Vue 使用项目现有 SVG 图标库或 lucide-react / lucide-vue-next 按需导入。' };
      } else {
        const words = String(args.query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
        const names = Object.keys(data.icons).filter(name => words.every(word =>
          [name, ...(data.tags[name] || [])].some(value => value.toLowerCase().includes(word))));
        result = { library: 'Lucide', version: data.version, total: names.length, names: names.slice(0, 40),
          next: '使用 names 参数获取 SVG；结果过多时缩小英文搜索词。' };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { library: 'Lucide' } };
    },
  };
}
