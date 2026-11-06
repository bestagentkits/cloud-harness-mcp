import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'plans/**', 'work/**', 'docs-site/.vitepress/cache/**', 'apps/dashboard/src/routeTree.gen.ts', 'apps/dashboard/test-results/**', 'apps/dashboard/playwright-report/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat['recommended-latest']
  },
  {
    files: ['worker/**/*.mjs', 'scripts/**/*.mjs', 'deploy/**/*.mjs', 'apps/dashboard/scripts/**/*.mjs', 'apps/dashboard/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        Response: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['apps/dashboard/public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        document: 'readonly',
        window: 'readonly'
      }
    }
  },
  {
    files: ['site/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        localStorage: 'readonly',
        window: 'readonly'
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
    },
    rules: {
      // The browser's deprecated escape() percent-encodes instead of HTML-escaping, and a missing
      // import of the renderer's helper silently falls through to it.
      'no-restricted-globals': ['error',
        { name: 'escape', message: 'Use escapeHtml from dashboard-render.js for markup.' },
        { name: 'unescape', message: 'Use decodeURIComponent.' }]
    }
  }
);
