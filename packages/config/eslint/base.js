// ESLint 9 flat config. Package бүр `eslint.config.js`-даа: module.exports = require('@los/config/eslint/base.js');
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  { ignores: ['dist/**', '.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // Scaffold stub-уудын `_`-ээр эхэлсэн ашиглагдаагүй параметрийг зөвшөөрнө
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
