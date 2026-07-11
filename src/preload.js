// IPC 安全介面（contextIsolation + channel 白名單）
const { contextBridge, ipcRenderer } = require('electron');

// 僅允許已知 channel，避免渲染進程存取任意 IPC
const SEND_CHANNELS = ['audio-captured', 'audio-error', 'open-settings'];
const RECEIVE_CHANNELS = [
  'start-recording',
  'stop-recording',
  'recording-started',
  'recognizing',
  'recognition-complete',
  'recording-limit',
  'history-updated',
  'error'
];
const INVOKE_CHANNELS = [
  'get-settings',
  'save-settings',
  'test-connection',
  'get-history',
  'clear-history',
  'copy-text'
];

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    if (SEND_CHANNELS.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  receive: (channel, func) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  },

  once: (channel, func) => {
    if (RECEIVE_CHANNELS.includes(channel)) {
      ipcRenderer.once(channel, (event, ...args) => func(...args));
    }
  },

  invoke: (channel, data) => {
    if (INVOKE_CHANNELS.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
    return Promise.reject(new Error('未授權的 IPC channel: ' + channel));
  }
});
