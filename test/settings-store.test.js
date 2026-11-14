const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const storePath = require.resolve('../src/components/settings-store');

function fixture(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-typer-settings-test-'));
  const configPath = path.join(dir, 'config.json');
  if (initial) fs.writeFileSync(configPath, JSON.stringify(initial));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = { available: true, backend: 'gnome_libsecret', failDecrypt: false, failEncrypt: false, failRename: false, failWrite: false, logs: [] };
  const safeStorage = {
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => state.backend,
    encryptString: (value) => {
      if (state.failEncrypt) throw new Error('encryption unavailable');
      return Buffer.from(`encrypted:${value}`);
    },
    decryptString: (value) => {
      if (state.failDecrypt) throw new Error('decryption unavailable');
      const text = value.toString();
      if (!text.startsWith('encrypted:')) throw new Error('invalid ciphertext');
      return text.slice('encrypted:'.length);
    }
  };
  const logger = {
    info: (message, data) => state.logs.push({ level: 'info', message, data }),
    error: (message, data) => state.logs.push({ level: 'error', message, data })
  };

  const originalLoad = Module._load;
  delete require.cache[storePath];
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === storePath && request === 'electron') {
      return { app: { getPath: () => dir }, safeStorage };
    }
    if (parent?.filename === storePath && request === 'fs') {
      return {
        ...fs,
        renameSync: (...args) => {
          if (state.failRename) throw new Error('rename failed');
          return fs.renameSync(...args);
        },
        writeFileSync: (...args) => {
          if (state.failWrite) {
            fs.writeFileSync(args[0], 'partial', args[2]);
            throw new Error('write failed');
          }
          return fs.writeFileSync(...args);
        }
      };
    }
    if (parent?.filename === storePath && request === './logger') return logger;
    return originalLoad.call(this, request, parent, ...rest);
  };
  let SettingsStore;
  try {
    SettingsStore = require(storePath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[storePath];
  }

  return {
    state,
    create: () => new SettingsStore(),
    read: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    files: () => fs.readdirSync(dir)
  };
}

const cipher = (value) => ({ encrypted: true, value: Buffer.from(`encrypted:${value}`).toString('base64') });

test('明文設定遷移時保留其他欄位，且重新載入可以解密', (t) => {
  const f = fixture(t, { apiKey: 'test-key', model: 'custom-model', hotkey: 'Ctrl+Alt+X' });
  const store = f.create();
  assert.equal(store.get('apiKey'), 'test-key');
  assert.deepEqual(f.read().apiKey, cipher('test-key'));
  assert.equal(f.read().model, 'custom-model');
  assert.equal(f.read().hotkey, 'Ctrl+Alt+X');
  assert.equal(f.create().get('apiKey'), 'test-key');
});

test('解密失敗後儲存其他設定時保留原密文，重新輸入金鑰後才替換', (t) => {
  const oldCipher = cipher('test-key');
  const f = fixture(t, { apiKey: oldCipher, model: 'old-model' });
  f.state.failDecrypt = true;
  const store = f.create();
  assert.equal(store.get('apiKey'), '');
  const result = store.setAll({ ...store.getAll(), model: 'new-model' });
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(f.read().model, 'new-model');
  assert.equal(result, true);
  f.state.failDecrypt = false;
  assert.equal(f.create().get('apiKey'), 'test-key');
  assert.equal(store.set('apiKey', 'replacement-key'), true);
  assert.deepEqual(f.read().apiKey, cipher('replacement-key'));
});

test('既有密文在加密服務暫時不可用時不得降級為明文', (t) => {
  const oldCipher = cipher('test-key');
  const f = fixture(t, { apiKey: oldCipher, model: 'old-model' });
  const store = f.create();
  f.state.available = false;
  const result = store.set('model', 'new-model');
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(result, true);
  assert.equal(store.set('apiKey', 'replacement-key'), false);
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(store.get('apiKey'), 'test-key');
});

test('加密失敗不回報遷移成功，設定更新失敗也不更動記憶體或檔案', (t) => {
  const f = fixture(t, { apiKey: 'test-key', model: 'old-model' });
  f.state.failEncrypt = true;
  const store = f.create();
  assert.equal(f.read().apiKey, 'test-key');
  assert.equal(f.state.logs.some((entry) => entry.level === 'info' && entry.message.includes('已遷移')), false);
  assert.equal(store.set('apiKey', 'replacement-key'), false);
  assert.equal(store.get('apiKey'), 'test-key');
  assert.equal(f.read().apiKey, 'test-key');
});

test('設定檔替換失敗時保留原內容並清理暫存檔', (t) => {
  const f = fixture(t, { apiKey: 'test-key', model: 'old-model' });
  f.state.failRename = true;
  const store = f.create();
  assert.deepEqual(f.read(), { apiKey: 'test-key', model: 'old-model' });
  assert.equal(f.state.logs.some((entry) => entry.level === 'info' && entry.message.includes('已遷移')), false);
  assert.equal(store.set('model', 'new-model'), false);
  assert.equal(store.get('model'), 'old-model');
  assert.deepEqual(f.files(), ['config.json']);
});

test('暫存檔寫入中斷時保留原設定並清理不完整檔案', (t) => {
  const f = fixture(t, { apiKey: cipher('test-key'), model: 'old-model' });
  const store = f.create();
  f.state.failWrite = true;
  assert.equal(store.set('model', 'new-model'), false);
  assert.equal(f.read().model, 'old-model');
  assert.deepEqual(f.read().apiKey, cipher('test-key'));
  assert.deepEqual(f.files(), ['config.json']);
});

test('可解密的金鑰可依使用者操作清除', (t) => {
  const f = fixture(t, { apiKey: cipher('test-key') });
  const store = f.create();
  assert.equal(store.set('apiKey', ''), true);
  assert.equal(f.read().apiKey, '');
  assert.equal(f.create().get('apiKey'), '');
});

test('沒有既有密文且加密服務不可用時，明文儲存會留下警告', (t) => {
  const f = fixture(t);
  f.state.available = false;
  const store = f.create();
  assert.match(store.getSecurityStatus().warning, /明文/);
  assert.equal(store.set('apiKey', 'test-key'), true);
  assert.equal(f.read().apiKey, 'test-key');
  assert.match(store.getSecurityStatus().warning, /明文/);
  assert.equal(f.state.logs.some((entry) => entry.level === 'error' && entry.message.includes('明文')), true);
});

test('加密服務不可用時讀取及儲存設定皆回報明文警告', (t) => {
  const f = fixture(t, { apiKey: 'fixture-key' });
  f.state.available = false;
  const store = f.create();

  assert.equal(store.getSecurityStatus().decryptionFailed, false);
  assert.match(store.getSecurityStatus().warning, /明文/);
  assert.match(store.getSecurityStatus().warning, /加密服務不可用/);
  assert.equal(store.set('model', 'updated-model'), true);
  assert.equal(f.read().apiKey, 'fixture-key');
  assert.match(store.getSecurityStatus().warning, /明文/);
  assert.match(f.create().getSecurityStatus().warning, /明文/);
});

test('Linux basic_text 即使可加密也會警告沒有金鑰鏈保護', (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const f = fixture(t);
    const store = f.create();
    assert.deepEqual(store.getSecurityStatus(), { decryptionFailed: false, warning: '' });
    f.state.backend = 'basic_text';
    assert.match(store.getSecurityStatus().warning, /basic_text/);
    assert.match(store.getSecurityStatus().warning, /未受.*金鑰鏈保護/);
    assert.equal(store.set('apiKey', 'fixture-key'), true);
    assert.deepEqual(f.read().apiKey, cipher('fixture-key'));
    assert.match(store.getSecurityStatus().warning, /未受.*金鑰鏈保護/);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('加密服務恢復後，明文警告保留至金鑰實際加密儲存', (t) => {
  const f = fixture(t, { apiKey: 'fixture-key' });
  f.state.available = false;
  const store = f.create();
  f.state.available = true;

  assert.match(store.getSecurityStatus().warning, /明文/);
  f.state.failEncrypt = true;
  assert.equal(store.set('model', 'updated-model'), false);
  assert.match(store.getSecurityStatus().warning, /明文/);
  f.state.failEncrypt = false;
  assert.equal(store.set('model', 'updated-model'), true);
  assert.deepEqual(f.read().apiKey, cipher('fixture-key'));
  assert.equal(store.getSecurityStatus().warning, '');
});

test('無法解密的舊金鑰只在明確清除且成功儲存後刪除', (t) => {
  const oldCipher = cipher('fixture-key');
  const f = fixture(t, { apiKey: oldCipher });
  f.state.failDecrypt = true;
  const store = f.create();

  assert.equal(store.getSecurityStatus().decryptionFailed, true);
  assert.equal(store.setAll({ model: 'updated-model' }, { clearEncryptedKey: false }), true);
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(store.getSecurityStatus().decryptionFailed, true);

  f.state.failRename = true;
  assert.equal(store.setAll({}, { clearEncryptedKey: true }), false);
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(store.getSecurityStatus().decryptionFailed, true);
  f.state.failRename = false;
  assert.equal(store.setAll({}, { clearEncryptedKey: true }), true);
  assert.equal(f.read().apiKey, '');
  assert.equal(store.getSecurityStatus().decryptionFailed, false);
  assert.equal(f.create().get('apiKey'), '');
  assert.equal(f.create().getSecurityStatus().decryptionFailed, false);
});

test('清除選項須為布林值，且替換失敗時仍保留舊密文', (t) => {
  const oldCipher = cipher('fixture-key');
  const f = fixture(t, { apiKey: oldCipher });
  f.state.failDecrypt = true;
  f.state.available = false;
  const store = f.create();

  assert.equal(store.setAll({}, { clearEncryptedKey: 'true' }), true);
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(store.setAll({ apiKey: 'replacement' }, { clearEncryptedKey: true }), false);
  assert.deepEqual(f.read().apiKey, oldCipher);
  assert.equal(store.get('apiKey'), '');
  assert.equal(store.getSecurityStatus().decryptionFailed, true);

  f.state.available = true;
  assert.equal(store.setAll({ apiKey: 'replacement' }, { clearEncryptedKey: true }), true);
  assert.deepEqual(f.read().apiKey, cipher('replacement'));
  assert.equal(store.getSecurityStatus().decryptionFailed, false);
});
