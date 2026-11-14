// Run the real local pages in a separate Electron process with an in-memory IPC
// fixture. The production application and its user-data directory are never opened.
if (process.versions.electron && process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');

  contextBridge.exposeInMainWorld('api', {
    invoke: (channel, data) => ipcRenderer.invoke('fixture:invoke', channel, data),
    send: (channel, data) => ipcRenderer.send('fixture:send', channel, data),
    receive: (channel, callback) => {
      ipcRenderer.on('fixture:receive', (_event, incoming, data) => {
        if (incoming === channel) callback(data);
      });
    }
  });
} else if (process.versions.electron) {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const assert = require('node:assert/strict');
  const path = require('node:path');

  app.setPath('userData', process.env.CSP_TEST_PROFILE);
  app.setPath('sessionData', process.env.CSP_TEST_PROFILE);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.disableHardwareAcceleration();
  // 兩個頁面依序測試；避免關閉第一個視窗時 Electron 自行結束。
  app.on('window-all-closed', () => {});

  const fixture = {
    backend: 'vllm',
    apiUrl: 'http://127.0.0.1:8765',
    model: 'vibevoice-asr',
    apiKey: '',
    language: 'zh-TW',
    hotkey: 'CommandOrControl+Shift+V',
    pasteMode: 'ctrl-v',
    maxRecordSeconds: 120,
    launchAtLogin: false
  };
  const calls = [];
  let connectionResult = { ok: true, models: ['fixture-model'] };
  let saveResult = { ok: true };

  ipcMain.handle('fixture:invoke', (_event, channel, data) => {
    calls.push({ channel, data });
    if (channel === 'get-settings') return fixture;
    if (channel === 'get-history') return [{ text: '測試歷史', ts: 1 }];
    if (channel === 'test-connection') return connectionResult;
    if (channel === 'save-settings') return saveResult;
    if (channel === 'copy-text' || channel === 'clear-history') return true;
    throw new Error(`Unexpected fixture channel: ${channel}`);
  });
  ipcMain.on('fixture:send', (_event, channel, data) => calls.push({ channel, data }));

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, description) {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await pause(50);
    }
    throw new Error(`Timed out waiting for ${description}`);
  }

  async function openPage(name) {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: __filename,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });
    await window.loadFile(path.join(__dirname, '..', 'public', name));
    return window;
  }

  async function checkPolicy(window, page) {
    const result = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
      });
      window.__cspInline = false;
      window.__cspHandler = false;
      window.__cspEval = false;

      const inline = document.createElement('script');
      inline.textContent = 'window.__cspInline = true';
      document.body.appendChild(inline);

      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.__cspHandler = true');
      document.body.appendChild(button);
      button.click();

      let evalBlocked = false;
      try { window.eval('window.__cspEval = true'); } catch (error) { evalBlocked = error.name === 'EvalError'; }

      const styled = document.createElement('div');
      styled.id = 'csp-style-probe';
      document.body.appendChild(styled);
      const style = document.createElement('style');
      style.textContent = '#csp-style-probe { color: rgb(255, 0, 0) !important; }';
      document.head.appendChild(style);
      const styleBlocked = getComputedStyle(styled).color !== 'rgb(255, 0, 0)';
      styled.setAttribute('style', 'color: rgb(0, 255, 0)');
      const attributeBlocked = getComputedStyle(styled).color !== 'rgb(0, 255, 0)';

      const remote = document.createElement('script');
      remote.src = 'http://127.0.0.1:1/csp-probe.js';
      document.body.appendChild(remote);
      const image = document.createElement('img');
      image.src = 'http://127.0.0.1:1/csp-probe.png';
      document.body.appendChild(image);
      fetch('http://127.0.0.1:1/csp-probe').catch(() => {});

      const originalBase = document.baseURI;
      const base = document.createElement('base');
      base.href = 'https://example.invalid/';
      document.head.appendChild(base);
      const baseBlocked = document.baseURI === originalBase;

      setTimeout(() => {
        resolve({ inline: window.__cspInline, handler: window.__cspHandler, evalRan: window.__cspEval,
          evalBlocked, styleBlocked, attributeBlocked, baseBlocked, violations });
        for (const element of [inline, button, styled, style, remote, image, base]) element.remove();
      }, 300);
    })`);

    assert.equal(result.inline, false, `${page}: inline scripts must be blocked`);
    assert.equal(result.handler, false, `${page}: inline event handlers must be blocked`);
    assert.equal(result.evalRan, false, `${page}: eval must be blocked`);
    assert.equal(result.evalBlocked, true, `${page}: eval must throw`);
    assert.equal(result.styleBlocked, true, `${page}: inline styles must be blocked`);
    assert.equal(result.attributeBlocked, true, `${page}: inline style attributes must be blocked`);
    assert.equal(result.baseBlocked, true, `${page}: injected base URLs must be blocked`);
    for (const directive of ['script-src-elem', 'script-src-attr', 'script-src', 'style-src-elem', 'style-src-attr', 'connect-src', 'img-src', 'base-uri']) {
      assert.ok(result.violations.some((violation) => violation.directive === directive),
        `${page}: missing ${directive} violation: ${JSON.stringify(result.violations)}`);
    }
    assert.ok(result.violations.some((violation) => violation.directive === 'script-src-elem' &&
      violation.blockedURI === 'http://127.0.0.1:1/csp-probe.js'), `${page}: external script must be blocked`);
  }

  async function checkMainWindow() {
    const window = await openPage('index.html');
    const run = (script) => window.webContents.executeJavaScript(script);
    await waitFor(() => run("document.querySelector('.history-item')?.textContent === '測試歷史'"), 'main window history');
    assert.equal(await run("document.querySelector('link[rel=stylesheet]').sheet !== null"), true, 'main stylesheet loads');
    assert.match(await run("document.getElementById('hotkey-hint').textContent"), /Ctrl \+ Shift \+ V/);
    await checkPolicy(window, 'index.html');

    await run("document.querySelector('.history-item').click(); document.getElementById('clear-history-btn').click(); document.getElementById('settings-btn').click()");
    await waitFor(() => calls.some((call) => call.channel === 'copy-text'), 'copy history');
    assert.ok(calls.some((call) => call.channel === 'copy-text' && call.data === '測試歷史'));
    assert.ok(calls.some((call) => call.channel === 'clear-history'));
    assert.ok(calls.some((call) => call.channel === 'open-settings'));

    window.webContents.send('fixture:receive', 'recording-started');
    await waitFor(() => run("document.getElementById('status').classList.contains('recording')"), 'recording status');
    window.webContents.send('fixture:receive', 'recognition-complete', { text: '測試辨識' });
    await waitFor(() => run("document.getElementById('result-text').textContent === '測試辨識'"), 'recognition result');

    // Observe the real audio graph so slow device startup cannot race the stop.
    await run(`(() => {
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (...args) {
        const result = connect.apply(this, args);
        window.__fixtureAudioConnected = true;
        return result;
      };
    })()`);
    window.webContents.send('fixture:receive', 'start-recording', { id: 1 });
    await waitFor(async () => calls.some((call) => call.channel === 'audio-error') ||
      await run('window.__fixtureAudioConnected === true'), 'fake microphone audio graph');
    const startError = calls.find((call) => call.channel === 'audio-error');
    assert.equal(startError, undefined, `fake microphone startup failed (session ${startError?.data?.id}): ${startError?.data?.message}`);
    await pause(250);
    window.webContents.send('fixture:receive', 'stop-recording', { id: 1 });
    await waitFor(() => calls.some((call) => call.channel === 'audio-captured' || call.channel === 'audio-error'), 'fake microphone recording');
    const audioError = calls.find((call) => call.channel === 'audio-error');
    assert.equal(audioError, undefined, `fake microphone recording failed (session ${audioError?.data?.id}): ${audioError?.data?.message}`);
    const audio = calls.find((call) => call.channel === 'audio-captured').data;
    assert.equal(audio.id, 1, 'recorded audio includes the recording session ID');
    assert.ok(audio.audio.byteLength > 44, 'recorded WAV contains audio samples');
    assert.equal(Buffer.from(audio.audio).toString('ascii', 0, 4), 'RIFF');
    window.destroy();
  }

  async function checkSettingsWindow() {
    const window = await openPage('settings.html');
    const run = (script) => window.webContents.executeJavaScript(script);
    await waitFor(() => run("document.getElementById('model').value === 'vibevoice-asr'"), 'settings initialization');
    assert.equal(await run("document.querySelector('link[rel=stylesheet]').sheet !== null"), true, 'settings stylesheet loads');
    await checkPolicy(window, 'settings.html');

    let state = await run(`(() => {
      const backend = document.getElementById('backend');
      backend.value = 'gemini';
      backend.dispatchEvent(new Event('change'));
      return { display: getComputedStyle(document.getElementById('apiUrl-group')).display,
        model: document.getElementById('model').value, label: document.getElementById('apiKey-label').textContent };
    })()`);
    assert.equal(state.display, 'none', 'Gemini hides the vLLM URL');
    assert.equal(state.model, 'gemini-flash-latest');
    assert.match(state.label, /Gemini/);

    state = await run(`(() => {
      document.getElementById('model').value = 'custom-model';
      const backend = document.getElementById('backend');
      backend.value = 'groq';
      backend.dispatchEvent(new Event('change'));
      const groq = { display: getComputedStyle(document.getElementById('apiUrl-group')).display,
        model: document.getElementById('model').value, label: document.getElementById('apiKey-label').textContent };
      backend.value = 'vllm';
      backend.dispatchEvent(new Event('change'));
      return { groq, vllmDisplay: getComputedStyle(document.getElementById('apiUrl-group')).display };
    })()`);
    assert.equal(state.groq.display, 'none', 'Groq hides the vLLM URL');
    assert.equal(state.groq.model, 'custom-model', 'backend changes preserve a custom model');
    assert.match(state.groq.label, /Groq/);
    assert.notEqual(state.vllmDisplay, 'none', 'vLLM restores its URL field');

    await run(`(() => {
      document.getElementById('apiUrl').value = ' http://127.0.0.1:8765/// ';
      document.getElementById('test-connection').click();
    })()`);
    await waitFor(() => run("document.getElementById('connection-result').classList.contains('success')"), 'successful connection feedback');
    assert.match(await run("document.getElementById('connection-result').textContent"), /fixture-model/);
    assert.deepEqual(calls.findLast((call) => call.channel === 'test-connection').data,
      { backend: 'vllm', apiUrl: 'http://127.0.0.1:8765', apiKey: '' });
    connectionResult = { ok: false, message: 'fixture failure' };
    await run("document.getElementById('test-connection').click()");
    await waitFor(() => run("document.getElementById('connection-result').classList.contains('fail')"), 'failed connection feedback');
    assert.match(await run("document.getElementById('connection-result').textContent"), /fixture failure/);

    state = await run(`(() => {
      const input = document.getElementById('hotkey');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      return input.value;
    })()`);
    assert.equal(state, 'Ctrl + Alt + X');
    await run(`(() => {
      document.getElementById('maxRecordSeconds').value = '999';
      document.getElementById('launchAtLogin').checked = true;
      document.getElementById('save-btn').click();
    })()`);
    await waitFor(() => run("document.getElementById('save-result').classList.contains('success')"), 'successful save feedback');
    assert.deepEqual(calls.findLast((call) => call.channel === 'save-settings').data, {
      backend: 'vllm', apiUrl: 'http://127.0.0.1:8765', model: 'custom-model', apiKey: '',
      language: 'zh-TW', hotkey: 'CommandOrControl+Alt+X', pasteMode: 'ctrl-v',
      maxRecordSeconds: 600, launchAtLogin: true, clearUnavailableApiKey: false
    });

    saveResult = { ok: false, message: 'fixture save failure' };
    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('save-result').classList.contains('fail') && document.getElementById('hotkey').value === 'Ctrl + Shift + V'"), 'failed save and restored shortcut');
    assert.match(await run("document.getElementById('save-result').textContent"), /fixture save failure/);
    window.destroy();
  }

  async function checkSettingsWarnings() {
    fixture.apiKeyDecryptionFailed = false;
    fixture.apiKeyWarning = 'fixture：API Key 將以明文儲存';
    saveResult = { ok: true, warning: fixture.apiKeyWarning };
    const window = await openPage('settings.html');
    const run = (script) => window.webContents.executeJavaScript(script);
    await waitFor(() => run("document.getElementById('model').value === 'vibevoice-asr'"), 'warning settings initialization');

    let state = await run(`(() => {
      const warning = document.getElementById('apiKey-warning');
      return { text: warning?.textContent || '', hidden: warning?.hidden, role: warning?.getAttribute('role') };
    })()`);
    assert.match(state.text, /明文/);
    assert.equal(state.hidden, false, 'storage warning is visible on load');
    assert.equal(state.role, 'status');

    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('save-result').textContent.includes('已儲存')"), 'save warning');
    assert.match(await run("document.getElementById('save-result').textContent"), /明文/);
    assert.match(await run("document.getElementById('apiKey-warning').textContent"), /明文/);
    await pause(4200);
    assert.match(await run("document.getElementById('apiKey-warning').textContent"), /明文/, 'warning remains visible');

    saveResult = { ok: true };
    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('save-result').textContent.includes('已儲存')"), 'save without warning field');
    assert.match(await run("document.getElementById('save-result').textContent"), /明文/, 'omitted warning keeps the last known warning');

    saveResult = { ok: true, warning: '' };
    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('apiKey-warning').hidden"), 'cleared warning');
    window.destroy();
  }

  async function checkUnavailableApiKey() {
    fixture.apiKeyDecryptionFailed = true;
    fixture.apiKeyWarning = '';
    saveResult = { ok: true, warning: '' };
    const window = await openPage('settings.html');
    const run = (script) => window.webContents.executeJavaScript(script);
    await waitFor(() => run("document.getElementById('model').value === 'vibevoice-asr'"), 'unavailable API key initialization');

    let state = await run(`(() => {
      const group = document.getElementById('apiKey-unavailable');
      const checkbox = document.getElementById('clear-unavailable-api-key');
      return { hidden: group?.hidden, text: group?.textContent || '', checked: checkbox?.checked };
    })()`);
    assert.equal(state.hidden, false, 'decryption failure shows the clear option');
    assert.match(state.text, /清除無法解密的舊 API Key/);
    assert.match(state.text, /保留/);
    assert.equal(state.checked, false, 'clearing must be explicitly selected');

    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('save-result').textContent.includes('已儲存')"), 'save without clearing');
    assert.equal(calls.findLast((call) => call.channel === 'save-settings').data.clearUnavailableApiKey, false);
    assert.equal(await run("document.getElementById('apiKey-unavailable').hidden"), false);

    saveResult = { ok: false, message: 'fixture save failure' };
    await run("document.getElementById('clear-unavailable-api-key').checked = true; document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('save-result').textContent.includes('fixture save failure')"), 'failed clear');
    assert.equal(calls.findLast((call) => call.channel === 'save-settings').data.clearUnavailableApiKey, true);
    assert.equal(await run("document.getElementById('apiKey-unavailable').hidden"), false);
    assert.equal(await run("document.getElementById('clear-unavailable-api-key').checked"), true);

    saveResult = { ok: true, warning: '' };
    await run("document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('apiKey-unavailable').hidden"), 'successful clear');
    assert.equal(calls.findLast((call) => call.channel === 'save-settings').data.clearUnavailableApiKey, true);
    assert.equal(await run("document.getElementById('clear-unavailable-api-key').checked"), false);

    await run("document.getElementById('save-btn').click()");
    await waitFor(() => calls.findLast((call) => call.channel === 'save-settings').data.clearUnavailableApiKey === false, 'save after clear');
    window.destroy();

    const replacement = await openPage('settings.html');
    const replaceRun = (script) => replacement.webContents.executeJavaScript(script);
    await waitFor(() => replaceRun("document.getElementById('model').value === 'vibevoice-asr'"), 'replacement initialization');
    await replaceRun("document.getElementById('apiKey').value = 'fixture-replacement'; document.getElementById('save-btn').click()");
    await waitFor(() => replaceRun("document.getElementById('apiKey-unavailable').hidden"), 'successful replacement');
    state = calls.findLast((call) => call.channel === 'save-settings').data;
    assert.equal(state.apiKey, 'fixture-replacement');
    assert.equal(state.clearUnavailableApiKey, false);
    replacement.destroy();
  }

  async function checkPartialSave() {
    fixture.apiKeyDecryptionFailed = true;
    fixture.apiKeyWarning = '';
    const window = await openPage('settings.html');
    const run = (script) => window.webContents.executeJavaScript(script);
    await waitFor(() => run("document.getElementById('apiKey-unavailable') && !document.getElementById('apiKey-unavailable').hidden"), 'partial save initialization');

    // The key was cleared, but a later shortcut registration failed.
    fixture.apiKeyDecryptionFailed = false;
    fixture.apiKeyWarning = '重新讀取：API Key 以明文儲存';
    saveResult = { ok: false, message: 'fixture shortcut failure', warning: '儲存結果：API Key 以明文儲存' };
    await run("document.getElementById('clear-unavailable-api-key').checked = true; document.getElementById('save-btn').click()");
    await waitFor(() => run("document.getElementById('apiKey-unavailable').hidden"), 'security status reloaded after partial save');
    assert.equal(calls.findLast((call) => call.channel === 'save-settings').data.clearUnavailableApiKey, true);
    assert.equal(await run("document.getElementById('clear-unavailable-api-key').checked"), false);
    assert.equal(await run("document.getElementById('apiKey-warning').textContent"), fixture.apiKeyWarning);
    assert.equal(await run("document.getElementById('apiKey-warning').hidden"), false);
    assert.match(await run("document.getElementById('save-result').textContent"), /fixture shortcut failure/);
    assert.match(await run("document.getElementById('save-result').textContent"), /儲存結果：API Key 以明文儲存/);
    window.destroy();
  }

  app.whenReady().then(async () => {
    await checkMainWindow();
    await checkSettingsWindow();
    await checkSettingsWarnings();
    await checkUnavailableApiKey();
    await checkPartialSave();
    app.exit(0);
  }).catch((error) => {
    console.error(error.stack || error);
    app.exit(1);
  });
} else {
  const test = require('node:test');
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const { promisify } = require('node:util');

  async function launchElectron(executable, args, options, {
    platform = process.platform,
    execute = promisify(execFile)
  } = {}) {
    try {
      return await execute(executable, args, options);
    } catch (error) {
      const sandboxFailure = /no usable sandbox|failed to move to new namespace|suid sandbox helper binary was found, but is not configured correctly|running as root without --no-sandbox/i;
      if (platform !== 'linux' || !sandboxFailure.test(error.stderr || '')) throw error;
      return execute(executable, ['--no-sandbox', ...args], options);
    }
  }

  test('Linux sandbox failure retries only the test fixture with --no-sandbox', async () => {
    const attempts = [];
    const failure = Object.assign(new Error('sandbox failed'), { stderr: 'No usable sandbox!' });
    await launchElectron('electron', ['--user-data-dir=fixture', 'fixture.js'], {}, {
      platform: 'linux',
      execute: async (_executable, args) => {
        attempts.push(args);
        if (attempts.length === 1) throw failure;
      }
    });
    assert.deepEqual(attempts, [
      ['--user-data-dir=fixture', 'fixture.js'],
      ['--no-sandbox', '--user-data-dir=fixture', 'fixture.js']
    ]);
  });

  test('other failures and non-Linux platforms do not disable the sandbox', async () => {
    for (const [platform, stderr] of [
      ['linux', 'AssertionError: test failed'],
      ['win32', 'No usable sandbox!'],
      ['darwin', 'No usable sandbox!']
    ]) {
      const failure = Object.assign(new Error('launch failed'), { stderr });
      const attempts = [];
      await assert.rejects(launchElectron('electron', ['fixture.js'], {}, {
        platform,
        execute: async (_executable, args) => {
          attempts.push(args);
          throw failure;
        }
      }), (error) => error === failure);
      assert.deepEqual(attempts, [['fixture.js']]);
    }
  });

  test('Electron enforces CSP and preserves both local pages with isolated fixtures', { timeout: 60000 }, async () => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(tempRoot, 'voice-typer-csp-'));
    try {
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        DISPLAY: process.env.DISPLAY,
        WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        APPDATA: profile,
        LOCALAPPDATA: profile,
        USERPROFILE: profile,
        XDG_CACHE_HOME: profile,
        XDG_CONFIG_HOME: profile,
        XDG_DATA_HOME: profile,
        TEMP: profile,
        TMP: profile,
        CSP_TEST_PROFILE: profile,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      };
      await launchElectron(require('electron'), [`--user-data-dir=${profile}`, __filename],
        { env, timeout: 25000, maxBuffer: 1024 * 1024 });
    } finally {
      const resolvedProfile = fs.realpathSync(profile);
      if (path.dirname(resolvedProfile) !== tempRoot || !path.basename(resolvedProfile).startsWith('voice-typer-csp-')) {
        // eslint-disable-next-line no-unsafe-finally -- 禁止清理測試目錄以外的路徑。
        throw new Error(`Refusing to remove unexpected test directory: ${resolvedProfile}`);
      }
      fs.rmSync(resolvedProfile, { recursive: true, force: true });
    }
  });
}
