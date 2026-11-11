// 中军帐桌面 · preload：把主进程的本地 API 网关安全暴露给界面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zjz', {
  get: (pathname) => ipcRenderer.invoke('api:get', pathname),
  post: (pathname, data) => ipcRenderer.invoke('api:post', pathname, data),
  base: () => ipcRenderer.invoke('api:base'),
  // 升级/收费：检查更新（升级通道）+ 会员状态（付费闸口）
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  memberStatus: () => ipcRenderer.invoke('member:status'),
});
