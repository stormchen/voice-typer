const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const mainPath = require.resolve('../src/main');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-typer-main-test-'));
  const events = [];
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => dir;
  app.quit = () => {};
  app.isPackaged = false;
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, fn) => handlers.set(name, fn);
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, data) => events.push({ channel, data });
      windows.push(this);
    }
    loadFile() {}
    isDestroyed() { return false; }
    isFocused() { return false; }
  }
  let hotkey;
  const rejectedHotkeys = new Set();
  const globalShortcut = {
    unregisterAll() {},
    register: (key, fn) => {
      if (rejectedHotkeys.has(key)) return false;
      hotkey = fn;
      return true;
    }
  };
  const pendingTranscriptions = [];
  let configUpdates = 0;
  class ASRClient {
    transcribe() { return new Promise((resolve) => pendingTranscriptions.push(resolve)); }
    updateConfig() { configUpdates++; }
  }
  const pasted = [];
  const clipboardManager = { paste: async (text, mode) => pasted.push({ text, mode }) };
  const settings = { hotkey: 'Ctrl+Shift+V', maxRecordSeconds: 120, pasteMode: 'copy-only' };
  const storeControl = { saveSucceeds: false, setSucceeds: true, lastSave: null, status: { decryptionFailed: false, warning: '' } };
  const store = {
    getAll: () => ({ ...settings }),
    get: (key) => settings[key],
    set: (key, value) => {
      if (!storeControl.setSucceeds) return false;
      settings[key] = value;
      return true;
    },
    setAll: (values, options) => { storeControl.lastSave = { values, options }; return storeControl.saveSucceeds; },
    getSecurityStatus: () => storeControl.status
  };
  class SettingsStore { constructor() { return store; } }
  class TrayManager { setRecordingState() {} }
  const logger = { info() {}, error() {} };
  const stubs = {
    electron: { app, BrowserWindow, globalShortcut, ipcMain, clipboard: { writeText() {} } },
    './components/tray-manager': TrayManager,
    './components/api-client': ASRClient,
    './components/clipboard': clipboardManager,
    './components/settings-store': SettingsStore,
    './components/logger': logger
  };

  const originalLoad = Module._load;
  delete require.cache[mainPath];
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === mainPath && Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, ...rest);
  };
  try {
    require(mainPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
  }
  await Promise.resolve();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const currentId = () => events.filter((event) => event.channel === 'start-recording').at(-1)?.data?.id;
  return {
    events, windows, handlers, pasted, storeControl,
    toggle: () => hotkey(),
    currentId,
    rejectHotkey: (key) => rejectedHotkeys.add(key),
    audioCaptured: (audio, id = currentId()) => ipcMain.listeners('audio-captured')[0](null, { id, audio }),
    audioError: (message, id = currentId()) => ipcMain.listeners('audio-error')[0](null, { id, message }),
    resolve: (text) => pendingTranscriptions.forEach((resolve) => resolve(text)),
    transcriptionCount: () => pendingTranscriptions.length,
    configUpdates: () => configUpdates
  };
}

test('錄音狀態機等候介面就緒並在辨識期間忽略新快捷鍵', async (t) => {
  const f = await fixture(t);
  f.toggle();
  assert.equal(f.events.some((event) => event.channel === 'start-recording'), false);
  f.windows[0].webContents.emit('did-finish-load');
  f.toggle();
  f.toggle();
  const pending = f.audioCaptured(new Uint8Array([1, 2]).buffer);
  f.toggle();
  assert.equal(f.events.filter((event) => event.channel === 'start-recording').length, 1);
  f.resolve('測試結果');
  await pending;
  assert.deepEqual(f.pasted, [{ text: '測試結果', mode: 'copy-only' }]);
  assert.equal(f.events.some((event) => event.channel === 'recognition-complete'), true);
});

test('重複音訊與遲到的錄音錯誤不會啟動第二次辨識或中斷進行中的辨識', async (t) => {
  const f = await fixture(t);
  f.windows[0].webContents.emit('did-finish-load');
  f.toggle();
  f.toggle();
  const first = f.audioCaptured(new Uint8Array([1]).buffer);
  const duplicate = f.audioCaptured(new Uint8Array([2]).buffer);
  f.audioError('遲到的錄音錯誤');
  f.toggle();
  const count = f.transcriptionCount();
  f.resolve('測試結果');
  await Promise.all([first, duplicate]);
  assert.equal(count, 1);
  assert.equal(f.events.filter((event) => event.channel === 'start-recording').length, 1);
  assert.equal(f.pasted.length, 1);
});

test('錄音錯誤會回到待機並允許重新錄音', async (t) => {
  const f = await fixture(t);
  f.windows[0].webContents.emit('did-finish-load');
  f.toggle();
  f.audioError('麥克風無法使用');
  f.toggle();
  f.audioError('停止測試');
  assert.equal(f.events.filter((event) => event.channel === 'start-recording').length, 2);
  assert.equal(f.events.some((event) => event.channel === 'error' && event.data.message === '麥克風無法使用'), true);
});

test('前次錄音逾時後，遲到的音訊和錯誤不得干擾新錄音', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t);
  f.windows[0].webContents.emit('did-finish-load');
  f.toggle();
  const oldId = f.currentId();
  f.toggle();
  t.mock.timers.tick(15000);
  f.toggle();
  const newId = f.currentId();
  f.toggle();
  assert.notEqual(oldId, newId);
  f.audioError('舊錄音失敗', oldId);
  const stale = f.audioCaptured(new Uint8Array([1]).buffer, oldId);
  const current = f.audioCaptured(new Uint8Array([2]).buffer, newId);
  const count = f.transcriptionCount();
  f.resolve('新錄音');
  await Promise.all([stale, current]);
  assert.equal(count, 1);
  assert.deepEqual(f.pasted, [{ text: '新錄音', mode: 'copy-only' }]);
});

test('設定無法落盤時回報失敗且不更新辨識後端', async (t) => {
  const f = await fixture(t);
  const result = f.handlers.get('save-settings')(null, { hotkey: 'Ctrl+Shift+V' });
  assert.equal(result.ok, false);
  assert.equal(f.configUpdates(), 0);
});

test('設定介面可顯示安全警告並明確清除無法解密的金鑰', async (t) => {
  const f = await fixture(t);
  f.storeControl.status = { decryptionFailed: true, warning: '無法解密測試金鑰' };
  const loaded = f.handlers.get('get-settings')();
  assert.equal(loaded.apiKeyDecryptionFailed, true);
  assert.equal(loaded.apiKeyWarning, '無法解密測試金鑰');

  f.storeControl.saveSucceeds = true;
  const result = f.handlers.get('save-settings')(null, {
    hotkey: 'Ctrl+Shift+V', apiKey: '', clearUnavailableApiKey: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.warning, '無法解密測試金鑰');
  assert.equal(f.storeControl.lastSave.options.clearEncryptedKey, true);
  assert.equal(Object.hasOwn(f.storeControl.lastSave.values, 'clearUnavailableApiKey'), false);
});

test('快捷鍵註冊失敗時明確說明其他設定已儲存', async (t) => {
  const f = await fixture(t);
  f.storeControl.saveSucceeds = true;
  f.rejectHotkey('Ctrl+Alt+X');
  const result = f.handlers.get('save-settings')(null, {
    hotkey: 'Ctrl+Alt+X', apiKey: '', clearUnavailableApiKey: true
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /其他設定已儲存/);
  assert.doesNotMatch(result.message, /已保留原設定/);
});

test('原快捷鍵無法恢復或寫回時提示使用者重新設定', async (t) => {
  const f = await fixture(t);
  f.storeControl.saveSucceeds = true;
  f.rejectHotkey('Ctrl+Alt+X');
  f.rejectHotkey('Ctrl+Shift+V');
  const result = f.handlers.get('save-settings')(null, { hotkey: 'Ctrl+Alt+X' });
  assert.equal(result.ok, false);
  assert.match(result.message, /其他設定已儲存/);
  assert.match(result.message, /恢復失敗/);
});
