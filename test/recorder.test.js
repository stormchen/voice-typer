const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const recorderPath = path.join(__dirname, '../public/recorder.js');
const workletPath = path.join(__dirname, '../public/recorder-worklet.js');
const recorderSource = fs.readFileSync(recorderPath, 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Browser-only audio resources are replaced at the boundary. The recorder and
// the AudioWorkletProcessor themselves run unchanged, with queued port messages.
function makeHarness(options = {}) {
  const streams = [];
  const contexts = [];
  const nodes = [];
  const requests = [];
  const registry = new Map();
  let processorPort;
  let heldStop;

  function failAt(stage) {
    if (options.fail === stage) throw new Error(`failure: ${stage}`);
  }

  function makeStream() {
    const tracks = Array.from({ length: options.trackCount || 1 }, (_, index) => ({
      stopped: 0,
      stop() {
        this.stopped++;
        if (options.throwOnFirstTrack && index === 0) throw new Error('track stop failed');
      }
    }));
    const stream = { tracks, getTracks: () => tracks };
    streams.push(stream);
    return stream;
  }

  class FakeAudioContext {
    constructor() {
      failAt('context');
      this.sampleRate = options.sampleRate || 16000;
      this.destination = {};
      this.closed = 0;
      this.sources = [];
      this.audioWorklet = {
        addModule: async (url) => {
          failAt('module');
          assert.equal(url, pathToFileURL(workletPath).href);
          if (options.moduleGate) await options.moduleGate.promise;
          vm.runInNewContext(fs.readFileSync(workletPath, 'utf8'), {
            AudioWorkletProcessor: class {
              constructor() { this.port = processorPort; }
            },
            registerProcessor(name, constructor) { registry.set(name, constructor); },
            Float32Array
          }, { filename: workletPath });
        }
      };
      contexts.push(this);
    }
    async resume() {
      failAt('resume');
      if (options.resumeGate) await options.resumeGate.promise;
    }
    createMediaStreamSource(stream) {
      failAt('source');
      const source = {
        stream,
        disconnected: 0,
        connect() { failAt('source-connect'); },
        disconnect() { this.disconnected++; }
      };
      this.sources.push(source);
      return source;
    }
    async close() {
      this.closed++;
      if (options.closeGate) await options.closeGate.promise;
      failAt('close');
    }
  }

  class FakeAudioWorkletNode {
    constructor(context, name) {
      failAt('node');
      const Processor = registry.get(name);
      assert.ok(Processor, `processor ${name} was registered`);
      const node = this;
      const sendToProcessor = (data) => queueMicrotask(() => {
        if (node.processor.port.onmessage) node.processor.port.onmessage({ data });
      });
      this.port = {
        onmessage: null,
        postMessage(data) {
          failAt('post-message');
          if (options.holdStop && data.type === 'stop') heldStop = () => sendToProcessor(data);
          else sendToProcessor(data);
        },
        close() {}
      };
      processorPort = {
        onmessage: null,
        postMessage(data, transfer = []) {
          const copy = structuredClone(data, { transfer });
          queueMicrotask(() => {
            if (node.port.onmessage) node.port.onmessage({ data: copy });
          });
        }
      };
      this.processor = new Processor();
      this.disconnected = 0;
      this.connect = () => failAt('node-connect');
      this.disconnect = () => { this.disconnected++; };
      nodes.push(this);
    }
  }

  const sandbox = {
    window: {},
    document: { currentScript: { src: pathToFileURL(recorderPath).href } },
    navigator: { mediaDevices: { getUserMedia: (constraints) => {
      requests.push(constraints);
      if (options.mediaGate) return options.mediaGate.promise;
      if (options.fail === 'media') return Promise.reject(new Error('failure: media'));
      return Promise.resolve(makeStream());
    } } },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeAudioWorkletNode,
    URL,
    Float32Array,
    ArrayBuffer,
    DataView,
    setTimeout: (fn, ms) => setTimeout(fn, options.fastTimers ? 5 : ms),
    clearTimeout
  };
  vm.runInNewContext(recorderSource, sandbox, { filename: recorderPath });
  return {
    Recorder: sandbox.window.WebAudioRecorder,
    requests, streams, contexts, nodes, makeStream,
    push(samples, index = nodes.length - 1) {
      nodes[index].processor.process([[Float32Array.from(samples)]], [[]], {});
    },
    releaseStop() { assert.ok(heldStop, 'stop message was sent'); heldStop(); },
    processorError(index = nodes.length - 1) { nodes[index].onprocessorerror(); }
  };
}

function wav(buffer) {
  const view = new DataView(buffer);
  const text = (start, length) => String.fromCharCode(...new Uint8Array(buffer, start, length));
  return {
    riff: text(0, 4), wave: text(8, 4), format: view.getUint16(20, true),
    channels: view.getUint16(22, true), rate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true), bits: view.getUint16(34, true),
    size: view.getUint32(40, true),
    samples: Array.from({ length: (buffer.byteLength - 44) / 2 }, (_, i) => view.getInt16(44 + 2 * i, true))
  };
}

test('worklet 排空已排隊資料與最後不足一塊的音訊，才關閉並回傳 WAV', async () => {
  const h = makeHarness({ holdStop: true });
  const recorder = new h.Recorder();
  await recorder.start();
  h.push(new Float32Array(4096).fill(1));
  h.push([-1, 0.5]);
  let settled = false;
  const stopping = recorder.stop().finally(() => { settled = true; });
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal(h.contexts[0].closed, 0);
  h.push([-0.5]);
  h.releaseStop();
  const result = wav(await stopping);
  assert.deepEqual([result.riff, result.wave, result.format, result.channels, result.rate, result.byteRate, result.bits],
    ['RIFF', 'WAVE', 1, 1, 16000, 32000, 16]);
  assert.equal(result.size, 4099 * 2);
  assert.equal(result.samples[0], 32767);
  assert.deepEqual(result.samples.slice(-3), [-32768, 16383, -16384]);
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  assert.equal(h.contexts[0].closed, 1);
});

test('48kHz 輸入仍輸出 16kHz PCM 與既有線性重採樣結果', async () => {
  const h = makeHarness({ sampleRate: 48000 });
  const recorder = new h.Recorder();
  await recorder.start();
  h.push([0.2, 0, 0, -0.5, 0, 0, 1, 0, 0, -1, 0, 0]);
  const result = wav(await recorder.stop());
  assert.equal(result.rate, 16000);
  assert.deepEqual(result.samples, [6553, -16384, 32767, -32768]);
});

test('重複啟動共用請求；啟動中停止立即取消，延遲取得的串流仍會關閉', async () => {
  const gate = deferred();
  const h = makeHarness({ mediaGate: gate });
  const recorder = new h.Recorder();
  const first = recorder.start();
  const second = recorder.start();
  assert.equal(h.requests.length, 1);
  assert.equal(await recorder.stop(), null);
  await Promise.all([first, second]);
  const lateStream = h.makeStream();
  gate.resolve(lateStream);
  await new Promise(setImmediate);
  assert.equal(lateStream.tracks[0].stopped, 1);
  assert.equal(h.contexts.length, 0);
  assert.equal(recorder.recording, false);
});

test('停止等待模組載入時清理資源，遲到的完成不會重新開始錄音', async () => {
  const gate = deferred();
  const h = makeHarness({ moduleGate: gate });
  const recorder = new h.Recorder();
  const starting = recorder.start();
  await new Promise(setImmediate);
  assert.equal(await recorder.stop(), null);
  await starting;
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  assert.equal(h.contexts[0].closed, 1);
  gate.resolve();
  await new Promise(setImmediate);
  assert.equal(h.nodes.length, 0);
  assert.equal(recorder.recording, false);
});

test('停止排空期間再次啟動會等待舊資源釋放，並維持獨立錄音', async () => {
  const h = makeHarness({ holdStop: true });
  const recorder = new h.Recorder();
  await recorder.start();
  h.push([1]);
  const stopping = recorder.stop();
  const nextStart = recorder.start();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 1);
  h.releaseStop();
  assert.deepEqual(wav(await stopping).samples, [32767]);
  await nextStart;
  assert.equal(h.requests.length, 2);
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  h.push([-1]);
  const nextStop = recorder.stop();
  h.releaseStop();
  assert.deepEqual(wav(await nextStop).samples, [-32768]);
});

test('排空期間排隊的啟動若又收到停止，不得在停止完成後自行錄音', async () => {
  const h = makeHarness({ holdStop: true });
  const recorder = new h.Recorder();
  await recorder.start();
  h.push([1]);
  const stopping = recorder.stop();
  const queuedStart = recorder.start();
  const finalStop = recorder.stop();
  h.releaseStop();
  await Promise.all([stopping, queuedStart, finalStop]);
  assert.equal(h.requests.length, 1);
  assert.equal(recorder.recording, false);
});

test('不同工作階段不能共用仍在清理的舊錄音結果', async () => {
  const closeGate = deferred();
  const h = makeHarness({ closeGate });
  const recorder = new h.Recorder();
  await recorder.start(undefined, 1);
  h.push([1]);
  const firstStop = recorder.stop(1);
  await new Promise(setImmediate);
  const nextStart = recorder.start(undefined, 2);
  const secondStop = recorder.stop(2);
  try {
    const status = await Promise.race([
      nextStart.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 30))
    ]);
    assert.equal(status, 'rejected');
    assert.equal(await secondStop, null);
  } finally {
    closeGate.resolve();
    await Promise.allSettled([firstStop, nextStart, secondStop]);
  }
});

test('不同工作階段不能停止仍在錄音的舊工作階段', async () => {
  const h = makeHarness();
  const recorder = new h.Recorder();
  await recorder.start(undefined, 1);
  await assert.rejects(recorder.start(undefined, 2), /前次錄音尚未結束/);
  assert.equal(await recorder.stop(2), null);
  assert.equal(recorder.recording, true);
  h.push([1]);
  assert.deepEqual(wav(await recorder.stop(1)).samples, [32767]);
});

test('處理器失敗清理後可以啟動不同工作階段', async () => {
  const closeGate = deferred();
  const h = makeHarness({ closeGate });
  const recorder = new h.Recorder();
  await recorder.start(() => {}, 1);
  h.processorError();
  await assert.rejects(recorder.start(() => {}, 2), /前次錄音尚未結束/);
  closeGate.resolve();
  await new Promise(setImmediate);
  await recorder.start(() => {}, 3);
  h.push([1]);
  assert.deepEqual(wav(await recorder.stop(3)).samples, [32767]);
});

test('處理器錯誤後，即使 AudioContext.close 卡住仍可恢復錄音', async () => {
  const closeGate = deferred();
  const h = makeHarness({ closeGate, fastTimers: true });
  const recorder = new h.Recorder();
  await recorder.start(() => {}, 1);
  h.processorError();
  await new Promise((resolve) => setTimeout(resolve, 25));
  try {
    await recorder.start(() => {}, 2);
    h.push([1]);
    assert.deepEqual(wav(await recorder.stop(2)).samples, [32767]);
  } finally {
    closeGate.resolve();
  }
});

test('停止逾時且 AudioContext.close 卡住時仍可回報錯誤並恢復', async () => {
  const closeGate = deferred();
  const h = makeHarness({ closeGate, fastTimers: true, holdStop: true });
  const recorder = new h.Recorder();
  await recorder.start(() => {}, 1);
  const stopping = recorder.stop(1);
  try {
    const outcome = await Promise.race([
      stopping.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 50))
    ]);
    assert.equal(outcome, 'rejected');
    await recorder.start(() => {}, 2);
    h.push([1]);
    const next = recorder.stop(2);
    h.releaseStop();
    assert.deepEqual(wav(await next).samples, [32767]);
  } finally {
    closeGate.resolve();
    await Promise.allSettled([stopping]);
  }
});

test('啟動任一階段失敗後釋放已取得的音訊資源，且可再次啟動', async (t) => {
  for (const stage of ['media', 'context', 'resume', 'module', 'source', 'node', 'source-connect', 'node-connect']) {
    await t.test(stage, async () => {
      const options = { fail: stage };
      const h = makeHarness(options);
      const recorder = new h.Recorder();
      const errors = [];
      await assert.rejects(recorder.start((error) => errors.push(error)), new RegExp(`failure: ${stage}`));
      assert.equal(errors.length, 0);
      for (const stream of h.streams) assert.equal(stream.tracks[0].stopped, 1);
      for (const context of h.contexts) assert.equal(context.closed, 1);
      assert.equal(recorder.recording, false);
      options.fail = null;
      await recorder.start();
      h.push([1]);
      assert.deepEqual(wav(await recorder.stop()).samples, [32767]);
    });
  }
});

test('錄音中 processorerror 立即通知一次並釋放資源', async () => {
  const h = makeHarness();
  const recorder = new h.Recorder();
  const errors = [];
  await recorder.start((error) => errors.push(error));
  h.push(new Float32Array(4096).fill(1));
  await new Promise(setImmediate);
  assert.equal(recorder.chunks.length, 1);
  const staleHandler = h.nodes[0].onprocessorerror;

  h.processorError();

  assert.equal(errors.length, 1, '事件發生時立即通知，不必等待 stop');
  assert.equal(errors[0].name, 'Error');
  assert.match(errors[0].message, /worklet/i);
  assert.equal(recorder.recording, false);
  assert.equal(recorder.chunks.length, 0);
  assert.equal(h.contexts[0].sources[0].disconnected, 1);
  assert.equal(h.nodes[0].disconnected, 1);
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  await new Promise(setImmediate);
  assert.equal(h.contexts[0].closed, 1);
  staleHandler();
  assert.equal(errors.length, 1, '遲到的事件不得重複通知');
  assert.equal(await recorder.stop(), null, '已通知的錯誤不再經由 stop 重複回報');
});

test('錯誤清理期間排隊啟動保留新 session 的回呼，重複啟動不覆寫', async () => {
  const gate = deferred();
  const h = makeHarness({ closeGate: gate });
  const recorder = new h.Recorder();
  const firstErrors = [];
  const nextErrors = [];
  const ignoredErrors = [];
  await recorder.start((error) => firstErrors.push(error));
  await recorder.start((error) => ignoredErrors.push(error));
  const staleHandler = h.nodes[0].onprocessorerror;

  h.processorError();
  assert.equal(firstErrors.length, 1);
  const nextStart = recorder.start((error) => nextErrors.push(error));
  const duplicateStart = recorder.start((error) => ignoredErrors.push(error));
  assert.equal(h.requests.length, 1, '須等舊資源清理完成');
  gate.resolve();
  await Promise.all([nextStart, duplicateStart]);

  staleHandler();
  assert.equal(recorder.recording, true);
  assert.equal(nextErrors.length, 0, '舊 session 的事件不影響新 session');
  h.processorError();
  assert.equal(firstErrors.length, 1);
  assert.equal(nextErrors.length, 1);
  assert.equal(ignoredErrors.length, 0);
  assert.equal(await recorder.stop(), null);
});

test('停止排空期間排隊啟動保留新 session 的回呼', async () => {
  const h = makeHarness({ holdStop: true });
  const recorder = new h.Recorder();
  const firstErrors = [];
  const nextErrors = [];
  await recorder.start((error) => firstErrors.push(error));
  const stopping = recorder.stop();
  const nextStart = recorder.start((error) => nextErrors.push(error));
  h.releaseStop();
  await stopping;
  await nextStart;

  h.processorError();
  assert.equal(firstErrors.length, 0);
  assert.equal(nextErrors.length, 1);
  assert.equal(await recorder.stop(), null);
});

test('錯誤回呼中立即 stop 不會重複回報同一個錯誤', async () => {
  const h = makeHarness();
  const recorder = new h.Recorder();
  let stopping;
  let notifications = 0;
  await recorder.start(() => {
    notifications++;
    stopping = recorder.stop();
  });

  h.processorError();
  assert.equal(notifications, 1);
  assert.equal(await stopping, null);
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  assert.equal(h.contexts[0].closed, 1);
});

test('錯誤回呼拋出例外仍須釋放音訊資源', async () => {
  const h = makeHarness();
  const recorder = new h.Recorder();
  let called = false;
  await recorder.start(() => {
    called = true;
    throw new Error('callback failed');
  });

  try { h.processorError(); } catch (error) { assert.match(error.message, /callback failed/); }
  assert.equal(called, true);
  assert.equal(recorder.recording, false);
  assert.equal(h.streams[0].tracks[0].stopped, 1);
  assert.equal(h.contexts[0].closed, 1);
});

test('worklet 發生錯誤或未確認停止時回報失敗並釋放資源', async (t) => {
  await t.test('processor error', async () => {
    const h = makeHarness();
    const recorder = new h.Recorder();
    await recorder.start();
    h.processorError();
    await new Promise(setImmediate);
    assert.equal(h.streams[0].tracks[0].stopped, 1);
    assert.equal(h.contexts[0].closed, 1);
    await assert.rejects(recorder.stop(), /worklet/i);
  });
  await t.test('stop timeout', async () => {
    const h = makeHarness({ holdStop: true, fastTimers: true });
    const recorder = new h.Recorder();
    const errors = [];
    await recorder.start((error) => errors.push(error));
    await assert.rejects(recorder.stop(), /worklet|timeout|timed out/i);
    assert.equal(errors.length, 0);
    assert.equal(h.streams[0].tracks[0].stopped, 1);
    assert.equal(h.contexts[0].closed, 1);
    assert.equal(recorder.chunks.length, 0);
  });
  await t.test('processor error while draining', async () => {
    const h = makeHarness({ holdStop: true });
    const recorder = new h.Recorder();
    const errors = [];
    await recorder.start((error) => errors.push(error));
    h.push(new Float32Array(4096).fill(1));
    const stopping = recorder.stop();
    await new Promise(setImmediate);
    h.processorError();
    await assert.rejects(stopping, /worklet/i);
    assert.equal(errors.length, 0);
    assert.equal(h.streams[0].tracks[0].stopped, 1);
    assert.equal(h.contexts[0].closed, 1);
    assert.equal(recorder.chunks.length, 0);
  });
});

test('單一 track 停止或 context 關閉失敗不阻止其他清理', async () => {
  const h = makeHarness({ trackCount: 2, throwOnFirstTrack: true, fail: 'close' });
  const recorder = new h.Recorder();
  await recorder.start();
  h.push([1]);
  assert.deepEqual(wav(await recorder.stop()).samples, [32767]);
  assert.deepEqual(h.streams[0].tracks.map((track) => track.stopped), [1, 1]);
  assert.equal(h.contexts[0].closed, 1);
  assert.equal(h.contexts[0].sources[0].disconnected, 1);
  assert.equal(h.nodes[0].disconnected, 1);
});
