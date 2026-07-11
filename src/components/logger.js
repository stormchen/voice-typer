// 日誌模組：輸出到 console 與 ~/.voicetyper/voicetyper.log
const fs = require('fs');
const path = require('path');
const os = require('os');

class Logger {
  constructor() {
    this.logDir = path.join(os.homedir(), '.voicetyper');
    this.logFile = path.join(this.logDir, 'voicetyper.log');

    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch (_) {
      // 忽略：目錄無法建立時僅輸出 console
    }
  }

  log(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, message, ...metadata };

    console.log(`[${level}] ${message}`, metadata);

    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (_) {
      // 寫入失敗不影響主流程
    }
  }

  info(msg, meta) {
    this.log('INFO', msg, meta);
  }

  error(msg, meta) {
    this.log('ERROR', msg, meta);
  }

  debug(msg, meta) {
    this.log('DEBUG', msg, meta);
  }
}

module.exports = new Logger();
