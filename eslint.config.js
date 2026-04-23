import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'generated/'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {
      'import-x': importX,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-confusing-void-expression': 'error',
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: { attributes: false },
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      'no-unused-expressions': 'off',
      'import-x/no-duplicates': 'error',
      'no-empty-function': 'off',
      'import-x/extensions': ['error', 'ignorePackages', { ts: 'always', js: 'always', checkTypeImports: true }],
    },
  },
  prettier
);
