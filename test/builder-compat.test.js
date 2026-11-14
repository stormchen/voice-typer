const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { files } = require('../electron-builder.json');
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { FileMatcher } = appBuilderRequire('./fileMatcher');

test('已修補 minimatch 可供 electron-builder 篩選正式打包檔案', () => {
  const root = path.resolve(__dirname, '..');
  const matcher = new FileMatcher(root, root, (value) => value, files);
  const include = matcher.createFilter();
  const file = { isDirectory: () => false };
  for (const name of ['src/main.js', 'public/index.html', 'public/recorder-worklet.js', 'package.json']) {
    assert.equal(include(path.join(root, name), file), true, name);
  }
  for (const name of ['test/main.test.js', '.env', 'README.md']) {
    assert.equal(include(path.join(root, name), file), false, name);
  }
});

test('已修補 minimatch 保留 macOS universal 打包使用的 matchBase 介面', () => {
  const universalRequire = createRequire(appBuilderRequire.resolve('@electron/universal'));
  const { minimatch } = universalRequire('minimatch');
  assert.equal(minimatch('VoiceTyper.app/Contents/Resources/app.asar', '*.asar', { matchBase: true }), true);
  assert.equal(minimatch('VoiceTyper.app/Contents/Resources/app.asar', '*.node', { matchBase: true }), false);
});
