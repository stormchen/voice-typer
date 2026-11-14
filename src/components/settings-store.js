// 設定持久化：儲存到 userData/config.json
// API Key 記憶體中保持明文；落盤時優先使用系統加密服務。
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
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
    this.encryptedKey = null;
    this.decryptionFailed = false;
    this.plaintextKeyOnDisk = false;
    const loaded = this._load();
    this.settings = loaded.settings;

    // 舊設定檔的明文 key：首次載入後立即加密遷移
    if (loaded.plaintextKey) {
      if (this._save() && this.encryptedKey) logger.info('API Key 已遷移為加密儲存');
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
    this.plaintextKeyOnDisk = typeof parsed.apiKey === 'string' && !!parsed.apiKey;

    if (parsed.apiKey && typeof parsed.apiKey === 'object' && parsed.apiKey.encrypted) {
      this.encryptedKey = parsed.apiKey;
      try {
        settings.apiKey = safeStorage.decryptString(Buffer.from(parsed.apiKey.value, 'base64'));
      } catch (error) {
        logger.error('API Key 解密失敗，需重新輸入', { message: error.message });
        this.decryptionFailed = true;
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

  _save(settings = this.settings, { clearEncryptedKey = false } = {}) {
    let tempPath;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const out = { ...settings };
      if (this.decryptionFailed && !out.apiKey && clearEncryptedKey !== true) {
        // 解密失敗時，只有明確要求清除或輸入新金鑰才可取代舊密文。
        out.apiKey = this.encryptedKey;
      } else if (out.apiKey) {
        if (this._encryptionAvailable()) {
          out.apiKey = { encrypted: true, value: safeStorage.encryptString(out.apiKey).toString('base64') };
        } else if (this.encryptedKey) {
          if (out.apiKey !== this.settings.apiKey) throw new Error('系統加密不可用，無法安全儲存新 API Key');
          out.apiKey = this.encryptedKey;
        } else {
          logger.error('系統加密不可用，API Key 將以明文儲存');
        }
      }
      // 先寫同目錄暫存檔再替換，避免中斷或寫入失敗時截斷原設定檔。
      tempPath = path.join(path.dirname(this.filePath), `.config-${randomBytes(8).toString('hex')}.tmp`);
      fs.writeFileSync(tempPath, JSON.stringify(out, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
      this.encryptedKey = out.apiKey && typeof out.apiKey === 'object' ? out.apiKey : null;
      this.plaintextKeyOnDisk = typeof out.apiKey === 'string' && !!out.apiKey;
      if (settings.apiKey || clearEncryptedKey === true) this.decryptionFailed = false;
      return true;
    } catch (error) {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch (_) {}
      }
      logger.error('儲存設定失敗', { message: error.message });
      return false;
    }
  }

  get(key) {
    return this.settings[key];
  }

  set(key, value) {
    return this.setAll({ [key]: value });
  }

  getAll() {
    return { ...this.settings };
  }

  getSecurityStatus() {
    const available = this._encryptionAvailable();
    let warning = '';
    if (this.plaintextKeyOnDisk) {
      warning = (available ? '' : '系統加密服務不可用，') + 'API Key 目前以明文儲存在本機設定檔中。';
    } else if (!available && !this.encryptedKey) {
      warning = '系統加密服務不可用，API Key 將以明文儲存在本機設定檔中。';
    }
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      try {
        if (safeStorage.getSelectedStorageBackend() === 'basic_text') {
          warning += ' Linux basic_text 模式未受系統金鑰鏈保護。';
        }
      } catch (error) {
        logger.error('檢查系統金鑰儲存服務失敗', { message: error.message });
      }
    }
    return {
      decryptionFailed: this.decryptionFailed,
      warning: warning.trim()
    };
  }

  setAll(settings, { clearEncryptedKey = false } = {}) {
    const updated = { ...this.settings, ...settings };
    if (!this._save(updated, { clearEncryptedKey })) return false;
    this.settings = updated;
    return true;
  }
}

module.exports = SettingsStore;
