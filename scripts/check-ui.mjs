// 中军帐 UI 体检（Codex）
// 教训：node --check 只抓语法，抓不到「const 重新赋值」这种运行时 TypeError——
// E24-C 曾给 const j 重新赋值，页面当场崩、侧栏和消息流全空（总管 cd59018 真数据抓到）。
// 所以真正的门是：语法 + 花括号 + **无头浏览器加载后 DOM 真的渲染出来了**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('FAIL 找不到内联 script'); process.exit(1); }
const js = m[1];

// 1) 语法
const tmp = path.join(os.tmpdir(), 'zjz-ui-check.mjs');
fs.writeFileSync(tmp, js, 'utf8');
const chk = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
if (chk.status !== 0) { console.error('FAIL 语法错误:\n' + chk.stderr); process.exit(1); }
console.log('PASS 语法 node --check');

// 2) 花括号配平
const opens = (js.match(/\{/g) || []).length, closes = (js.match(/\}/g) || []).length;
if (opens !== closes) { console.error(`FAIL 花括号不配平 { ${opens} vs } ${closes}`); process.exit(1); }
console.log('PASS 花括号配平');

// 3) 运行时冒烟：无头浏览器加载页面，断言 JS 真的跑起来了（DOM 有内容）
const url = process.argv[2] || 'http://127.0.0.1:8888/';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!fs.existsSync(EDGE)) { console.log('SKIP 浏览器冒烟（未找到 Edge）'); console.log('== UI 静态体检 PASS =='); process.exit(0); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-uicheck-'));
const r = spawnSync(EDGE, ['--headless=new', '--disable-gpu', '--virtual-time-budget=6000',
  '--user-data-dir=' + profile, '--dump-dom', url], { encoding: 'utf8', timeout: 40000, maxBuffer: 20 * 1024 * 1024 });
const dom = String(r.stdout || '');
if (dom.length < 2000) { console.error(`FAIL 页面 DOM 只有 ${dom.length} 字节，JS 多半崩了`); process.exit(1); }
if (!/<aside|class="room|class="grp|id="stream"/.test(dom)) { console.error('FAIL 页面结构没渲染出来（JS 可能运行时崩）'); process.exit(1); }
const roomsHtml = (dom.match(/<aside id="rooms"[^>]*>([\s\S]*?)<\/aside>/) || [,''])[1];
const slugHtml = (dom.match(/<select id="slug"[^>]*>([\s\S]*?)<\/select>/) || [,''])[1];
const streamHtml = (dom.match(/<div id="stream"[^>]*>([\s\S]*?)<div id="p-search"/) || [,''])[1];
if (!/class="room|当前身份没有活跃房间|未选身份/.test(roomsHtml + streamHtml)) {
  console.error('FAIL 房间栏/消息区没有业务内容或明确空状态，初始化多半被运行时错误打断');
  process.exit(1);
}
if (!/<option\b/.test(slugHtml) && !/未选身份/.test(dom)) {
  console.error('FAIL 身份下拉没有选项，初始化多半被运行时错误打断');
  process.exit(1);
}
if (/Uncaught (ReferenceError|TypeError)|Uncaught SyntaxError/.test(dom)) {
  console.error('FAIL DOM 中出现未捕获运行时错误');
  process.exit(1);
}
const streamText = streamHtml;
if (/\[huddo:msg_|【时间标|\[时间标/.test(streamText)) {
  console.error('FAIL 消息正文仍显示内部消息 ID 或重复时间标');
  process.exit(1);
}
console.log(`PASS 浏览器冒烟 DOM ${dom.length} 字节，房间栏/消息流已渲染`);
console.log('== UI 体检 PASS ==');
