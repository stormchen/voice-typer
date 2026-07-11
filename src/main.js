// VoiceTyper - Electron 主程序
// 方案 A：遠端 vLLM 伺服器（VibeVoice-ASR）
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const TrayManager = require('./components/tray-manager');
const ASRClient = require('./components/api-client');
const ClipboardManager = require('./components/clipboard');
const SettingsStore = require('./components/settings-store');
const logger = require('./components/logger');

let mainWindow = null;
let settingsWindow = null;
let trayManager = null;
let asrClient = null;
let settingsStore = null;
let isRecording = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    show: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));

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
    width: 600,
    height: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '../public/settings.html'));
}

// 切換錄音狀態（Toggle 模式）：第一次按快捷鍵開始錄音，第二次結束並辨識
function toggleRecording() {
  if (!isRecording) {
    isRecording = true;
    trayManager.setRecordingState('recording');
    mainWindow.webContents.send('start-recording');
    mainWindow.webContents.send('recording-started');
    logger.info('開始錄音');
  } else {
    isRecording = false;
    trayManager.setRecordingState('recognizing');
    mainWindow.webContents.send('stop-recording');
    mainWindow.webContents.send('recognizing');
    logger.info('停止錄音，等待音頻資料');
  }
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(accelerator, toggleRecording);
  if (!ok) {
    logger.error('快捷鍵註冊失敗', { accelerator });
  } else {
    logger.info('快捷鍵已註冊', { accelerator });
  }
}

app.on('ready', () => {
  settingsStore = new SettingsStore();
  const config = settingsStore.getAll();

  createMainWindow();
  trayManager = new TrayManager(mainWindow, {
    onOpenSettings: () => createSettingsWindow()
  });

  asrClient = new ASRClient(config);
  registerHotkey(config.hotkey || 'CommandOrControl+Shift+V');
});

// ===== IPC 通信 =====

// 渲染進程回傳錄音完成的 WAV 資料（ArrayBuffer）
ipcMain.on('audio-captured', async (event, arrayBuffer) => {
  try {
    const audioBuffer = Buffer.from(arrayBuffer);
    logger.info('收到音頻資料', { bytes: audioBuffer.length });

    const text = await asrClient.transcribe(audioBuffer);
    logger.info('辨識完成', { text });

    // 複製到剪貼簿並自動貼上到目前焦點視窗
    await ClipboardManager.paste(text);

    trayManager.setRecordingState('idle');
    mainWindow.webContents.send('recognition-complete', { text });
  } catch (error) {
    logger.error('辨識失敗', { message: error.message });
    trayManager.setRecordingState('idle');
    mainWindow.webContents.send('error', { message: error.message });
  }
});

// 錄音失敗（例如麥克風權限被拒）
ipcMain.on('audio-error', (event, message) => {
  isRecording = false;
  trayManager.setRecordingState('idle');
  logger.error('錄音錯誤', { message });
  mainWindow.webContents.send('error', { message });
});

// 開啟設定視窗
ipcMain.on('open-settings', () => createSettingsWindow());

// 讀取設定
ipcMain.handle('get-settings', () => settingsStore.getAll());

// 儲存設定
ipcMain.on('save-settings', (event, settings) => {
  settingsStore.setAll(settings);
  asrClient.updateConfig(settings);
  registerHotkey(settings.hotkey || 'CommandOrControl+Shift+V');
  logger.info('設定已儲存', settings);
});

// 測試 vLLM 伺服器連接（在主進程執行，避免 CORS 問題）
ipcMain.handle('test-connection', async (event, apiUrl) => {
  try {
    const models = await ASRClient.listModels(apiUrl);
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
