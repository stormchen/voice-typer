const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const events = new Map();
  const sent = [];
  const elements = new Map();
  const makeElement = () => ({
    className: '', textContent: '', innerHTML: '',
    classList: { add() {}, remove() {} },
    addEventListener() {}, appendChild() {}
  });
  const document = {
    getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement: makeElement,
    addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') callback(); }
  };
  let recorder;
  class FakeRecorder {
    constructor() { recorder = this; }
    async start(onError, id) {
      this.onError = onError;
      this.id = id;
      if (this.startError) throw this.startError;
    }
    async stop(id) { this.stopId = id; return this.audio; }
  }
  const api = {
    receive: (name, callback) => events.set(name, callback),
    send: (name, data) => sent.push({ name, data }),
    invoke: async (name) => name === 'get-history' ? [] : { hotkey: 'Ctrl+Shift+V' }
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/renderer.js'), 'utf8');
  vm.runInNewContext(source, { document, window: { api }, WebAudioRecorder: FakeRecorder, setTimeout });
  return { events, sent, recorder };
}

test('錄音處理器中途失敗時立即回報所屬工作階段', async () => {
  const f = fixture();
  await f.events.get('start-recording')({ id: 42 });
  assert.equal(f.recorder.id, 42);
  f.recorder.onError(new Error('processor failure'));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].name, 'audio-error');
  assert.equal(f.sent[0].data.id, 42);
  assert.match(f.sent[0].data.message, /processor failure/);
});

test('停止錄音時以同一工作階段 ID 回傳 WAV', async () => {
  const f = fixture();
  await f.events.get('start-recording')({ id: 73 });
  const wav = new ArrayBuffer(48);
  f.recorder.audio = wav;
  await f.events.get('stop-recording')({ id: 73 });
  assert.equal(f.recorder.id, 73);
  assert.equal(f.recorder.stopId, 73);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].name, 'audio-captured');
  assert.equal(f.sent[0].data.id, 73);
  assert.equal(f.sent[0].data.audio, wav);
});

test('啟動失敗時回報錄音問題，不誤判為麥克風權限', async () => {
  const f = fixture();
  f.recorder.startError = new Error('前次錄音尚未結束');
  await f.events.get('start-recording')({ id: 9 });
  assert.equal(f.sent[0].data.id, 9);
  assert.match(f.sent[0].data.message, /無法開始錄音/);
  assert.doesNotMatch(f.sent[0].data.message, /無法存取麥克風/);
});
