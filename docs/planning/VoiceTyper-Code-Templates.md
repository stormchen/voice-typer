# VoiceTyper 核心代碼模板

## 1. Electron 主程序 (src/main.js)

```javascript
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const globalShortcut = require('electron-global-shortcut');
const path = require('path');
const TrayManager = require('./components/tray-manager');
const AudioRecorder = require('./components/audio-recorder');
const ASRClient = require('./components/api-client');
const ClipboardManager = require('./components/clipboard');

let mainWindow;
let settingsWindow;
let trayManager;
let audioRecorder;
let asrClient;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 500,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../public/index.html'));
  mainWindow.hide();
}

app.on('ready', () => {
  createWindow();
  
  // 初始化系統匣
  trayManager = new TrayManager(mainWindow);
  audioRecorder = new AudioRecorder();
  
  // 讀取設置並初始化 ASR 客戶端
  const config = {
    backend: 'vllm',
    apiUrl: 'http://localhost:8000',
    apiKey: ''
  };
  asrClient = new ASRClient(config);
  
  // 註冊全域快捷鍵
  globalShortcut.register('CommandOrControl+Shift+V', async () => {
    await handleVoiceInput();
  });
  
  createSettingsWindow();
});

async function handleVoiceInput() {
  try {
    console.log('開始錄音...');
    
    // 通知 UI 開始錄音
    mainWindow.webContents.send('recording-started');
    
    // 錄音
    const audioBuffer = await audioRecorder.record(5000); // 5 秒
    
    // 通知 UI 辨識中
    mainWindow.webContents.send('recognizing');
    
    // 調用 ASR API
    const text = await asrClient.transcribe(audioBuffer);
    
    // 自動貼上
    await ClipboardManager.paste(text);
    
    // 通知 UI 完成
    mainWindow.webContents.send('recognition-complete', { text });
  } catch (error) {
    console.error('錯誤:', error);
    mainWindow.webContents.send('error', { message: error.message });
  }
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 600,
    height: 500,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  
  settingsWindow.loadFile(path.join(__dirname, '../public/settings.html'));
}

// IPC 通信
ipcMain.on('open-settings', () => {
  settingsWindow.show();
});

ipcMain.on('save-settings', (event, settings) => {
  // 保存設置到本地
  console.log('保存設置:', settings);
  // TODO: 持久化到 localStorage 或配置文件
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
```

---

## 2. 系統匣管理器 (src/components/tray-manager.js)

```javascript
const { Menu, Tray } = require('electron');
const path = require('path');

class TrayManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tray = null;
    this.recordingState = 'idle'; // 'idle' | 'recording' | 'recognizing'
    this.init();
  }

  init() {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    this.tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '設定',
        click: () => this.mainWindow.webContents.send('open-settings')
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => require('electron').app.quit()
      }
    ]);

    this.tray.setContextMenu(contextMenu);
    this.tray.on('click', () => this.toggleWindow());
  }

  toggleWindow() {
    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  setRecordingState(state) {
    this.recordingState = state;
    let tooltip = 'VoiceTyper';
    
    switch (state) {
      case 'recording':
        tooltip = 'VoiceTyper - 錄音中...';
        break;
      case 'recognizing':
        tooltip = 'VoiceTyper - 辨識中...';
        break;
    }
    
    this.tray.setToolTip(tooltip);
  }
}

module.exports = TrayManager;
```

---

## 3. 音頻錄製器 (src/components/audio-recorder.js)

```javascript
const { dialog } = require('electron');
const recorder = require('node-record-lpcm16');

class AudioRecorder {
  constructor() {
    this.recording = false;
    this.audioChunks = [];
  }

  async record(duration = 5000) {
    return new Promise((resolve, reject) => {
      const file = recorder.record({
        sampleRateHertz: 16000,
        numChannels: 1,
        encodingName: 'LINEAR16',
        maxDurationSeconds: Math.ceil(duration / 1000)
      });

      let audioBuffer = Buffer.alloc(0);

      file.on('data', (chunk) => {
        audioBuffer = Buffer.concat([audioBuffer, chunk]);
      });

      setTimeout(() => {
        file.stop();
        resolve(audioBuffer);
      }, duration);

      file.on('error', reject);
    });
  }
}

module.exports = AudioRecorder;
```

---

## 4. ASR API 客戶端 (src/components/api-client.js)

```javascript
const axios = require('axios');
const FormData = require('form-data');

class ASRClient {
  constructor(config) {
    this.backend = config.backend || 'vllm';
    this.apiUrl = config.apiUrl || 'http://localhost:8000';
    this.apiKey = config.apiKey || '';
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000
    });
  }

  async transcribe(audioBuffer) {
    try {
      if (this.backend === 'vllm') {
        return await this.transcribeVLLM(audioBuffer);
      } else if (this.backend === 'google') {
        return await this.transcribeGoogle(audioBuffer);
      }
    } catch (error) {
      throw new Error(`ASR 錯誤: ${error.message}`);
    }
  }

  async transcribeVLLM(audioBuffer) {
    const formData = new FormData();
    formData.append('file', audioBuffer, 'audio.wav');
    formData.append('model', 'vibevoice-asr');

    const response = await this.client.post('/v1/audio/transcriptions', formData, {
      headers: formData.getHeaders()
    });

    return response.data.text || response.data.result;
  }

  async transcribeGoogle(audioBuffer) {
    // Google Speech-to-Text API
    const response = await axios.post(
      'https://speech.googleapis.com/v1/speech:recognize',
      {
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: 'zh-TW'
        },
        audio: {
          content: audioBuffer.toString('base64')
        }
      },
      {
        params: { key: this.apiKey }
      }
    );

    return response.data.results?.[0]?.alternatives?.[0]?.transcript || '';
  }

  updateConfig(config) {
    this.backend = config.backend;
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000
    });
  }
}

module.exports = ASRClient;
```

---

## 5. 剪貼簿管理器 (src/components/clipboard.js)

```javascript
const robot = require('robot3');
const { clipboard } = require('electron');

class ClipboardManager {
  static async paste(text) {
    try {
      // 複製文字到剪貼簿
      clipboard.writeText(text);
      
      // 延遲，確保剪貼簿內容已更新
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // 模擬 Ctrl+V / Cmd+V
      if (process.platform === 'darwin') {
        robot.keyTap('v', ['cmd']);
      } else {
        robot.keyTap('v', ['control']);
      }
    } catch (error) {
      throw new Error(`剪貼簿操作失敗: ${error.message}`);
    }
  }

  static copyToClipboard(text) {
    clipboard.writeText(text);
  }

  static readFromClipboard() {
    return clipboard.readText();
  }
}

module.exports = ClipboardManager;
```

---

## 6. IPC 預加載腳本 (src/preload.js)

```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 發送事件
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },

  // 接收事件
  receive: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },

  // 一次性接收
  once: (channel, func) => {
    ipcRenderer.once(channel, (event, ...args) => func(...args));
  }
});
```

---

## 7. 主 UI HTML (public/index.html)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VoiceTyper</title>
  <link rel="stylesheet" href="styles/main.css">
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎤 VoiceTyper</h1>
      <p>快捷鍵: Cmd+Shift+V</p>
    </div>

    <div class="status-area">
      <div id="status" class="status idle">
        <span class="indicator"></span>
        <span id="status-text">待機中</span>
      </div>
    </div>

    <div class="result-area">
      <div id="result-text" class="result-text">辨識結果將顯示在這裡</div>
    </div>

    <button id="settings-btn" class="btn-settings">⚙️ 設定</button>
  </div>

  <script src="renderer.js"></script>
</body>
</html>
```

---

## 8. 主 UI 渲染器 (src/renderer.js)

```javascript
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const resultTextEl = document.getElementById('result-text');
  const settingsBtn = document.getElementById('settings-btn');

  // 錄音開始
  window.api.receive('recording-started', () => {
    statusEl.className = 'status recording';
    statusTextEl.textContent = '錄音中...';
  });

  // 辨識開始
  window.api.receive('recognizing', () => {
    statusEl.className = 'status recognizing';
    statusTextEl.textContent = '辨識中...';
  });

  // 辨識完成
  window.api.receive('recognition-complete', (data) => {
    statusEl.className = 'status idle';
    statusTextEl.textContent = '待機中';
    resultTextEl.textContent = data.text;
  });

  // 錯誤
  window.api.receive('error', (data) => {
    statusEl.className = 'status error';
    statusTextEl.textContent = '錯誤: ' + data.message;
  });

  // 設定按鈕
  settingsBtn.addEventListener('click', () => {
    window.api.send('open-settings');
  });
});
```

---

## 9. 設定面板 (public/settings.html)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>VoiceTyper 設定</title>
  <link rel="stylesheet" href="styles/main.css">
</head>
<body>
  <div class="settings-container">
    <h2>設定</h2>
    
    <div class="setting-group">
      <label>後端選擇:</label>
      <select id="backend">
        <option value="vllm">vLLM (VibeVoice-ASR)</option>
        <option value="google">Google Chirp 3</option>
      </select>
    </div>

    <div class="setting-group">
      <label>API URL:</label>
      <input type="text" id="apiUrl" placeholder="http://localhost:8000">
    </div>

    <div class="setting-group">
      <label>API Key (Google):</label>
      <input type="password" id="apiKey" placeholder="您的 API Key">
    </div>

    <div class="setting-group">
      <label>快捷鍵:</label>
      <select id="hotkey">
        <option value="CommandOrControl+Shift+V">Cmd/Ctrl + Shift + V</option>
        <option value="CommandOrControl+Shift+R">Cmd/Ctrl + Shift + R</option>
      </select>
    </div>

    <div class="setting-group">
      <label>錄音模式:</label>
      <select id="recordMode">
        <option value="push-to-talk">按住錄音 (Push-to-Talk)</option>
        <option value="toggle">切換錄音 (Toggle)</option>
      </select>
    </div>

    <button id="save-btn" class="btn-save">儲存設定</button>
  </div>

  <script>
    document.getElementById('save-btn').addEventListener('click', () => {
      const settings = {
        backend: document.getElementById('backend').value,
        apiUrl: document.getElementById('apiUrl').value,
        apiKey: document.getElementById('apiKey').value,
        hotkey: document.getElementById('hotkey').value,
        recordMode: document.getElementById('recordMode').value
      };
      window.api.send('save-settings', settings);
      alert('設定已儲存');
    });
  </script>
</body>
</html>
```

---

這些模板提供了完整的 VoiceTyper 基礎架構。你可以逐步擴展每個模組！
