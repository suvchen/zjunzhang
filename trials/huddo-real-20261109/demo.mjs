// 中军帐推广演示（demo）——推广说明里的每个数字，这里当场跑给你看
// 用法：node trials/huddo-real-20261109/demo.mjs   （先跑过 fetch_huddo.mjs＋import_huddo.mjs）
// 只读 trials/huddo-real-20261109/home（真实语料演示库），不碰主干数据。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { search } = await import(pathToFileURL(path.join(ROOT, 'src', 'search.js')));
const { skill } = await import(pathToFileURL(path.join(ROOT, 'src', 'skill.js')));
const { ingest } = await import(pathToFileURL(path.join(ROOT, 'src', 'ingest.js')));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, 'home');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');

function line(s = '') { console.log(s); }
function cli(args) {
  const out = spawnSync(process.execPath, [CLI, '--home', HOME, ...args], { maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out.stdout.toString('utf8')); } catch { return { ok: false, raw: out.stdout.toString('utf8').slice(0, 200) }; }
}

if (!fs.existsSync(path.join(HOME, 'data'))) {
  line('演示库不存在——先跑 fetch_huddo.mjs 与 import_huddo.mjs（见本目录 README.md）');
  process.exit(1);
}

line('== 中军帐 · 5 分钟演示 ==\n');

// 1. 记忆不蒸发：resume 能把项目记忆吐给任何会话
//    （注意：cwd 暂须为仓库根——resume 按 cwd 定位仓库根，此为已知 nit③，Codex 修后此行可去 cwd 参数）
line('【1】新会话救场：zjz resume（治「忘了项目」）');
function cliRepo(args) {
  const out = spawnSync(process.execPath, [CLI, '--home', HOME, ...args], { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out.stdout.toString('utf8')); } catch { return { ok: false, raw: out.stdout.toString('utf8').slice(0, 200) }; }
}
const resumed = cliRepo(['resume']);
const p = String(resumed.progress_summary || '');
line(`  ok=${resumed.ok} 进度摘要 ${p.length} 字｜含今日全部战果: I38=${p.includes('I38')} 验收=${p.includes('验收')} 资源租约=${p.includes('资源租约')}`);
line(`  最近提交: ${(resumed.recent_commits || []).slice(0, 2).join(' ; ')}\n`);

// 2. 说过的话毫秒找回
line('【2】真实交流检索（315+ 条真实团队聊天，当场查）');
const ia = ingest.audit(HOME);
const sa = search.audit(HOME);
line(`  对账: ingest intact=${ia.intact}（mapped=${ia.mapped} ghosts=${ia.ghosts}）｜search intact=${sa.intact}（messages=${sa.messages} indexed=${sa.indexed}）`);
for (const q of ['工单', '换班', '闪现']) {
  const t0 = Date.now();
  const r = search.query(HOME, { q, limit: 1 });
  line(`  「${q}」命中 ${r.total} 条，用时 ${Date.now() - t0}ms`);
}
line('');

// 3. 经验三道闸：缺证据拒入 → 造假来源拒入 → 真来源＋五栏才入
line('【3】经验入库三道闸（你的 AI 不能拿嘴说成绩）');
const cand = skill.candidates(HOME, { q: '两层召回', limit: 1 });
const c = cand.candidates[0];
if (c) {
  const noEvidence = skill.approve(HOME, { candidate_id: c.candidate_id, by: 'demo', card: { problem: 'P', practice: 'Q', boundary: 'B', pitfalls: 'K' }, sources: c.sources });
  line(`  闸一 · 缺「验证证据」栏 → ok=${noEvidence.ok} code=${noEvidence.code}（拒入）`);
  const fakeSource = skill.approve(HOME, { candidate_id: c.candidate_id + '_x', by: 'demo', card: { problem: 'P', practice: 'Q', evidence: 'E', boundary: 'B', pitfalls: 'K' }, sources: [{ room_id: c.room_id, msg_id: 'msg_捏造' }] });
  line(`  闸二 · 来源消息号造假 → ok=${fakeSource.ok} code=${fakeSource.code}（拒入）`);
  const existing = (skill.list(HOME).cards || []).find((row) => row.candidate_id === c.candidate_id);
  const good = existing
    ? { ok: true, card_id: existing.card_id, note: '已入库（演示可重跑）' }
    : skill.approve(HOME, {
    candidate_id: c.candidate_id,
    by: 'demo',
    card: {
      problem: '中文二字词用 FTS5 trigram 检索会零命中',
      practice: 'norm 规范化子串兜底＋FTS5 仅对 ≥3 字符预筛',
      evidence: '红测 T30 真实语料滑窗召回 100%（本演示库可复跑）',
      boundary: '本地单机 sqlite，万条量级',
      pitfalls: '别用 unicode61 分词；改语义先改红测',
    },
      sources: c.sources,
  });
  line(`  闸三 · 五栏齐全＋真实来源 → ok=${good.ok} card=${good.card_id || ''}`);
  if (good.ok) {
    const got = skill.get(HOME, good.card_id);
    line(`  溯源: 点来源回到原消息 intact=${got.intact}「${String(got.sources[0].text).slice(0, 42)}…」`);
    const v = skill.verify(HOME);
    line(`  防篡改: 卡片哈希链 intact=${v.intact}（改一个字即检出）`);
  }
} else {
  line('  （未命中「两层召回」候选，语料可能已更新——跑 import_huddo.mjs 重建后重试）');
}
line('');

// 4. 资源仲裁：抢卡排队不踩踏
line('【4】资源租约（多 Agent 抢一个模型，排队不踩踏）');
const a = cli(['identity', 'new', '--name', '演示甲']);
cli(['resource', 'claim', '--resource', 'demo-gpu', '--slug', a.slug, '--ttl-ms', '30000']);
const b = cli(['resource', 'claim', '--resource', 'demo-gpu', '--slug', (cli(['identity', 'new', '--name', '演示乙'])).slug, '--ttl-ms', '30000']);
line(`  第二个抢卡者: ok=${b.ok} code=${b.code} 排队位=${b.queue_position} 对方还剩 ${b.hold_remaining_ms}ms\n`);

line('== 演示完。上面的每个数字都可复跑，这不是介绍，是账。==');
