// 中军帐 · 独立桌面窗口（Electron 主进程）
// 不借浏览器：自带标题栏、自绘界面，连本机 serve API。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn, execFile } = require('child_process');
const fs = require('fs');

// 中军帐 serve 的地址（桌面客户端连的后端）
let API_BASE = process.env.ZJZ_API || 'http://127.0.0.1:8888';

let backendProc = null;
function runNode(cli, args, home) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZJZ_HOME: home },
      windowsHide: true,
    }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function probeHealth(baseUrl) {
  return new Promise((resolve) => {
    const req = http.get(new URL('/api/health', baseUrl), (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function ensureBackend() {
  const candidates = [
    path.join(process.resourcesPath || __dirname, 'bin', 'zjz.mjs'),
    path.join(__dirname, '..', 'bin', 'zjz.mjs'),
    path.join(__dirname, 'bin', 'zjz.mjs'),
  ];
  const cli = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!cli) return { baseUrl: API_BASE, started: false, reason: '未找到 zjz.mjs' };
  const home = process.env.ZJZ_HOME || (app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '..'));
  if (process.env.ZJZ_API && await probeHealth(process.env.ZJZ_API)) {
    API_BASE = process.env.ZJZ_API;
    return { baseUrl: API_BASE, started: false };
  }
  const statusResult = await runNode(cli, ['--home', home, 'serve', 'status'], home);
  try {
    const status = JSON.parse(statusResult.stdout);
    if (status.ok && status.running && status.lease && status.lease.port) {
      API_BASE = `http://127.0.0.1:${status.lease.port}`;
      if (await probeHealth(API_BASE)) return { baseUrl: API_BASE, started: false };
    }
  } catch { }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    backendProc = spawn(process.execPath, [cli, '--home', home, 'serve', '--port', String(port), '--detach'], {
      detached: false, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZJZ_HOME: home },
    });
    for (let i = 0; i < 40; i += 1) {
      if (await probeHealth(baseUrl)) {
        API_BASE = baseUrl;
        return { baseUrl, started: true, cli };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await runNode(cli, ['--home', home, 'serve', 'stop'], home);
    backendProc = null;
    return { baseUrl, started: false, reason: `后端未在 ${baseUrl} 就绪` };
  } catch (error) {
    return { baseUrl, started: false, reason: String(error.message) };
  }
}
// 简易 HTTP 客户端（主进程侧拿数据，避免渲染进程跨源/缓存坑）
function apiGet(pathname) {
  return new Promise((resolve) => {
    const url = new URL(pathname, API_BASE);
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ ok: false, code: 'BAD_JSON', message: body.slice(0, 200) }); }
      });
    }).on('error', (e) => resolve({ ok: false, code: 'CONN', message: String(e.message) }));
  });
}

function apiPost(pathname, data) {
  return new Promise((resolve) => {
    const url = new URL(pathname, API_BASE);
    const payload = JSON.stringify(data);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve({ ok: false, code: 'BAD_JSON', message: body.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, code: 'CONN', message: String(e.message) }));
    req.write(payload);
    req.end();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#0f1a2c',
    title: '中军帐 · 指挥台',
    icon: path.join(__dirname, '..', 'public', 'icon-256.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  // 外部链接用系统浏览器开，别在 app 里开（不借浏览器）
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

// 渲染进程通过 IPC 取数据（主进程当本地 API 网关）
ipcMain.handle('api:get', (_e, pathname) => apiGet(pathname));
ipcMain.handle('api:post', (_e, pathname, data) => apiPost(pathname, data));
ipcMain.handle('api:base', () => API_BASE);

// 单实例：双击两次不该变两个窗口（单窗口多房间是产品口径），第二次只把已有窗口顶到前台
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  ensureBackend().catch(() => {}).then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
