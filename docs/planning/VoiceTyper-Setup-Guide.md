# VoiceTyper 項目提取指南

## 概述
VoiceTyper 是一款基於 Electron 的語音輸入桌面應用，將從 VibeVoice 項目中獨立出來。

---

## 第一步：創建獨立倉庫

### 1.1 GitHub 設置
```bash
# 在 GitHub 上創建新倉庫 voice-typer
# 克隆倉庫
git clone https://github.com/YOUR_ORG/voice-typer.git
cd voice-typer
```

### 1.2 複製初始文件
從 VibeVoice 項目複製以下文件：
- `LICENSE` - 許可證文件
- `.gitignore` - Git 忽略配置

---

## 第二步：初始化 Node.js 環境

### 2.1 創建項目結構
```bash
mkdir -p src/{components,utils} public/styles docs
```

### 2.2 初始化 package.json
```bash
npm init -y
```

### 2.3 安裝核心依賴
```bash
npm install --save-dev electron electron-builder
npm install electron-global-shortcut robot3 axios chalk
```

---

## 第三步：配置檔案模板

### 3.1 package.json 範本
```json
{
  "name": "voice-typer",
  "version": "0.1.0",
  "description": "繁體中文語音輸入桌面應用",
  "main": "src/main.js",
  "homepage": "./",
  "dependencies": {
    "axios": "^1.6.0",
    "robot3": "^2.0.0"
  },
  "devDependencies": {
    "electron": "^latest",
    "electron-builder": "^latest",
    "electron-global-shortcut": "^latest"
  },
  "scripts": {
    "start": "electron .",
    "build": "electron-builder",
    "build:mac": "electron-builder --mac",
    "build:win": "electron-builder --win"
  },
  "build": {
    "appId": "com.voicetyper.app",
    "productName": "VoiceTyper",
    "files": [
      "src/**/*",
      "public/**/*",
      "node_modules/**/*"
    ],
    "mac": {
      "target": "dmg",
      "category": "public.app-category.utilities"
    },
    "win": {
      "target": "nsis"
    }
  }
}
```

### 3.2 electron-builder.json 範本
```json
{
  "appId": "com.voicetyper.app",
  "productName": "VoiceTyper",
  "directories": {
    "buildResources": "assets"
  },
  "mac": {
    "target": ["dmg"],
    "category": "public.app-category.utilities",
    "sign": true
  },
  "win": {
    "target": ["nsis", "portable"],
    "certificateFile": null,
    "certificatePassword": null
  }
}
```

---

## 第四步：核心模組實現

### 4.1 系統架構
```
Electron Main Process (main.js)
├── Tray Manager (components/tray-manager.js)
├── Global Hotkey (components/hotkey-manager.js)
├── Audio Recorder (components/audio-recorder.js)
├── API Client (components/api-client.js)
└── Clipboard Manager (components/clipboard.js)

Renderer Process (renderer.js)
├── UI Components
├── Settings Panel
└── Status Display
```

### 4.2 主程序框架
```javascript
// src/main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadFile('public/index.html');
  mainWindow.hide(); // 隱藏主窗口，只在系統匣顯示
}

app.on('ready', createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

---

## 第五步：與 VibeVoice 集成

### 5.1 依賴配置方案 A（本地開發）
```bash
# 在 voice-typer 同級目錄
npm link ../vibevoice
```

### 5.1 依賴配置方案 B（遠端 vLLM 伺服器）
```javascript
// src/components/api-client.js
class ASRClient {
  constructor(config) {
    this.backend = config.backend; // 'google' | 'vllm'
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  async transcribe(audioData) {
    if (this.backend === 'vllm') {
      return this.transcribeVLLM(audioData);
    } else {
      return this.transcribeGoogle(audioData);
    }
  }

  async transcribeVLLM(audioData) {
    const response = await axios.post(`${this.apiUrl}/v1/audio/transcriptions`, {
      audio: audioData,
      model: 'vibevoice-asr'
    });
    return response.data.text;
  }
}
```

### 5.2 vLLM 伺服器啟動
```bash
# 安裝 vLLM
pip install vllm

# 啟動 VibeVoice-ASR 推理伺服器
python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --gpu-memory-utilization 0.9 \
  --port 8000
```

---

## 第六步：開發檢查清單

- [ ] Electron 基礎框架完成
- [ ] 系統匣 / Menu Bar 顯示
- [ ] 全域快捷鍵監聽（Cmd+Shift+V / Ctrl+Shift+V）
- [ ] 音頻錄製功能
- [ ] API 客戶端（支援 Google & vLLM）
- [ ] 辨識結果自動貼上
- [ ] 設定面板 UI
- [ ] macOS 打包 (.dmg)
- [ ] Windows 打包 (.exe)
- [ ] 跨平台測試完成

---

## 第七步：目錄結構最終樣貌

```
voice-typer/
├── src/
│   ├── main.js                    # Electron 主進程
│   ├── preload.js                 # IPC 安全介面
│   ├── renderer.js                # UI 邏輯
│   └── components/
│       ├── tray-manager.js        # 系統匣管理
│       ├── hotkey-manager.js      # 全域快捷鍵
│       ├── audio-recorder.js      # 音頻錄製
│       ├── api-client.js          # ASR API 客戶端
│       └── clipboard.js           # 剪貼簿操作
├── public/
│   ├── index.html                 # 主 UI
│   ├── settings.html              # 設定面板
│   └── styles/
│       └── main.css
├── docs/
│   ├── architecture.md            # 架構文檔
│   ├── vllm-setup.md              # vLLM 設置
│   └── deployment.md              # 部署指南
├── .gitignore
├── LICENSE
├── package.json
├── electron-builder.json
└── README.md
```

---

## 快速開始命令

```bash
# 開發模式
npm start

# 打包 macOS
npm run build:mac

# 打包 Windows
npm run build:win

# 完整打包
npm run build
```

---

## 參考資源

- [Electron 官方文檔](https://www.electronjs.org/docs)
- [electron-builder](https://www.electron.build/)
- [VibeVoice 文檔](../docs/vibevoice-asr.md)
- [vLLM 文檔](https://docs.vllm.ai/)

---

**下一步：** 按照上面的任務清單逐項推進開發！
