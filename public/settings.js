let currentHotkey = 'CommandOrControl+Shift+V';

function acceleratorLabel(acc) {
  return String(acc || '').replace('CommandOrControl', 'Ctrl').replace(/\+/g, ' + ');
}

// 各後端的預設模型名稱與欄位文案
const BACKEND_DEFAULTS = {
  vllm: { model: 'vibevoice-asr', apiKeyLabel: 'API Key（選填）:', apiKeyPlaceholder: '伺服器需要驗證時填寫' },
  gemini: { model: 'gemini-flash-latest', apiKeyLabel: 'Gemini API Key（必填）:', apiKeyPlaceholder: '從 Google AI Studio 取得' },
  groq: { model: 'whisper-large-v3-turbo', apiKeyLabel: 'Groq API Key（必填）:', apiKeyPlaceholder: '從 console.groq.com 取得' }
};

const backendSelect = document.getElementById('backend');
const apiUrlGroup = document.getElementById('apiUrl-group');
const apiKeyLabel = document.getElementById('apiKey-label');
const apiKeyInput = document.getElementById('apiKey');
const apiKeyWarning = document.getElementById('apiKey-warning');
const unavailableApiKey = document.getElementById('apiKey-unavailable');
const clearUnavailableApiKey = document.getElementById('clear-unavailable-api-key');
const modelInput = document.getElementById('model');

function showApiKeyWarning(warning) {
  apiKeyWarning.textContent = typeof warning === 'string' ? warning : '';
  apiKeyWarning.hidden = !apiKeyWarning.textContent;
}

function applyBackendUI(backend) {
  const d = BACKEND_DEFAULTS[backend] || BACKEND_DEFAULTS.vllm;
  apiUrlGroup.style.display = (backend === 'gemini' || backend === 'groq') ? 'none' : '';
  apiKeyLabel.textContent = d.apiKeyLabel;
  apiKeyInput.placeholder = d.apiKeyPlaceholder;
  modelInput.placeholder = d.model;
}

// 切換後端時，若模型欄位仍是「其他後端」的預設值或空白，才代換為新後端的預設值（避免蓋掉使用者自訂的值）
backendSelect.addEventListener('change', () => {
  const backend = backendSelect.value;
  const isUntouchedDefault =
    !modelInput.value.trim() ||
    Object.values(BACKEND_DEFAULTS).some((d) => d.model === modelInput.value.trim());
  if (isUntouchedDefault) {
    modelInput.value = BACKEND_DEFAULTS[backend].model;
  }
  applyBackendUI(backend);
});

// 載入現有設定
window.api.invoke('get-settings').then((settings) => {
  const backend = settings.backend || 'vllm';
  backendSelect.value = backend;
  applyBackendUI(backend);
  document.getElementById('apiUrl').value = settings.apiUrl || 'http://localhost:8000';
  modelInput.value = settings.model || BACKEND_DEFAULTS[backend].model;
  apiKeyInput.value = settings.apiKey || '';
  showApiKeyWarning(settings.apiKeyWarning);
  unavailableApiKey.hidden = !settings.apiKeyDecryptionFailed;
  clearUnavailableApiKey.checked = false;
  document.getElementById('language').value = settings.language || 'zh-TW';
  document.getElementById('pasteMode').value = settings.pasteMode || 'ctrl-v';
  document.getElementById('maxRecordSeconds').value = settings.maxRecordSeconds || 120;
  document.getElementById('launchAtLogin').checked = !!settings.launchAtLogin;
  currentHotkey = settings.hotkey || 'CommandOrControl+Shift+V';
  document.getElementById('hotkey').value = acceleratorLabel(currentHotkey);
});

// ===== 快捷鍵擷取 =====
const hotkeyInput = document.getElementById('hotkey');

hotkeyInput.addEventListener('focus', () => {
  hotkeyInput.value = '請按下組合鍵...（Esc 取消）';
});

hotkeyInput.addEventListener('blur', () => {
  hotkeyInput.value = acceleratorLabel(currentHotkey);
});

hotkeyInput.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    hotkeyInput.blur();
    return;
  }

  // 純修飾鍵不算完整組合
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  if (mods.length === 0) {
    hotkeyInput.value = '需包含修飾鍵，請重按...';
    return;
  }

  // 將按鍵轉為 Electron accelerator 鍵名
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (/^F\d{1,2}$/.test(key)) { /* F1–F24 保持原樣 */ }
  else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else if (!['Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Enter'].includes(key)) {
    hotkeyInput.value = '不支援此按鍵，請重按...';
    return;
  }

  currentHotkey = [...mods, key].join('+');
  hotkeyInput.value = acceleratorLabel(currentHotkey);
  hotkeyInput.blur();
});

// ===== 測試連接（透過主進程執行，避免 CORS）=====
document.getElementById('test-connection').addEventListener('click', async () => {
  const backend = backendSelect.value;
  const apiUrl = document.getElementById('apiUrl').value.trim().replace(/\/+$/, '');
  const apiKey = apiKeyInput.value;
  const resultEl = document.getElementById('connection-result');
  resultEl.textContent = '測試中...';
  resultEl.className = 'connection-result';

  const result = await window.api.invoke('test-connection', { backend, apiUrl, apiKey });
  if (result.ok) {
    resultEl.textContent = '✅ 連接成功! 可用模型: ' + result.models.join(', ');
    resultEl.className = 'connection-result success';
  } else {
    resultEl.textContent = '❌ 連接失敗: ' + result.message;
    resultEl.className = 'connection-result fail';
  }
});

// ===== 儲存設定 =====
document.getElementById('save-btn').addEventListener('click', async () => {
  const maxSec = Math.min(600, Math.max(10, Number(document.getElementById('maxRecordSeconds').value) || 120));

  const settings = {
    backend: backendSelect.value,
    apiUrl: document.getElementById('apiUrl').value.trim().replace(/\/+$/, ''),
    model: modelInput.value.trim(),
    apiKey: apiKeyInput.value,
    language: document.getElementById('language').value,
    hotkey: currentHotkey,
    pasteMode: document.getElementById('pasteMode').value,
    maxRecordSeconds: maxSec,
    launchAtLogin: document.getElementById('launchAtLogin').checked,
    clearUnavailableApiKey: !unavailableApiKey.hidden && clearUnavailableApiKey.checked
  };

  const saveResult = document.getElementById('save-result');
  const result = await window.api.invoke('save-settings', settings);

  if (result.ok) {
    if (settings.clearUnavailableApiKey || settings.apiKey) {
      unavailableApiKey.hidden = true;
      clearUnavailableApiKey.checked = false;
    }
    if (typeof result.warning === 'string') showApiKeyWarning(result.warning);
    saveResult.textContent = '✅ 設定已儲存' + (apiKeyWarning.textContent ? ' ⚠️ ' + apiKeyWarning.textContent : '');
    saveResult.className = apiKeyWarning.textContent ? 'save-result fail' : 'save-result success';
  } else {
    if (typeof result.warning === 'string') showApiKeyWarning(result.warning);
    saveResult.textContent = '⚠️ ' + result.message + (result.warning ? ' ⚠️ ' + result.warning : '');
    saveResult.className = 'save-result fail';
    // 快捷鍵可能被還原，但 API Key 已寫入；重新同步安全狀態。
    window.api.invoke('get-settings').then((s) => {
      currentHotkey = s.hotkey;
      document.getElementById('hotkey').value = acceleratorLabel(currentHotkey);
      if (typeof s.apiKeyWarning === 'string') showApiKeyWarning(s.apiKeyWarning);
      if (typeof s.apiKeyDecryptionFailed === 'boolean') {
        const wasUnavailable = !unavailableApiKey.hidden;
        unavailableApiKey.hidden = !s.apiKeyDecryptionFailed;
        if (unavailableApiKey.hidden || !wasUnavailable) clearUnavailableApiKey.checked = false;
      }
    });
  }
  setTimeout(() => (saveResult.textContent = ''), 4000);
});
