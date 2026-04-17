import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { importX } from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'generated/'],
  },
  {
    files: ['**/*.ts'],
    plugins: {
      'import-x': importX,
    },
    extends: [...tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-unused-vars': 'off',
      'import-x/no-duplicates': 'error',
      'no-empty-function': 'off',
      'import-x/extensions': ['error', 'ignorePackages', { ts: 'never', js: 'always' }],
    },
  }
);
