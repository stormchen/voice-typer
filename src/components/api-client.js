// ASR API 客戶端 - 方案 A：遠端 vLLM 伺服器（OpenAI 相容 API）
// 支援指數退避重試策略
const axios = require('axios');
const FormData = require('form-data');
const logger = require('./logger');

class ASRClient {
  constructor(config = {}) {
    this.config = {
      backend: config.backend || 'vllm',
      apiUrl: config.apiUrl || 'http://localhost:8000',
      apiKey: config.apiKey || '',
      model: config.model || 'vibevoice-asr',
      language: config.language || 'zh-TW'
    };
    this._createClient();
  }

  _createClient() {
    this.client = axios.create({
      baseURL: this.config.apiUrl,
      timeout: 30000
    });
  }

  // 語音轉文字（含重試，指數退避）
  async transcribe(audioBuffer, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await this._makeRequest(audioBuffer);
      } catch (error) {
        logger.error(`辨識請求失敗（第 ${i + 1} 次）`, { message: error.message });
        if (i === retries - 1) {
          throw new Error(`vLLM API 錯誤: ${error.message}`);
        }
        // 指數退避：1s → 2s → 4s
        const delay = Math.pow(2, i) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async _makeRequest(audioBuffer) {
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav'
    });
    formData.append('model', this.config.model);
    formData.append('language', this.config.language);

    const headers = formData.getHeaders();
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await this.client.post('/v1/audio/transcriptions', formData, {
      headers
    });

    if (response.status !== 200) {
      throw new Error(`API 錯誤 (${response.status})`);
    }

    return response.data.text || response.data.result || '';
  }

  // 更新設定（切換伺服器地址等）
  updateConfig(config) {
    this.config = { ...this.config, ...config };
    this._createClient();
  }

  updateApiUrl(url) {
    this.config.apiUrl = url;
    this._createClient();
  }

  // 測試連接：查詢 /v1/models
  static async listModels(apiUrl) {
    const response = await axios.get(`${apiUrl}/v1/models`, { timeout: 10000 });
    return (response.data.data || []).map((m) => m.id);
  }
}

module.exports = ASRClient;
