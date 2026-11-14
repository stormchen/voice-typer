# VoiceTyper 架構文檔

## 系統架構

```
Electron Main Process (src/main.js)
├── TrayManager (components/tray-manager.js)      系統匣、狀態提示
├── ASRClient (components/api-client.js)          ASR API 客戶端（vLLM / Gemini / Groq）+ 重試
├── ClipboardManager (components/clipboard.js)    剪貼簿 + 模擬貼上
├── SettingsStore (components/settings-store.js)  userData/config.json（使用 safeStorage 保護 API Key）
└── Logger (components/logger.js)                 ~/.voicetyper/voicetyper.log

Renderer Process (public/)
├── recorder.js / recorder-worklet.js    Web Audio 錄音與 16kHz WAV 編碼
├── renderer.js    主視窗 UI 邏輯
└── settings.html  設定面板
```

## 語音輸入流程

```
使用者按快捷鍵
  → main.js: toggleRecording()
  → renderer: WebAudioRecorder.start()（getUserMedia 擷取單聲道，AudioWorklet 收集音頻）
使用者再按一次快捷鍵
  → renderer: WebAudioRecorder.stop()
      重新採樣至 16kHz → 音量標準化 → 編碼 16-bit PCM WAV
  → IPC 'audio-captured' 傳回主進程
  → ASRClient.transcribe()：vLLM/Groq 走 POST /v1/audio/transcriptions、Gemini 走 generateContent
      （重試 3 次，僅網路錯誤、429 與 5xx；429 優先尊重 Retry-After，其餘 2ⁿ 秒指數退避）
  → ClipboardManager.paste()：寫入剪貼簿 + 模擬 Ctrl/Cmd+V
  → UI 顯示辨識結果
```

## 設計決策

錄音在渲染進程使用 Web Audio API 而非 `node-record-lpcm16`，免除 sox 等外部依賴，跨平台一致。模擬貼上使用平台原生指令（osascript / PowerShell SendKeys / xdotool）而非 robotjs，避免原生模組編譯問題；貼上失敗時文字仍在剪貼簿。API 呼叫（含測試連接）全部在主進程執行，避開渲染進程 CORS 限制。設定持久化為 `userData/config.json` 純 JSON 檔，不引入 electron-store 依賴。

## IPC 通道

| 通道 | 方向 | 用途 |
|------|------|------|
| `start-recording` / `stop-recording` | main → renderer | 控制錄音，附帶工作階段 ID |
| `recording-started` / `recognizing` / `recognition-complete` / `error` | main → renderer | UI 狀態 |
| `recording-limit` | main → renderer | 達錄音時長上限，自動停止 |
| `history-updated` | main → renderer | 歷史記錄變更 |
| `audio-captured` | renderer → main | 回傳工作階段 ID 與 WAV ArrayBuffer |
| `audio-error` | renderer → main | 回報所屬工作階段的錄音錯誤 |
| `open-settings` | renderer → main（send） | 開啟設定視窗 |
| `get-settings` / `save-settings` / `test-connection` / `get-history` / `clear-history` / `copy-text` | invoke/handle | 讀寫設定、測試伺服器、歷史與剪貼簿 |

## 安全考量

`contextIsolation: true`、preload 的 IPC 白名單與頁面內容安全政策（CSP）共同限制渲染進程；程式不主動將音頻寫入檔案。`safeStorage` 可用時 API Key 加密落盤，記憶體中保持明文供 ASRClient 使用。加密不可用時，原有密文會保留；若沒有既有密文，金鑰可能以明文保存並記錄警告。設定檔先寫入同目錄暫存檔再替換；解密失敗時保留原密文，避免儲存其他設定時遺失金鑰。

Electron 45 已棄用目前使用的同步 `safeStorage` 介面，並預計於 Electron 46 移除。套件目前限制在 Electron 45 主版本；未來升至 46 前，需移轉至非同步介面並驗證既有密文在各平台的相容性。Linux 的 `basic_text` 後端使用固定密碼，不能提供有效的金鑰保護。
