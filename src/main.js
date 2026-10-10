// VoiceTyper - Electron 主程序
// 遠端 vLLM 伺服器（VibeVoice-ASR，OpenAI 相容 API）
const { app, BrowserWindow, globalShortcut, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const TrayManager = require('./components/tray-manager');
const ASRClient = require('./components/api-client');
const ClipboardManager = require('./components/clipboard');
const SettingsStore = require('./components/settings-store');
const logger = require('./components/logger');

// ===== 單一實例鎖：避免多開互搶全域快捷鍵 =====
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let settingsWindow = null;
let trayManager = null;
let asrClient = null;
let settingsStore = null;

// 狀態機：idle → recording → transcribing → idle
// 防止「辨識中再開新錄音」等競態
let state = 'idle';
let rendererReady = false;
let maxRecordTimer = null;   // 錄音時長上限
let stopSafetyTimer = null;  // 停止後等不到音頻資料的安全逾時

const MAX_HISTORY = 50;
let history = [];

// ===== 歷史記錄持久化 =====
function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function loadHistory() {
  try {
    if (fs.existsSync(historyPath())) {
      const data = JSON.parse(fs.readFileSync(historyPath(), 'utf-8'));
      if (Array.isArray(data)) history = data.slice(0, MAX_HISTORY);
    }
  } catch (error) {
    logger.error('讀取歷史失敗', { message: error.message });
  }
}

function saveHistory() {
  try {
    fs.writeFileSync(historyPath(), JSON.stringify(history, null, 2));
  } catch (error) {
    logger.error('儲存歷史失敗', { message: error.message });
  }
}

function addHistory(text) {
  history.unshift({ text, ts: Date.now() });
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  saveHistory();
  sendToMain('history-updated', history);
}

// ===== 視窗 =====
function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    show: false,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // 關鍵：視窗隱藏（常駐系統匣）時不節流，錄音才不會中斷
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

  mainWindow.webContents.once('did-finish-load', () => {
    rendererReady = true;
    sendToMain('history-updated', history);
  });

  // 關閉時隱藏而非退出（常駐系統匣）
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 620,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '../public/settings.html'));
}

// ===== 錄音狀態機 =====
function clearTimers() {
  if (maxRecordTimer) { clearTimeout(maxRecordTimer); maxRecordTimer = null; }
  if (stopSafetyTimer) { clearTimeout(stopSafetyTimer); stopSafetyTimer = null; }
}

function resetToIdle() {
  clearTimers();
  state = 'idle';
  trayManager.setRecordingState('idle');
}

function startRecording() {
  if (!rendererReady) {
    logger.error('渲染進程尚未就緒，無法開始錄音');
    return;
  }
  state = 'recording';
  trayManager.setRecordingState('recording');
  sendToMain('start-recording');
  sendToMain('recording-started');
  logger.info('開始錄音');

  // 錄音時長上限：避免忘記停止導致記憶體無限成長
  const maxSeconds = Number(settingsStore.get('maxRecordSeconds')) || 120;
  maxRecordTimer = setTimeout(() => {
    if (state === 'recording') {
      logger.info('達到錄音時長上限，自動停止', { maxSeconds });
      sendToMain('recording-limit', { maxSeconds });
      stopRecording();
    }
  }, maxSeconds * 1000);
}

function stopRecording() {
  clearTimers();
  state = 'transcribing';
  trayManager.setRecordingState('recognizing');
  sendToMain('stop-recording');
  sendToMain('recognizing');
  logger.info('停止錄音，等待音頻資料');

  // 安全逾時：渲染進程若未回傳音頻，強制復位避免卡死
  stopSafetyTimer = setTimeout(() => {
    if (state === 'transcribing') {
      logger.error('等待音頻資料逾時，狀態復位');
      resetToIdle();
      sendToMain('error', { message: '錄音資料處理逾時，請重試' });
    }
  }, 15000);
}

// 快捷鍵：idle 開始錄音；recording 停止並辨識；transcribing 忽略
function toggleRecording() {
  switch (state) {
    case 'idle':
      startRecording();
      break;
    case 'recording':
      stopRecording();
      break;
    default:
      logger.info('辨識進行中，忽略快捷鍵');
  }
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(accelerator, toggleRecording);
  } catch (error) {
    logger.error('快捷鍵註冊擲出例外', { accelerator, message: error.message });
  }
  if (!ok) {
    logger.error('快捷鍵註冊失敗', { accelerator });
  } else {
    logger.info('快捷鍵已註冊', { accelerator });
  }
  return ok;
}

function applyLaunchAtLogin(enabled) {
  // 開發模式下不設定，避免把 electron.exe 寫入開機啟動
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
  } catch (error) {
    logger.error('設定開機自啟失敗', { message: error.message });
  }
}

app.whenReady().then(() => {
  settingsStore = new SettingsStore();
  const config = settingsStore.getAll();
  loadHistory();

  createMainWindow();
  trayManager = new TrayManager(mainWindow, {
    onOpenSettings: () => createSettingsWindow()
  });

  asrClient = new ASRClient(config);

  const hotkey = config.hotkey || 'CommandOrControl+Shift+V';
  if (!registerHotkey(hotkey)) {
    // 首選失敗時退回預設，確保功能可用
    if (hotkey !== 'CommandOrControl+Shift+V' && registerHotkey('CommandOrControl+Shift+V')) {
      settingsStore.set('hotkey', 'CommandOrControl+Shift+V');
      sendToMain('error', { message: `快捷鍵 ${hotkey} 註冊失敗，已改回預設 Ctrl+Shift+V` });
    } else {
      sendToMain('error', { message: '快捷鍵註冊失敗，可能被其他程式佔用' });
    }
  }

  applyLaunchAtLogin(config.launchAtLogin);
});

// ===== IPC 通信 =====

// 渲染進程回傳錄音完成的 WAV 資料（ArrayBuffer）
ipcMain.on('audio-captured', async (event, arrayBuffer) => {
  if (state !== 'transcribing') {
    logger.info('非辨識狀態收到音頻資料，忽略');
    return;
  }
  if (stopSafetyTimer) { clearTimeout(stopSafetyTimer); stopSafetyTimer = null; }

  try {
    const audioBuffer = Buffer.from(arrayBuffer);
    logger.info('收到音頻資料', { bytes: audioBuffer.length });

    const text = await asrClient.transcribe(audioBuffer);
    logger.info('辨識完成', { chars: (text || '').length });

    if (text && text.trim()) {
      // 焦點若在 VoiceTyper 自身視窗上，只複製、不模擬貼上（避免貼回自己）
      const selfFocused =
        (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) ||
        (settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.isFocused());

      const pasteMode = selfFocused ? 'copy-only' : (settingsStore.get('pasteMode') || 'ctrl-v');
      await ClipboardManager.paste(text, pasteMode);
      addHistory(text.trim());
    }

    resetToIdle();
    sendToMain('recognition-complete', { text });
  } catch (error) {
    logger.error('辨識失敗', { message: error.message });
    resetToIdle();
    sendToMain('error', { message: error.message });
  }
});

// 錄音失敗（例如麥克風權限被拒）
ipcMain.on('audio-error', (event, message) => {
  logger.error('錄音錯誤', { message });
  resetToIdle();
  sendToMain('error', { message });
});

// 開啟設定視窗
ipcMain.on('open-settings', () => createSettingsWindow());

// 讀取設定 / 歷史
ipcMain.handle('get-settings', () => settingsStore.getAll());
ipcMain.handle('get-history', () => history);

// 點擊歷史項目 → 複製到剪貼簿
ipcMain.handle('copy-text', (event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

// 清除歷史
ipcMain.handle('clear-history', () => {
  history = [];
  saveHistory();
  sendToMain('history-updated', history);
  return true;
});

// 儲存設定（invoke：回報快捷鍵註冊結果）
ipcMain.handle('save-settings', (event, settings) => {
  const previousHotkey = settingsStore.get('hotkey');
  settingsStore.setAll(settings);
  asrClient.updateConfig(settings);
  applyLaunchAtLogin(settings.launchAtLogin);

  const newHotkey = settings.hotkey || 'CommandOrControl+Shift+V';
  if (!registerHotkey(newHotkey)) {
    // 註冊失敗：還原舊快捷鍵，讓功能維持可用
    registerHotkey(previousHotkey);
    settingsStore.set('hotkey', previousHotkey);
    return { ok: false, message: `快捷鍵 ${newHotkey} 註冊失敗（可能被其他程式佔用），已保留原設定` };
  }

  logger.info('設定已儲存');
  return { ok: true };
});

// 測試伺服器連接（在主進程執行，避免 CORS 問題）
// 參數可為字串（URL，視為 vLLM）或 { backend, apiUrl, apiKey }
ipcMain.handle('test-connection', async (event, payload) => {
  const backend = (typeof payload === 'object' && payload && payload.backend) || 'vllm';
  const apiUrl = typeof payload === 'string' ? payload : (payload && payload.apiUrl) || '';
  const apiKey = typeof payload === 'object' && payload ? payload.apiKey || '' : '';
  try {
    const models = backend === 'gemini'
      ? await ASRClient.listGeminiModels(apiKey)
      : backend === 'groq'
        ? await ASRClient.listGroqModels(apiKey)
        : await ASRClient.listModels(apiUrl, apiKey);
    return { ok: true, models };
  } catch (error) {
    return { ok: false, message: error.message };
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
