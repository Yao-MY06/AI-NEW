// ESLint flat config：JS 推荐 + TS 推荐（项目为 ESM + tsx 运行，无构建产物）
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'output', 'data', 'logs', '.playwright-cli'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // 项目现状为严格 TS、零 any；允许带警告出现（如三方类型不匹配的受控断言场景）
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
