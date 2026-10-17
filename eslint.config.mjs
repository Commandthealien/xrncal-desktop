import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Provider payloads and IPC boundaries are genuinely untyped at the edge.
      // Surfaced as a warning so it reads as debt to pay down, not a CI blocker.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    // The two rules the plugin recommended before v7. v7's recommended set adds
    // the React Compiler rules (set-state-in-effect, refs, immutability, ...);
    // meeting them means restructuring effects in App.tsx, a change of its own.
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    },
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node }
  }
)
