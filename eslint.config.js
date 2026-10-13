import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'plans/**', 'work/**', 'docs-site/.vitepress/cache/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['worker/**/*.mjs', 'scripts/**/*.mjs', 'deploy/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['apps/api/dashboard/**/*.js'],
    languageOptions: {
      globals: {
        addEventListener: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        history: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        matchMedia: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  }
);
