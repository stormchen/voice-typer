// ASR API 客戶端 - 支援遠端 vLLM 伺服器（OpenAI 相容 API）、Google Gemini API 或 Groq API
// 重試（網路錯誤、429、5xx；429 優先尊重 Retry-After）、依音頻長度動態調整逾時
const axios = require('axios');
const FormData = require('form-data');
const logger = require('./logger');

// 16kHz / 16-bit / 單聲道 → 每秒 32000 bytes
const BYTES_PER_SECOND = 32000;

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

const BACKEND_LABEL = {
  vllm: 'vLLM 伺服器',
  gemini: 'Gemini API',
  groq: 'Groq API'
};

// 將底層錯誤轉為使用者看得懂的中文訊息
function friendlyError(error, label = '伺服器') {
  if (error.response) {
    const status = error.response.status;
    const detail =
      (error.response.data && (error.response.data.error?.message || error.response.data.detail)) || '';
    if (status === 429) return `已達 ${label} 的速率限制（429），重試後仍被限制，請稍後再試`;
    if (status === 401 || status === 403) return `${label}拒絕存取（${status}），請檢查 API Key`;
    if (status === 404) return `${label}找不到辨識端點（404），請確認地址與模型名稱`;
    if (status === 413) return `音頻檔案過大（413），請縮短錄音長度`;
    return `${label}錯誤（${status}）${detail ? ': ' + detail : ''}`;
  }
  const code = error.code || '';
  if (code === 'ECONNREFUSED') return `無法連線到 ${label}，請確認服務可達且地址正確`;
  if (code === 'ENOTFOUND') return `找不到 ${label} 的主機，請檢查地址`;
  if (code === 'ECONNABORTED' || /timeout/i.test(error.message)) return '請求逾時，伺服器可能忙碌或網路不穩';
  if (code === 'ECONNRESET') return '連線被重置，請重試';
  return error.message || '未知錯誤';
}

// 4xx 客戶端錯誤重試沒有意義（429 除外）；僅重試網路錯誤、429 與 5xx
function isRetryable(error) {
  if (!error.response) return true; // 網路層錯誤
  const status = error.response.status;
  return status === 429 || status >= 500;
}

// Retry-After 可能是秒數或 HTTP-date；上限 60 秒，避免異常等待
function retryDelayMs(error, attempt) {
  const header = error.response && error.response.headers && error.response.headers['retry-after'];
  if (header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0), 60) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max((date - Date.now()) / 1000, 0), 60) * 1000;
  }
  return Math.pow(2, attempt) * 1000;
}

class ASRClient {
  constructor(config = {}) {
    this.updateConfig(config);
  }

  updateConfig(config) {
    this.config = {
      backend: config.backend || (this.config && this.config.backend) || 'vllm',
      apiUrl: normalizeUrl(config.apiUrl || (this.config && this.config.apiUrl) || 'http://localhost:8000'),
      apiKey: config.apiKey !== undefined ? config.apiKey : (this.config && this.config.apiKey) || '',
      model: config.model || (this.config && this.config.model) || 'vibevoice-asr',
      language: config.language || (this.config && this.config.language) || 'zh-TW'
    };
  }

  // 依音頻長度估算逾時：基礎 30 秒 + 每秒音頻 2 秒，上限 5 分鐘
  _timeoutFor(audioBuffer) {
    const audioSeconds = audioBuffer.length / BYTES_PER_SECOND;
    return Math.min(30000 + Math.ceil(audioSeconds) * 2000, 300000);
  }

  // 語音轉文字（含重試；429 優先使用 Retry-After，其餘走 2^n 秒指數退避）
  async transcribe(audioBuffer, retries = 3) {
    let lastError = null;
    for (let i = 0; i < retries; i++) {
      try {
        if (this.config.backend === 'gemini') {
          return await this._makeGeminiRequest(audioBuffer);
        }
        if (this.config.backend === 'groq') {
          return await this._makeRequest(audioBuffer, GROQ_API_BASE, true);
        }
        return await this._makeRequest(audioBuffer);
      } catch (error) {
        lastError = error;
        logger.error(`辨識請求失敗（第 ${i + 1} 次）`, {
          message: error.message,
          status: error.response ? error.response.status : undefined
        });
        if (!isRetryable(error) || i === retries - 1) break;
        const delay = retryDelayMs(error, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error(friendlyError(lastError, BACKEND_LABEL[this.config.backend] || '伺服器'));
  }

  // baseUrl 省略時使用自架 vLLM 的 apiUrl（含 /v1 前綴）；Groq 則傳入固定的雲端端點（已含 /v1）
  async _makeRequest(audioBuffer, baseUrl, requireApiKey = false) {
    if (requireApiKey && !this.config.apiKey) {
      throw new Error('尚未設定 Groq API Key');
    }

    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    formData.append('model', this.config.model);
    // Groq（Whisper）僅接受 ISO-639-1 兩碼語言代碼，不含地區碼（如 zh-TW → zh）
    const language = baseUrl === GROQ_API_BASE ? String(this.config.language || 'zh').split('-')[0] : this.config.language;
    formData.append('language', language);

    const headers = formData.getHeaders();
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const url = baseUrl ? `${baseUrl}/audio/transcriptions` : `${this.config.apiUrl}/v1/audio/transcriptions`;

    const response = await axios.post(
      url,
      formData,
      {
        headers,
        timeout: this._timeoutFor(audioBuffer),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    return response.data.text || response.data.result || '';
  }

  // Gemini：以 inline_data 夾帶音頻呼叫 generateContent，請模型逐字轉錄
  async _makeGeminiRequest(audioBuffer) {
    if (!this.config.apiKey) {
      throw new Error('尚未設定 Gemini API Key');
    }

    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(this.config.model)}:generateContent`;

    const response = await axios.post(
      url,
      {
        contents: [
          {
            parts: [
              { inline_data: { mime_type: 'audio/wav', data: audioBuffer.toString('base64') } },
              { text: `請將這段音頻逐字轉錄成文字（語言：${this.config.language}）。只輸出轉錄結果，不要加任何說明、標點以外的註解或引號。` }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.config.apiKey
        },
        timeout: this._timeoutFor(audioBuffer),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      }
    );

    const candidate = response.data.candidates && response.data.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    return parts ? parts.map((p) => p.text || '').join('').trim() : '';
  }

  // 測試連接：查詢 /v1/models
  static async listModels(apiUrl, apiKey = '') {
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    try {
      const response = await axios.get(`${normalizeUrl(apiUrl)}/v1/models`, {
        timeout: 10000,
        headers
      });
      return (response.data.data || []).map((m) => m.id);
    } catch (error) {
      throw new Error(friendlyError(error, BACKEND_LABEL.vllm));
    }
  }

  // 測試連接：查詢 Groq 可用模型
  static async listGroqModels(apiKey = '') {
    if (!apiKey) throw new Error('請先填寫 Groq API Key');
    try {
      const response = await axios.get(`${GROQ_API_BASE}/models`, {
        timeout: 10000,
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      return (response.data.data || []).map((m) => m.id);
    } catch (error) {
      throw new Error(friendlyError(error, BACKEND_LABEL.groq));
    }
  }

  // 測試連接：查詢 Gemini 可用模型（僅列出支援 generateContent 的模型）
  static async listGeminiModels(apiKey = '') {
    if (!apiKey) throw new Error('請先填寫 Gemini API Key');
    try {
      const response = await axios.get(`${GEMINI_API_BASE}/models`, {
        timeout: 10000,
        headers: { 'x-goog-api-key': apiKey }
      });
      return (response.data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''));
    } catch (error) {
      throw new Error(friendlyError(error, BACKEND_LABEL.gemini));
    }
  }
}

module.exports = ASRClient;
// 內部輔助函式（供單元測試直接驗證錯誤分類與退避邏輯）
module.exports.friendlyError = friendlyError;
module.exports.isRetryable = isRetryable;
module.exports.retryDelayMs = retryDelayMs;
