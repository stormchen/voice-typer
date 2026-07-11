// 系統匣 / Menu Bar 管理器
const { Menu, Tray, app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

class TrayManager {
  constructor(mainWindow, callbacks = {}) {
    this.mainWindow = mainWindow;
    this.callbacks = callbacks;
    this.tray = null;
    this.recordingState = 'idle'; // 'idle' | 'recording' | 'recognizing'
    this.init();
  }

  init() {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');
    // 圖示不存在時使用空白圖示，避免啟動失敗
    const icon = fs.existsSync(iconPath)
      ? nativeImage.createFromPath(iconPath)
      : nativeImage.createEmpty();

    this.tray = new Tray(icon);
    this.tray.setToolTip('VoiceTyper');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '顯示主視窗',
        click: () => this.toggleWindow()
      },
      {
        label: '設定',
        click: () => {
          if (this.callbacks.onOpenSettings) this.callbacks.onOpenSettings();
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
    this.tray.on('click', () => this.toggleWindow());
  }

  toggleWindow() {
    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  setRecordingState(state) {
    this.recordingState = state;
    let tooltip = 'VoiceTyper';

    switch (state) {
      case 'recording':
        tooltip = 'VoiceTyper - 錄音中...';
        break;
      case 'recognizing':
        tooltip = 'VoiceTyper - 辨識中...';
        break;
    }

    this.tray.setToolTip(tooltip);
  }
}

module.exports = TrayManager;
