import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    // `android/` is a generated native project: Capacitor writes the Gradle
    // scaffolding and copies the built web bundle into
    // android/app/src/main/assets/public. Linting it means linting our own
    // minified output plus vendored cordova shims.
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'android/**']
  },
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
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node }
  },
  {
    // The Android target compiles src/main into a WebView bundle, so its own
    // sources live in both worlds: browser APIs plus the Node globals the
    // shims stand in for.
    files: ['src/android/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  {
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node }
  }
)
