# VoiceTyper 與 VibeVoice 集成方案

## 架構概覽

```
VoiceTyper (Electron 桌面應用)
         ↓
      REST API
         ↓
  vLLM OpenAI API 伺服器
         ↓
  VibeVoice-ASR 模型
```

---

## 方案 A：遠端 vLLM 伺服器（推薦用於生產）

### 優點
- ✅ VoiceTyper 與 VibeVoice 完全分離
- ✅ 支援遠端伺服器部署
- ✅ 易於擴展與負載均衡
- ✅ 多用戶共享模型資源

### 部署步驟

#### 1. 在 VibeVoice 環境中啟動 vLLM 伺服器

```bash
# 進入 VibeVoice 項目目錄
cd /path/to/vibevoice

# 安裝依賴（如果未安裝）
pip install vllm

# 啟動 vLLM OpenAI API 相容伺服器
python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.8 \
  --port 8000 \
  --host 0.0.0.0
```

#### 2. VoiceTyper 配置

```javascript
// src/components/api-client.js
class ASRClient {
  constructor() {
    this.config = {
      backend: 'vllm',
      apiUrl: 'http://localhost:8000',  // 或遠端 IP
      model: 'vibevoice-asr',
      language: 'zh-TW'
    };
  }

  async transcribe(audioBuffer) {
    try {
      const formData = new FormData();
      formData.append('file', new Blob([audioBuffer]), 'audio.wav');
      formData.append('model', this.config.model);
      formData.append('language', this.config.language);

      const response = await fetch(
        `${this.config.apiUrl}/v1/audio/transcriptions`,
        {
          method: 'POST',
          body: formData
        }
      );

      const result = await response.json();
      return result.text;
    } catch (error) {
      throw new Error(`vLLM API 錯誤: ${error.message}`);
    }
  }

  updateApiUrl(url) {
    this.config.apiUrl = url;
  }
}

module.exports = ASRClient;
```

#### 3. 設定面板配置

```html
<!-- public/settings.html -->
<div class="setting-group">
  <label>vLLM 伺服器地址:</label>
  <input 
    type="text" 
    id="vllmUrl" 
    placeholder="http://localhost:8000"
    value="http://localhost:8000"
  >
  <button id="test-connection">測試連接</button>
</div>

<script>
  document.getElementById('test-connection').addEventListener('click', async () => {
    const url = document.getElementById('vllmUrl').value;
    try {
      const response = await fetch(`${url}/v1/models`);
      const data = await response.json();
      alert('✅ 連接成功! 可用模型: ' + data.data.map(m => m.id).join(', '));
    } catch (error) {
      alert('❌ 連接失敗: ' + error.message);
    }
  });
</script>
```

---

## 方案 B：本地集成（開發用）

### 優點
- ✅ 零網路延遲
- ✅ 便於開發除錯
- ✅ 無需複雜部署

### 部署步驟

#### 1. 安裝 Python 子進程管理

```bash
cd voice-typer
npm install child-process-promise python-shell
```

#### 2. 啟動 VibeVoice 伺服器（Electron 主進程）

```javascript
// src/main.js
const { spawn } = require('child_process');
const path = require('path');

let vllmProcess = null;

function startVLLMServer() {
  return new Promise((resolve, reject) => {
    const vibevoicePath = path.resolve(__dirname, '../../vibevoice');
    
    vllmProcess = spawn('python', [
      '-m', 'vllm.entrypoints.openai.api_server',
      '--model', 'microsoft/vibevoice-asr',
      '--gpu-memory-utilization', '0.8',
      '--port', '8000'
    ], {
      cwd: vibevoicePath,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // 等待伺服器啟動
    vllmProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log('vLLM:', output);
      
      if (output.includes('Uvicorn running')) {
        resolve();
      }
    });

    vllmProcess.on('error', reject);
  });
}

app.on('ready', async () => {
  try {
    console.log('啟動 vLLM 伺服器...');
    await startVLLMServer();
    console.log('✅ vLLM 伺服器已啟動');
    createWindow();
  } catch (error) {
    console.error('❌ 啟動失敗:', error);
    process.exit(1);
  }
});

app.on('before-quit', () => {
  if (vllmProcess) {
    vllmProcess.kill();
  }
});
```

---

## 方案 C：混合模式（推薦）

支援開發時本地伺服器，生產時遠端伺服器。

### 設置

```javascript
// src/config.js
const isDev = require('electron-is-dev');

const config = {
  development: {
    backend: 'local-vllm',
    apiUrl: 'http://localhost:8000',
    autoStartServer: true
  },
  production: {
    backend: 'remote-vllm',
    apiUrl: 'https://api.example.com:8000',
    autoStartServer: false
  }
};

module.exports = isDev ? config.development : config.production;
```

---

## 版本相容性

| 組件 | 版本 | 狀態 |
|------|------|------|
| VibeVoice-ASR | ≥ 1.0.0 | ✅ 穩定 |
| vLLM | ≥ 0.4.0 | ✅ 穩定 |
| Electron | ≥ 20.0.0 | ✅ 支持 |
| Node.js | ≥ 16.0.0 | ✅ 支持 |
| Python | ≥ 3.9 | ✅ 必需 |

---

## 性能優化

### 1. 模型量化

```bash
# 使用 4-bit 量化減少記憶體占用
python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --quantization awq \
  --gpu-memory-utilization 0.5
```

### 2. 音頻預處理

```javascript
// src/components/audio-processor.js
class AudioProcessor {
  static normalizeSampleRate(audioBuffer, targetRate = 16000) {
    // 重新採樣到 16kHz
    // VibeVoice-ASR 要求 16kHz
  }

  static normalizeAmplitude(audioBuffer) {
    // 標準化音量，避免過度削波
    const max = Math.max(...audioBuffer);
    return audioBuffer.map(s => s / max * 0.95);
  }

  static removeNoise(audioBuffer) {
    // 簡單的噪音抑制
    // TODO: 使用更高級的算法
  }
}
```

### 3. 緩存層

```javascript
// src/components/cache-manager.js
class CacheManager {
  constructor() {
    this.cache = new Map();
    this.maxSize = 100; // 最多 100 條
  }

  get(audioHash) {
    return this.cache.get(audioHash);
  }

  set(audioHash, text) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(audioHash, text);
  }
}
```

---

## 錯誤處理與重試策略

```javascript
// src/components/api-client.js
class ASRClient {
  async transcribe(audioBuffer, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await this._makeRequest(audioBuffer);
      } catch (error) {
        if (i === retries - 1) throw error;
        
        // 指數退避
        const delay = Math.pow(2, i) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async _makeRequest(audioBuffer) {
    const response = await fetch(`${this.apiUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      body: this._formatRequest(audioBuffer),
      timeout: 30000
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`API 錯誤 (${response.status}): ${error.detail}`);
    }

    return response.json();
  }
}
```

---

## 監控與日誌

```javascript
// src/logger.js
const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logFile = path.join(
      require('os').homedir(),
      '.voicetyper/voicetyper.log'
    );
  }

  log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      message,
      ...metadata
    };

    console.log(`[${level}] ${message}`, metadata);
    
    // 寫入日誌文件
    fs.appendFileSync(
      this.logFile,
      JSON.stringify(entry) + '\n'
    );
  }

  info(msg, meta) { this.log('INFO', msg, meta); }
  error(msg, meta) { this.log('ERROR', msg, meta); }
  debug(msg, meta) { this.log('DEBUG', msg, meta); }
}

module.exports = new Logger();
```

---

## 安全考量

### 1. API 金鑰管理

```javascript
// src/security/keystore.js
const ElectronStore = require('electron-store');

class KeyStore {
  constructor() {
    this.store = new ElectronStore({
      name: 'voicetyper-keys',
      encryptionKey: 'voicetyper-dev-key' // 開發用
    });
  }

  setApiKey(key) {
    this.store.set('api.key', key);
  }

  getApiKey() {
    return this.store.get('api.key');
  }
}
```

### 2. 音頻資料安全

```javascript
// 音頻不應存儲在本地
// 錄音 → 立即發送 → 刪除緩衝區
```

---

## 故障排查

### vLLM 伺服器未啟動

```bash
# 檢查 Python 環境
python -m vllm --version

# 檢查模型是否可下載
python -c "from transformers import AutoModelForCausalLM; AutoModelForCausalLM.from_pretrained('microsoft/vibevoice-asr')"

# 檢查 GPU 記憶體
nvidia-smi
```

### API 連接失敗

```javascript
// 診斷程式碼
async function diagnose() {
  try {
    const response = await fetch('http://localhost:8000/v1/models');
    const data = await response.json();
    console.log('✅ 伺服器正常', data);
  } catch (error) {
    console.error('❌ 伺服器無法連接:', error);
  }
}
```

---

## 部署檢查清單

- [ ] VibeVoice 環境已安裝
- [ ] vLLM 伺服器可正常啟動
- [ ] VoiceTyper API 客戶端已配置
- [ ] 防火牆已開放 8000 端口（遠端伺服器）
- [ ] 音頻測試成功
- [ ] 性能監控已啟用
- [ ] 錯誤日誌已配置

---

**更新日期**: 2026-07-11
