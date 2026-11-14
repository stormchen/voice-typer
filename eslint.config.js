const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.{js,cjs}'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // API 錯誤刻意不附帶可能含驗證資訊的底層 request 物件。
      'preserve-caught-error': 'off'
    }
  },
  {
    files: ['src/**/*.js', 'scripts/**/*.js', 'test/**/*.{js,cjs}', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly'
      }
    }
  },
  {
    files: ['public/renderer.js'],
    languageOptions: { globals: { WebAudioRecorder: 'readonly' } }
  }
];
