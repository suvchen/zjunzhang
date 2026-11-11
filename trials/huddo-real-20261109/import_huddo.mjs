// 真实 Huddo 聊天 → zjz 导入演示（只读 Huddo 导出文件，只写 trials 新目录）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { identity, room } = await import(pathToFileURL(path.join(ROOT, 'src', 'core.js')));
const { ingest } = await import(pathToFileURL(path.join(ROOT, 'src', 'ingest.js')));
const { search } = await import(pathToFileURL(path.join(ROOT, 'src', 'search.js')));
const { skill } = await import(pathToFileURL(path.join(ROOT, 'src', 'skill.js')));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.join(HERE, 'home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const HEADER = /^#(\S+) (\S+) \| (.*?) \| (\S+) \| ([\s\S]*)$/;

function parse(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const line of lines) {
    const m = HEADER.exec(line);
    if (m) {
      if (cur) out.push(cur);
      if (m[1] === '-') { cur = null; continue; } // 事件行不导入
      cur = { seq: Number(m[1]), ext_id: m[2], author: m[3].replace(/\s*\(.*\)\s*$/, '').replace(/ \[peer\]$/, ''), ts: m[4], text: m[5] };
    } else if (cur && line !== '') {
      cur.text += '\n' + line;
    }
  }
  if (cur) out.push(cur);
  return out.filter((row) => row.text && row.text.trim() !== '');
}

const sources = [
  { file: path.join(HERE, 'huddo_room2.txt'), name: 'Huddo·中军帐研发' },
  { file: path.join(HERE, 'huddo_room1.txt'), name: 'Huddo·四智能体协作' },
];

const id = identity.create(HOME, '导入官');
if (!id.ok) throw new Error(JSON.stringify(id));
let total = 0;
for (const src of sources) {
  const made = room.create(HOME, id.slug, src.name);
  if (!made.ok) throw new Error(JSON.stringify(made));
  const msgs = parse(src.file);
  const res = ingest.records(HOME, {
    room_id: made.room_id,
    slug: id.slug,
    source: 'huddo',
    records: msgs.map((m) => ({ ext_id: m.ext_id, author: m.author, ts: m.ts, text: m.text })),
  });
  if (!res.ok) throw new Error(JSON.stringify(res));
  console.log(`${src.name}: 取到 ${msgs.length} 条 → 导入 ${res.imported}（跳过 ${res.skipped}）房号 ${made.room_id}`);
  total += res.imported;
}

console.log(`\n幂等复跑：第二次导入同 ext_id 应零新增`);
const againRoom = fs.readdirSync(path.join(HOME, 'data', 'rooms'))[0];
const again = ingest.records(HOME, { room_id: againRoom, slug: id.slug, source: 'huddo', records: parse(sources[0].file).map((m) => ({ ext_id: m.ext_id, text: m.text })) });
console.log(`  imported=${again.imported} skipped=${again.skipped}`);

const ia = ingest.audit(HOME);
const sa = search.audit(HOME);
console.log(`\n对账：ingest.audit intact=${ia.intact} mapped=${ia.mapped} ghosts=${ia.ghosts} orphan=${ia.orphan_msgs}`);
console.log(`      search.audit intact=${sa.intact} messages=${sa.messages} indexed=${sa.indexed} cards=${sa.cards}`);

console.log('\n== 真实交流关键词检索（这就是需求②）==');
for (const q of ['工单', '换班', '哈希链', '闪现', 'zod', '保活', '技能库', '游标']) {
  const t0 = Date.now();
  const res = search.query(HOME, { q, limit: 3 });
  const sample = res.hits[0] ? `${res.hits[0].room_id.slice(0, 12)}… ${res.hits[0].author} 「${res.hits[0].text.slice(0, 40).replace(/\n/g, ' ')}」` : '—';
  console.log(`  「${q}」命中 ${res.total} 条（${Date.now() - t0}ms）例：${sample}`);
}

console.log('\n== 从真实交流里提经验候选（需求③的候选段）==');
const cand = skill.candidates(HOME, { limit: 8 });
console.log(`  候选总数级=${cand.total}`);
for (const c of cand.candidates.slice(0, 4)) {
  console.log(`  · [${c.signals.join(',')}] ${c.room_id.slice(0, 12)}…/${c.msg_id.slice(0, 18)}… 「${c.quote.slice(0, 52).replace(/\n/g, ' ')}」`);
}
