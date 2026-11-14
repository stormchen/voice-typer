// Run directly with Electron, using a disposable user-data directory. This is
// deliberately independent of the application main process and its settings.
if (process.versions.electron) {
  const { app, BrowserWindow, session } = require('electron');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');

  if (!process.env.RECORDER_TEST_USER_DATA) {
    throw new Error('RECORDER_TEST_USER_DATA must point to a disposable directory');
  }
  app.setPath('userData', process.env.RECORDER_TEST_USER_DATA);
  app.setPath('sessionData', process.env.RECORDER_TEST_USER_DATA);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-domain-reliability');

  const watchdog = setTimeout(() => {
    console.error('isolated Electron recorder test timed out');
    app.exit(1);
  }, 20000);

  app.whenReady().then(async () => {
    const isolatedSession = session.fromPartition('recorder-test');
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith('file:') });
    });
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: isolatedSession,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false
      }
    });
    const pages = [path.join(__dirname, 'recorder-electron.html'), process.env.RECORDER_TEST_ASAR_PAGE].filter(Boolean);
    for (const page of pages) {
      await window.loadFile(page);
      const result = await window.webContents.executeJavaScript(`(async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const generator = new AudioContext();
        const oscillator = generator.createOscillator();
        const gain = generator.createGain();
        const stereo = generator.createChannelMerger(2);
        const destination = generator.createMediaStreamDestination();
        gain.gain.value = 0.5;
        oscillator.frequency.value = 440;
        oscillator.connect(gain).connect(stereo, 0, 1);
        stereo.connect(destination);
        oscillator.start();
        await generator.resume();
        const tracks = [];
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: async () => {
            const stream = destination.stream.clone();
            tracks.push(...stream.getTracks());
            return stream;
          } }
        });
        const recorder = new WebAudioRecorder();
        const checkWav = (buffer) => {
          const view = new DataView(buffer);
          let peak = 0;
          for (let i = 44; i < buffer.byteLength; i += 2) {
            peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
          }
          return {
            bytes: buffer.byteLength,
            channels: view.getUint16(22, true),
            rate: view.getUint32(24, true),
            bits: view.getUint16(34, true),
            dataBytes: view.getUint32(40, true),
            peak
          };
        };
        await recorder.start();
        await delay(400);
        const firstStop = recorder.stop();
        const nextStart = recorder.start();
        const first = checkWav(await firstStop);
        await nextStart;
        await delay(250);
        const second = checkWav(await recorder.stop());
        const hidden = document.hidden;
        const stoppedTracks = tracks.map((track) => track.readyState);
        oscillator.stop();
        destination.stream.getTracks().forEach((track) => track.stop());
        await generator.close();
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
        return { hidden, csp, first, second, stoppedTracks };
      })()`);

      assert.equal(window.isVisible(), false);
      // A never-shown Electron window can report a visible document when
      // background throttling is disabled; BrowserWindow visibility is decisive.
      const mainHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
      const mainCsp = mainHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
      assert.ok(mainCsp, 'main page has a Content-Security-Policy');
      assert.equal(result.csp, mainCsp[1], 'the smoke test must use the main page CSP');
      for (const recording of [result.first, result.second]) {
        assert.deepEqual([recording.channels, recording.rate, recording.bits], [1, 16000, 16]);
        assert.equal(recording.dataBytes, recording.bytes - 44);
        assert.ok(recording.dataBytes > 1600, `too little audio: ${recording.dataBytes}`);
        assert.ok(recording.peak > 1000, `no synthetic signal: ${recording.peak}`);
      }
      assert.deepEqual(result.stoppedTracks, ['ended', 'ended']);
      console.log(`isolated hidden Electron recording passed (${page.includes('.asar') ? 'asar' : 'files'}): ${JSON.stringify(result)}`);
    }
    window.destroy();
    clearTimeout(watchdog);
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    clearTimeout(watchdog);
    app.exit(1);
  });
} else {
  const test = require('node:test');
  const { execFile } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { promisify } = require('node:util');

  test('hidden Electron window records synthetic audio under the application CSP', { timeout: 60000 }, async (t) => {
    const tempRoot = fs.realpathSync(os.tmpdir());
    const profile = fs.mkdtempSync(path.join(tempRoot, 'voice-typer-recorder-'));
    try {
      // Exercise the same relative script/worklet URLs from an asar archive,
      // as used by the packaged application, without building or launching it.
      const source = path.join(profile, 'fixture-source');
      for (const directory of ['public', 'test']) fs.mkdirSync(path.join(source, directory), { recursive: true });
      for (const file of ['public/recorder.js', 'public/recorder-worklet.js', 'test/recorder-electron.html']) {
        fs.copyFileSync(path.join(__dirname, '..', file), path.join(source, file));
      }
      const archive = path.join(profile, 'recorder-test.asar');
      await require('@electron/asar').createPackage(source, archive);
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
        RECORDER_TEST_USER_DATA: profile,
        RECORDER_TEST_ASAR_PAGE: path.join(archive, 'test/recorder-electron.html'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      };
      const { stdout } = await promisify(execFile)(require('electron'),
        [__filename, `--user-data-dir=${profile}`], { env, timeout: 50000, maxBuffer: 1024 * 1024 });
      t.diagnostic(stdout.trim());
    } finally {
      const resolved = fs.realpathSync(profile);
      if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('voice-typer-recorder-')) {
        // eslint-disable-next-line no-unsafe-finally -- 禁止清理測試目錄以外的路徑。
        throw new Error(`Refusing to remove unexpected test directory: ${resolved}`);
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
}
