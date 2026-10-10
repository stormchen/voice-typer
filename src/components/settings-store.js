// 設定持久化：儲存到 userData/config.json
// API Key 記憶體中保持明文（供 ASRClient 與設定介面使用），落盤時以 OS keychain 加密
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const DEFAULTS = {
  backend: 'vllm',
  apiUrl: 'http://localhost:8000',
  apiKey: '',
  model: 'vibevoice-asr',
  language: 'zh-TW',
  hotkey: 'CommandOrControl+Shift+V',
  pasteMode: 'ctrl-v',      // 'ctrl-v' | 'shift-insert' | 'copy-only'
  maxRecordSeconds: 120,    // 錄音時長上限（秒）
  launchAtLogin: false      // 開機自動啟動
};

class SettingsStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'config.json');
    const loaded = this._load();
    this.settings = loaded.settings;

    // 舊設定檔的明文 key：首次載入後立即加密遷移
    if (loaded.plaintextKey) {
      this._save();
      logger.info('API Key 已遷移為加密儲存');
    }
  }

  _encryptionAvailable() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch (error) {
      logger.error('檢查加密可用性失敗', { message: error.message });
      return false;
    }
  }

  // 回傳 { settings, plaintextKey }：plaintextKey 代表檔案中是舊的明文 key，需遷移
  _load() {
    let parsed;
    try {
      if (!fs.existsSync(this.filePath)) return { settings: { ...DEFAULTS }, plaintextKey: false };
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    } catch (error) {
      logger.error('讀取設定失敗，使用預設值', { message: error.message });
      return { settings: { ...DEFAULTS }, plaintextKey: false };
    }

    const settings = { ...DEFAULTS, ...parsed };

    if (parsed.apiKey && typeof parsed.apiKey === 'object' && parsed.apiKey.encrypted) {
      try {
        settings.apiKey = safeStorage.decryptString(Buffer.from(parsed.apiKey.value, 'base64'));
      } catch (error) {
        logger.error('API Key 解密失敗，需重新輸入', { message: error.message });
        settings.apiKey = '';
      }
      return { settings, plaintextKey: false };
    }

    if (!settings.apiKey) return { settings, plaintextKey: false };

    if (!this._encryptionAvailable()) {
      logger.error('系統加密不可用，API Key 仍以明文儲存');
      return { settings, plaintextKey: false };
    }

    return { settings, plaintextKey: true };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const out = { ...this.settings };
      if (this._encryptionAvailable() && out.apiKey) {
        out.apiKey = { encrypted: true, value: safeStorage.encryptString(out.apiKey).toString('base64') };
      }
      fs.writeFileSync(this.filePath, JSON.stringify(out, null, 2));
    } catch (error) {
      logger.error('儲存設定失敗', { message: error.message });
    }
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value) {
    this.settings[key] = value;
    this._save();
  }

  getAll() {
    return { ...this.settings };
  }

  setAll(settings) {
    this.settings = { ...this.settings, ...settings };
    this._save();
  }
}

module.exports = SettingsStore;
