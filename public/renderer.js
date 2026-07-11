// 主視窗 UI 邏輯 + 錄音控制
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const resultTextEl = document.getElementById('result-text');
  const settingsBtn = document.getElementById('settings-btn');

  const recorder = new WebAudioRecorder(16000);

  function setStatus(className, text) {
    statusEl.className = 'status ' + className;
    statusTextEl.textContent = text;
  }

  // ===== 主進程指令：開始 / 停止錄音 =====
  window.api.receive('start-recording', async () => {
    try {
      await recorder.start();
    } catch (error) {
      window.api.send('audio-error', '無法存取麥克風: ' + error.message);
    }
  });

  window.api.receive('stop-recording', async () => {
    try {
      const wavBuffer = await recorder.stop();
      if (wavBuffer) {
        window.api.send('audio-captured', wavBuffer);
      }
    } catch (error) {
      window.api.send('audio-error', '錄音處理失敗: ' + error.message);
    }
  });

  // ===== UI 狀態更新 =====
  window.api.receive('recording-started', () => {
    setStatus('recording', '錄音中...（再按一次快捷鍵結束）');
  });

  window.api.receive('recognizing', () => {
    setStatus('recognizing', '辨識中...');
  });

  window.api.receive('recognition-complete', (data) => {
    setStatus('idle', '待機中');
    resultTextEl.textContent = data.text || '(無辨識結果)';
  });

  window.api.receive('error', (data) => {
    setStatus('error', '錯誤: ' + data.message);
  });

  // 設定按鈕
  settingsBtn.addEventListener('click', () => {
    window.api.send('open-settings');
  });
});
