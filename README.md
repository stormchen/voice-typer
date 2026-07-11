# 🎤 VoiceTyper

繁體中文語音輸入桌面應用。按下全域快捷鍵開始說話，辨識結果自動貼上到目前焦點的視窗。

基於 Electron，後端採用 **方案 A：遠端 vLLM 伺服器**（VibeVoice-ASR 模型，OpenAI 相容 API）。

## 架構

```
VoiceTyper (Electron 桌面應用)
         ↓
      REST API
         ↓
  vLLM OpenAI API 伺服器
         ↓
  VibeVoice-ASR 模型
```

VoiceTyper 與 VibeVoice 完全分離：本專案只是 API 客戶端，vLLM 伺服器可部署在本機或遠端 GPU 伺服器上，支援多用戶共享模型資源。

## 功能

全域快捷鍵錄音（預設 `Cmd/Ctrl + Shift + V`，按一次開始、再按一次結束）、16kHz WAV 音頻擷取與音量標準化、辨識結果自動貼上到焦點視窗、系統匣常駐、設定面板（伺服器地址、模型、語言、快捷鍵、連接測試）、指數退避自動重試、JSON 日誌（`~/.voicetyper/voicetyper.log`）。

## 快速開始

### 1. 啟動 vLLM 伺服器（在 VibeVoice 環境中）

```bash
pip install vllm

python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.8 \
  --port 8000 \
  --host 0.0.0.0
```

詳見 [docs/vllm-setup.md](docs/vllm-setup.md)。

### 2. 啟動 VoiceTyper

```bash
npm install
npm start
```

### 3. 設定伺服器地址

開啟設定面板（系統匣選單 → 設定），填入 vLLM 伺服器地址（例如 `http://192.168.1.100:8000`），點「測試連接」確認後儲存。

## 打包

```bash
npm run build:mac   # macOS (.dmg)
npm run build:win   # Windows (.exe)
```

## 平台注意事項

macOS 的自動貼上需要「系統設定 → 隱私權與安全性 → 輔助使用」授權；Linux 需安裝 `xdotool`。若自動貼上失敗，辨識結果仍會保留在剪貼簿，可手動 `Ctrl+V` 貼上。

## 目錄結構

```
voice-typer/
├── src/
│   ├── main.js                    # Electron 主進程
│   ├── preload.js                 # IPC 安全介面
│   └── components/
│       ├── tray-manager.js        # 系統匣管理
│       ├── api-client.js          # ASR API 客戶端（vLLM）
│       ├── clipboard.js           # 剪貼簿與自動貼上
│       ├── settings-store.js      # 設定持久化
│       └── logger.js              # 日誌
├── public/
│   ├── index.html                 # 主 UI
│   ├── settings.html              # 設定面板
│   ├── recorder.js                # Web Audio 錄音器（16kHz WAV）
│   ├── renderer.js                # UI 邏輯
│   └── styles/main.css
├── docs/
│   ├── architecture.md            # 架構文檔
│   └── vllm-setup.md              # vLLM 伺服器部署
├── assets/tray-icon.png
├── package.json
└── electron-builder.json
```

## 授權

MIT，見 [LICENSE](LICENSE)。
