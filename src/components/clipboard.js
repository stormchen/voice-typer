// 剪貼簿管理器：複製辨識結果並依策略模擬貼上
// 使用平台原生指令模擬按鍵，避免原生模組編譯問題
//
// 貼上策略（pasteMode）：
//   'ctrl-v'       一般應用（Windows/Linux: Ctrl+V，macOS: Cmd+V）
//   'shift-insert' 終端機環境（PowerShell、傳統 cmd、多數 Linux 終端）
//   'copy-only'    僅複製到剪貼簿，不模擬按鍵（最保險，手動貼上）
const { clipboard } = require('electron');
const { exec } = require('child_process');

// windowsHide：避免 Windows 上閃出 PowerShell 主控台視窗搶走焦點
const EXEC_OPTS = { windowsHide: true, timeout: 10000 };

function buildPasteCommand(mode) {
  if (process.platform === 'darwin') {
    // macOS：需要「輔助使用」權限；終端機同樣支援 Cmd+V
    return `osascript -e 'tell application "System Events" to keystroke "v" using command down'`;
  }

  if (process.platform === 'win32') {
    // SendKeys：^v = Ctrl+V；+{INS} = Shift+Insert（Windows Terminal / conhost 較穩）
    const keys = mode === 'shift-insert' ? '+{INS}' : '^v';
    return `powershell -NoProfile -NonInteractive -Command "$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('${keys}')"`;
  }

  // Linux：需要安裝 xdotool
  const keys = mode === 'shift-insert' ? 'shift+Insert' : 'ctrl+v';
  return `xdotool key --clearmodifiers ${keys}`;
}

class ClipboardManager {
  static async paste(text, mode = 'ctrl-v') {
    // 1. 複製文字到剪貼簿（無論哪種策略，剪貼簿一定有結果）
    clipboard.writeText(text);

    if (mode === 'copy-only') return;

    // 2. 延遲，確保剪貼簿內容已更新、快捷鍵按鍵已放開
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 3. 模擬貼上按鍵（依平台與策略）
    return new Promise((resolve) => {
      exec(buildPasteCommand(mode), EXEC_OPTS, (error) => {
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
