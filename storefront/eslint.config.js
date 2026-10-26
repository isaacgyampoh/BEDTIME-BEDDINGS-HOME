import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

// Kept deliberately in step with the root config — which it was not: without
// eslint-plugin-react there is no `react/jsx-uses-vars`, so `no-unused-vars`
// could not see that a component was used in JSX. It reported Card, Timer and
// VoiceShopper as unused while they were rendering on the live site, and that
// noise is where a genuinely unused variable goes to hide. The storefront was still on
// the stock Vite scaffold, which made every React-compiler hint an error, so
// `npm run lint` here reported 18 failures that were mostly style — and the
// real ones got lost in them. Same severities as the admin now, so a finding
// means the same thing on both sides of the codebase.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { react },
    settings: { react: { version: '19.0' } },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Catch bugs the build cannot see.
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-self-compare': 'error',
      'react-hooks/rules-of-hooks': 'error',

      // Makes a component used in JSX count as used.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Best-effort side effects (localStorage in a private window) genuinely
      // have nothing to do on failure.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // React-compiler hints. Real signal, but the analysis cannot tell that
      // `placeOrder` and `go` only ever run from a click, so it reads their
      // Date.now() and location.hash writes as render-time impurity. Warnings,
      // so new ones stay visible without blocking a deploy.
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
])
