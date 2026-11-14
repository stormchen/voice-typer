# 🎤 VoiceTyper

繁體中文語音輸入桌面應用。按下全域快捷鍵開始說話，辨識結果自動貼上到目前焦點的視窗。

基於 Electron，辨識後端可三選一：**遠端 vLLM 伺服器**（VibeVoice-ASR 模型，OpenAI 相容 API）、**Google Gemini API** 或 **Groq API**（後兩者皆免自架伺服器，需 API Key）。

## 架構

```
VoiceTyper (Electron 桌面應用)
         ↓
      REST API
         ↓
  vLLM OpenAI API 伺服器      Google Gemini API          Groq API
         ↓                         ↓                         ↓
  VibeVoice-ASR 模型        gemini-flash-latest 等   whisper-large-v3-turbo 等
```

VoiceTyper 與後端模型完全分離：本專案只是 API 客戶端。vLLM 伺服器可部署在本機或遠端 GPU 伺服器上，支援多用戶共享模型資源；Gemini、Groq 則直接呼叫各自的雲端 API，不需自架伺服器，但音頻會傳送到對應廠商。

## 功能

全域快捷鍵錄音（預設 `Ctrl+Shift+V`，按一次開始、再按一次結束，可在設定中自訂任意組合鍵）、16kHz WAV 音頻擷取與音量標準化、辨識結果自動貼上到焦點視窗、辨識歷史記錄（點擊複製）、系統匣常駐、開機自動啟動、自動重試（僅網路錯誤、429 與 5xx；429 優先尊重 `Retry-After`，否則 2ⁿ 秒指數退避）、依音頻長度動態調整逾時、單一實例鎖、錄音時長上限保護、JSON 日誌（`~/.voicetyper/voicetyper.log`）。

### 貼上方式（設定 → 貼上方式）

| 模式 | 適用情境 |
|---|---|
| `Ctrl+V` | 一般應用程式（預設） |
| `Shift+Insert` | PowerShell、傳統 cmd、AI agent shell、多數終端機 |
| 僅複製 | 不模擬按鍵，手動貼上，最保險 |

無論哪種模式，辨識結果都會保留在剪貼簿。若焦點在 VoiceTyper 自身視窗，會自動改為僅複製，避免貼回自己。

## 快速開始

### 1a. 使用 vLLM 伺服器（在 VibeVoice 環境中）

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

### 1b. 或使用 Google Gemini API（免自架伺服器）

到 [Google AI Studio](https://aistudio.google.com/apikey) 申請一組 API Key，不需啟動任何伺服器，直接跳到步驟 2。

### 1c. 或使用 Groq API（免自架伺服器）

到 [Groq Console](https://console.groq.com/keys) 申請一組 API Key，不需啟動任何伺服器，直接跳到步驟 2。

### 2. 啟動 VoiceTyper

開發環境需要 Node.js 22.13 以上的 22.x，或 Node.js 24 以上；CI 使用 Node.js 24。

```bash
npm install
npm start
```

執行檢查：

```bash
npm run lint
npm test
```

部分測試會使用獨立設定目錄啟動 Electron；Linux 的無桌面環境需要 Xvfb。

### 3. 設定辨識後端

開啟設定面板（系統匣選單 → 設定）：

- **vLLM**：辨識後端選「vLLM 伺服器」，填入伺服器地址（例如 `http://192.168.1.100:8000`），點「測試連接」確認後儲存。
- **Gemini**：辨識後端選「Google Gemini API」，填入剛申請的 API Key，模型名稱預設 `gemini-flash-latest`（會自動對應官方最新 Flash 模型），點「測試連接」確認後儲存。
- **Groq**：辨識後端選「Groq API」，填入剛申請的 API Key，模型名稱預設 `whisper-large-v3-turbo`，點「測試連接」確認後儲存。

### API Key 與降級注意事項

API Key 儲存在使用者設定檔中；系統的 Electron `safeStorage` 可用時會加密。若加密服務不可用，原本加密的金鑰會保留為密文；沒有既有密文時，金鑰可能以明文保存，設定介面與日誌會顯示警告（不包含金鑰）。解密失敗時可重新輸入 API Key，或在設定介面明確選擇清除；儲存其他設定不會刪除無法解密的密文。

Linux 需要可用的系統金鑰圈才能有效保護金鑰。若 Electron 使用 `basic_text` 後端，即使資料看似加密，保護仍依賴固定密碼，不應視為安全儲存；詳見 [Electron safeStorage 文件](https://www.electronjs.org/docs/latest/api/safe-storage)。

1.1.0 等舊版無法讀取新版的加密金鑰格式。若需降級，先關閉程式並備份設定檔，再移除設定檔中的 `apiKey` 欄位，啟動舊版後重新輸入金鑰。舊版可能以明文儲存金鑰，請自行評估風險並保護備份與設定檔；不要把它們提交到版本控制。

## 打包

```bash
npm run build:win   # Windows (.exe：NSIS 安裝檔 + portable)
npm run build:mac   # macOS (.dmg)
npm run build       # 依目前平台；Linux 為 AppImage
```

打包前會自動執行 `scripts/generate-icon.js` 產生應用圖示（純 Node，無外部依賴），輸出位於 `dist/`。

為修補建置依賴的安全問題，`package.json` 暫時將受影響的 `minimatch` 版本覆寫為 11.x。更新 electron-builder 後應重新執行 `npm audit` 與跨平台打包測試，確認上游修復後移除覆寫。

## 平台注意事項

- **Windows**：自動貼上以隱藏的 PowerShell 模擬按鍵。傳統 conhost 不支援 `Ctrl+V`，請改用 `Shift+Insert` 模式；對「以系統管理員身分執行」的視窗貼上需 VoiceTyper 同樣以管理員執行。
- **macOS**：自動貼上需要「系統設定 → 隱私權與安全性 → 輔助使用」授權。
- **Linux**：需安裝 `xdotool`。

若自動貼上失敗，辨識結果仍會保留在剪貼簿，可手動貼上。

## 目錄結構

```
voice-typer/
├── src/
│   ├── main.js                    # Electron 主進程（狀態機、快捷鍵、歷史）
│   ├── preload.js                 # IPC 安全介面（channel 白名單）
│   └── components/
│       ├── tray-manager.js        # 系統匣管理
│       ├── api-client.js          # ASR API 客戶端（vLLM / Gemini / Groq）+ 重試
│       ├── clipboard.js           # 剪貼簿與自動貼上（三種策略）
│       ├── settings-store.js      # 設定持久化（API Key 以 OS keychain 加密落盤）
│       └── logger.js              # 日誌
├── public/
│   ├── index.html                 # 主 UI（含歷史記錄）
│   ├── settings.html              # 設定面板（自訂快捷鍵、貼上方式等）
│   ├── settings.js                # 設定面板邏輯
│   ├── recorder.js                # Web Audio 錄音器（16kHz WAV）
│   ├── recorder-worklet.js        # 音頻擷取與分塊
│   ├── renderer.js                # UI 邏輯
│   └── styles/main.css
├── scripts/generate-icon.js       # 應用圖示產生器
├── test/
│   └── *.test.js                  # node:test 單元與隔離整合測試（npm test）
├── docs/
│   ├── architecture.md            # 架構文檔
│   ├── vllm-setup.md              # vLLM 伺服器部署
│   └── planning/                  # 設計紀錄（Setup-Guide / Code-Templates / VibeVoice-Integration）
├── assets/tray-icon.png
├── package.json
└── electron-builder.json          # 打包設定（單一來源）
```

## 授權

MIT，見 [LICENSE](LICENSE)。
