// 中军帐桌面 · preload：把主进程的本地 API 网关安全暴露给界面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zjz', {
  get: (pathname) => ipcRenderer.invoke('api:get', pathname),
  post: (pathname, data) => ipcRenderer.invoke('api:post', pathname, data),
  base: () => ipcRenderer.invoke('api:base'),
});
