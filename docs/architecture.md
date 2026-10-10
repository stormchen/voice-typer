# VoiceTyper 架構文檔

## 系統架構

```
Electron Main Process (src/main.js)
├── TrayManager (components/tray-manager.js)      系統匣、狀態提示
├── ASRClient (components/api-client.js)          ASR API 客戶端（vLLM / Gemini / Groq）+ 重試
├── ClipboardManager (components/clipboard.js)    剪貼簿 + 模擬貼上
├── SettingsStore (components/settings-store.js)  userData/config.json（API Key 以 OS keychain 加密落盤）
└── Logger (components/logger.js)                 ~/.voicetyper/voicetyper.log

Renderer Process (public/)
├── recorder.js    Web Audio 錄音器（16kHz PCM → WAV）
├── renderer.js    主視窗 UI 邏輯
└── settings.html  設定面板
```

## 語音輸入流程

```
使用者按快捷鍵
  → main.js: toggleRecording()
  → renderer: WebAudioRecorder.start()（getUserMedia, 16kHz 單聲道）
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
| `start-recording` / `stop-recording` | main → renderer | 控制錄音 |
| `recording-started` / `recognizing` / `recognition-complete` / `error` | main → renderer | UI 狀態 |
| `recording-limit` | main → renderer | 達錄音時長上限，自動停止 |
| `history-updated` | main → renderer | 歷史記錄變更 |
| `audio-captured` | renderer → main | 回傳 WAV ArrayBuffer |
| `audio-error` | renderer → main | 錄音錯誤 |
| `open-settings` | renderer → main（send） | 開啟設定視窗 |
| `get-settings` / `save-settings` / `test-connection` / `get-history` / `clear-history` / `copy-text` | invoke/handle | 讀寫設定、測試伺服器、歷史與剪貼簿 |

## 安全考量

`contextIsolation: true` + preload 白名單 IPC（send / receive / invoke 三組 channel 白名單）；音頻不落地——錄音緩衝區送出後即釋放；API Key 落盤時經 `safeStorage`（OS keychain / Windows DPAPI）加密，記憶體中保持明文供 ASRClient 使用，舊明文設定檔首次載入即遷移；若系統加密不可用則退回明文並記錄錯誤。
