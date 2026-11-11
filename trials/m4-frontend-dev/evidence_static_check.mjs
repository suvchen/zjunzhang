// M4 前端取证（无浏览器依赖版）：跑法 `node evidence_static_check.mjs [port]`
// 先起 mock：node mock_api.mjs 8791
// 判据：契约端点行为（3 房/40 条/display_text 剥头/ext_id/NOT_MEMBER/检索命中/值班板红标）
//       ＋ index.html 关键机制存在性（display_text 优先、SSE＋轮询、NOT_MEMBER 红标、视图切换）。
// 说明：浏览器语义审计（页数恒 1）见 evidence_ego_0*.mjs（需 ego-browser）；本脚本覆盖其余全部断言。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 8791);
const base = `http://127.0.0.1:${PORT}`;
const get = async (p) => (await fetch(base + p)).json();
const results = [];
const T = (name, pass, detail = '') => results.push({ name, pass, detail });

const rooms = await get('/api/rooms?slug=x');
T('契约: /api/rooms 3 房含归档标记', rooms.ok && rooms.rooms.length === 3 && rooms.rooms.some((r) => r.archived), JSON.stringify(rooms.rooms.map((r) => r.name)));
const msgs = await get('/api/rooms/room_demo_r2/messages?slug=x&after=0&limit=200');
T('契约: 首房 40 条 seq 升序', msgs.ok && msgs.messages.length === 40 && msgs.messages.every((m, i) => m.seq === i + 1), 'len=' + msgs.messages.length);
const withHeader = msgs.messages.filter((m) => m.text.startsWith('[huddo:'));
const stripped = msgs.messages.filter((m) => !String(m.display_text || '').startsWith('[huddo:'));
T('契约: text 带导入头而 display_text 剥头', withHeader.length > 0 && stripped.length === msgs.messages.length, `带=${withHeader.length} 剥=${stripped.length}`);
T('契约: ext_id 逐条携带', msgs.messages.every((m) => typeof m.ext_id === 'string' && m.ext_id.startsWith('msg_')), 'count=' + msgs.messages.filter((m) => m.ext_id).length);
const after = await get('/api/rooms/room_demo_r2/messages?slug=x&after=38&limit=200');
T('契约: after 增量（游标语义）', after.ok && after.messages.length === 2 && after.messages[0].seq === 39, 'len=' + after.messages.length);
const s = await get('/api/search?q=' + encodeURIComponent('工单') + '&slug=x');
T('契约: 检索「工单」19 命中', s.ok && s.total === 19, 'total=' + s.total);
const duty = await get('/api/duty/board?slug=x');
T('契约: 值班板含失联成员', duty.ok && duty.members.some((m) => !m.listening), 'members=' + duty.members.length);

const html = fs.readFileSync(path.join(HERE, '..', '..', 'public', 'index.html'), 'utf8');
T('UI: display_text 优先渲染', html.includes('m.display_text !== undefined ? m.display_text : m.text'));
T('UI: SSE＋轮询兜底', html.includes('EventSource') && html.includes('startPoll'));
T('UI: NOT_MEMBER 红标', html.includes('NOT_MEMBER'));
T('UI: 三入口视图切换', html.includes('data-view="search"') && html.includes('data-view="skills"') && html.includes('data-view="duty"'));
T('UI: 按 seq 幂等去重（不重复渲染）', html.includes('if (m.seq <= lastSeq) return;'));
T('UI: 单文件零依赖（无 import/require/构建物）', !/<script[^>]+src=/.test(html) && !html.includes('import '));

let fail = 0;
for (const r of results) { console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ' [' + r.detail + ']' : ''}`); if (!r.pass) fail += 1; }
console.log(fail === 0 ? '== 前端取证(静态+契约): PASS ==' : `== FAIL ${fail} 处 ==`);
process.exit(fail === 0 ? 0 : 1);
