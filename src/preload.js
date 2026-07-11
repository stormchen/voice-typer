// IPC 安全介面（contextIsolation）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 發送事件到主進程
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },

  // 接收主進程事件
  receive: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },

  // 一次性接收
  once: (channel, func) => {
    ipcRenderer.once(channel, (event, ...args) => func(...args));
  },

  // 請求/回應模式（invoke/handle）
  invoke: (channel, data) => ipcRenderer.invoke(channel, data)
});
