// 使用獨立 userData 與虛構金鑰驗證真正的 Electron safeStorage。
if (process.versions.electron) {
  const { app, safeStorage } = require('electron');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const Module = require('node:module');

  const profile = process.env.SETTINGS_TEST_PROFILE;
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();

  app.whenReady().then(() => {
    const storePath = require.resolve('../src/components/settings-store');
    const originalLoad = Module._load;
    Module._load = function (request, parent, ...rest) {
      if (parent?.filename === storePath && request === './logger') return { info() {}, error() {} };
      return originalLoad.call(this, request, parent, ...rest);
    };
    let SettingsStore;
    try {
      SettingsStore = require(storePath);
    } finally {
      Module._load = originalLoad;
    }

    const configPath = path.join(profile, 'config.json');
    const dummyKey = 'isolated-test-key';
    fs.writeFileSync(configPath, JSON.stringify({ apiKey: dummyKey, model: 'isolated-model' }));
    const first = new SettingsStore();
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    assert.equal(first.get('apiKey'), dummyKey);
    assert.equal(stored.model, 'isolated-model');
    if (process.platform === 'win32') assert.equal(encryptionAvailable, true, 'Windows DPAPI 應可用');
    if (encryptionAvailable) {
      assert.equal(stored.apiKey.encrypted, true);
      assert.notEqual(stored.apiKey.value, dummyKey);
      assert.equal(new SettingsStore().get('apiKey'), dummyKey);
    } else {
      assert.equal(stored.apiKey, dummyKey);
    }
    // 不在 ready 回呼中立即 exit：Windows 的 Chromium 執行緒可能仍在啟動。
    setImmediate(() => app.quit());
  }).catch((error) => {
    console.error(error.stack || error);
    setImmediate(() => app.exit(1));
  });
} else {
  const test = require('node:test');
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { promisify } = require('node:util');

  test('真實 Electron safeStorage 在隔離設定檔中執行遷移與重載', { timeout: 60000 }, async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(tempRoot, 'voice-typer-settings-electron-'));
    try {
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        DISPLAY: process.env.DISPLAY,
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        APPDATA: profile,
        LOCALAPPDATA: profile,
        USERPROFILE: profile,
        XDG_CACHE_HOME: profile,
        XDG_CONFIG_HOME: profile,
        XDG_DATA_HOME: profile,
        TEMP: profile,
        TMP: profile,
        SETTINGS_TEST_PROFILE: profile
      };
      await promisify(execFile)(require('electron'), [`--user-data-dir=${profile}`, __filename], {
        env, timeout: 50000, maxBuffer: 1024 * 1024
      });
    } finally {
      const resolvedProfile = fs.realpathSync(profile);
      if (path.dirname(resolvedProfile) !== tempRoot || !path.basename(resolvedProfile).startsWith('voice-typer-settings-electron-')) {
        // eslint-disable-next-line no-unsafe-finally -- 禁止清理測試目錄以外的路徑。
        throw new Error(`Refusing to remove unexpected test directory: ${resolvedProfile}`);
      }
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
    }
  });
}
