// 設定持久化：儲存到 userData/config.json
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

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
    this.settings = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        return { ...DEFAULTS, ...JSON.parse(raw) };
      }
    } catch (error) {
      console.warn('讀取設定失敗，使用預設值:', error.message);
    }
    return { ...DEFAULTS };
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('儲存設定失敗:', error.message);
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
