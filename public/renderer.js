// 主視窗 UI 邏輯 + 錄音控制
document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('status-text');
  const resultTextEl = document.getElementById('result-text');
  const settingsBtn = document.getElementById('settings-btn');
  const hotkeyHintEl = document.getElementById('hotkey-hint');
  const historyListEl = document.getElementById('history-list');
  const clearHistoryBtn = document.getElementById('clear-history-btn');

  const recorder = new WebAudioRecorder(16000);

  function setStatus(className, text) {
    statusEl.className = 'status ' + className;
    statusTextEl.textContent = text;
  }

  // 顯示目前快捷鍵
  function acceleratorLabel(acc) {
    return String(acc || '').replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
  }

  window.api.invoke('get-settings').then((settings) => {
    hotkeyHintEl.textContent =
      '快捷鍵: ' + acceleratorLabel(settings.hotkey) + '（按一次開始，再按一次結束）';
  });

  // ===== 歷史記錄 =====
  function renderHistory(items) {
    historyListEl.innerHTML = '';
    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '尚無記錄';
      historyListEl.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'history-item';
      el.title = '點擊複製';
      el.textContent = item.text;
      el.addEventListener('click', async () => {
        await window.api.invoke('copy-text', item.text);
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 800);
      });
      historyListEl.appendChild(el);
    });
  }

  window.api.invoke('get-history').then(renderHistory);
  window.api.receive('history-updated', renderHistory);

  clearHistoryBtn.addEventListener('click', () => {
    window.api.invoke('clear-history');
  });

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
      } else {
        window.api.send('audio-error', '沒有錄到音頻資料');
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

  window.api.receive('recording-limit', (data) => {
    setStatus('recognizing', `已達錄音上限 ${data.maxSeconds} 秒，自動送出辨識...`);
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
