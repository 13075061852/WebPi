/* Pi Halo — ESLint flat config（开发期静态检查，不参与构建） */
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", "src/renderer/vendor/**", "test/*.png"],
  },
  // 主进程 / preload / 脚本：Node 环境
  {
    files: ["src/main/**/*.mjs", "src/preload/**/*.cjs", "scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-redeclare": "error",
      "no-extra-semi": "warn",
    },
  },
  // 渲染层经典脚本（markdown.js / nebula.js / splash.js / theme.js）：顶层声明即全局
  {
    files: ["src/renderer/js/{markdown,nebula,splash,theme}.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: globals.browser,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-redeclare": "error",
    },
  },
  // 渲染层模块（app.js）：引用经典脚本的全局
  {
    files: ["src/renderer/js/app.js", "src/renderer/js/layout-motion.mjs", "src/renderer/js/modal-motion.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // markdown.js / nebula.js / vendor 暴露的全局
        esc: "readonly", escFile: "readonly", rich: "readonly", mdRender: "readonly",
        hlFile: "readonly", langOf: "readonly", streamRender: "readonly",
        mdStreamSplit: "readonly", previewURL: "readonly",
        Terminal: "readonly", FitAddon: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      "no-cond-assign": ["error", "except-parens"],
      "no-redeclare": "error",
      "no-extra-semi": "warn",
    },
  },
  // 测试脚本：宽松（一次性探针为主），只查硬错误
  {
    files: ["test/**/*.{mjs,cjs,js}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
      "no-dupe-keys": "error",
    },
  },
];
