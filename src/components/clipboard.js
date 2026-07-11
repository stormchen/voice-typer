// 剪貼簿管理器：複製辨識結果並模擬貼上
// 使用平台原生指令模擬 Ctrl+V / Cmd+V，避免原生模組編譯問題
const { clipboard } = require('electron');
const { exec } = require('child_process');

class ClipboardManager {
  static async paste(text) {
    // 1. 複製文字到剪貼簿
    clipboard.writeText(text);

    // 2. 延遲，確保剪貼簿內容已更新
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 3. 模擬貼上按鍵（依平台）
    return new Promise((resolve) => {
      let cmd = null;

      if (process.platform === 'darwin') {
        // macOS：需要「輔助使用」權限
        cmd = `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
      } else if (process.platform === 'win32') {
        // Windows：PowerShell SendKeys
        cmd = `powershell -NoProfile -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^v')"`;
      } else {
        // Linux：需要安裝 xdotool
        cmd = `xdotool key --clearmodifiers ctrl+v`;
      }

      exec(cmd, (error) => {
        if (error) {
          // 模擬貼上失敗時不擲出錯誤——文字已在剪貼簿中，使用者可手動貼上
          console.warn('自動貼上失敗，文字已複製到剪貼簿:', error.message);
        }
        resolve();
      });
    });
  }

  static copyToClipboard(text) {
    clipboard.writeText(text);
  }

  static readFromClipboard() {
    return clipboard.readText();
  }
}

module.exports = ClipboardManager;
