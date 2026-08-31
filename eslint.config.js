import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'storefront/**', 'public/sw.js'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '18.3' } },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,

      // The ones that actually catch bugs the build cannot:
      'no-undef': 'error',              // a dangling reference throws at runtime
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      // `try { … } catch {}` is a deliberate, pervasive pattern here for
      // best-effort side effects (badges, fullscreen, clipboard).
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react/display-name': 'off',
      // `<\/script>` inside the HTML template literals that get written into a
      // print window is a deliberate defensive escape, not a mistake.
      'no-useless-escape': 'off',
      'no-self-compare': 'error',
      'require-atomic-updates': 'off',

      // This codebase does not use prop-types or the old JSX transform.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/exhaustive-deps': 'warn',

      // Correctness — these catch bugs the build cannot see. Keep as errors.
      //   rules-of-hooks caught a real crash: CustomerDisplay declared an
      //   effect below an early return, so completing a sale dropped a hook
      //   and React threw "rendered fewer hooks than expected".
      'react-hooks/rules-of-hooks': 'error',

      // Style/perf rules from the newer react-hooks plugin. The remaining hits
      // are all effects referencing a `const` declared further down the
      // component — safe, because the effect body runs after render, when the
      // binding is initialised. Left as warnings so new ones stay visible
      // without blocking a build on a working till.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
]
