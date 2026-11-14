const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const clipboardPath = require.resolve('../src/components/clipboard');

function fixture() {
  const writes = [];
  const commands = [];
  const errors = [];
  const state = { fail: false };
  const stubs = {
    electron: { clipboard: { writeText: (text) => writes.push(text) } },
    child_process: {
      exec: (command, options, done) => {
        commands.push({ command, options });
        done(state.fail ? new Error('paste failed') : null);
      }
    },
    './logger': { error: (message) => errors.push(message) }
  };
  const originalLoad = Module._load;
  delete require.cache[clipboardPath];
  Module._load = function (request, parent, ...rest) {
    if (parent?.filename === clipboardPath && Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, ...rest);
  };
  let ClipboardManager;
  try {
    ClipboardManager = require(clipboardPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[clipboardPath];
  }
  return { ClipboardManager, writes, commands, errors, state };
}

test('copy-only 僅寫入剪貼簿，不執行模擬按鍵', async () => {
  const f = fixture();
  await f.ClipboardManager.paste('結果', 'copy-only');
  assert.deepEqual(f.writes, ['結果']);
  assert.equal(f.commands.length, 0);
});

test('一般與終端貼上模式使用對應按鍵', async () => {
  const f = fixture();
  await f.ClipboardManager.paste('一', 'ctrl-v');
  await f.ClipboardManager.paste('二', 'shift-insert');
  assert.deepEqual(f.writes, ['一', '二']);
  assert.equal(f.commands.length, 2);
  if (process.platform === 'win32') {
    assert.match(f.commands[0].command, /\^v/);
    assert.match(f.commands[1].command, /\+\{INS\}/);
  } else if (process.platform === 'linux') {
    assert.match(f.commands[0].command, /ctrl\+v/);
    assert.match(f.commands[1].command, /shift\+Insert/);
  } else if (process.platform === 'darwin') {
    assert.match(f.commands[0].command, /command down/);
    assert.match(f.commands[1].command, /command down/);
  }
});

test('模擬貼上失敗仍保留剪貼簿文字並記錄錯誤', async () => {
  const f = fixture();
  f.state.fail = true;
  await f.ClipboardManager.paste('結果');
  assert.deepEqual(f.writes, ['結果']);
  assert.equal(f.errors.length, 1);
});
