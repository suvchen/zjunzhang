// 中军帐 装机自测一条命令（总管，trials/t008-demo/selfcheck.mjs）
// 目的：初级品的验收门本身。别人装上后只跑这一条，就能知道「闭环到底通不通」，不靠我口头保证。
// 用法：node trials/t008-demo/selfcheck.mjs [--port 8888] [--fast]（--fast 跳过 140s 的飞行中双发哨兵）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv;
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('--port', '8888');
const FAST = argv.includes('--fast');

const gates = [
  ['单元测试全绿', ['npm', ['test'], 240000]],
  ['演示收口 6/6（I45/I46/I47/I48/I49）', [process.execPath, ['trials/t008-demo/demo_all.mjs', '--port', PORT], 300000]],
  ['防重放哨兵（第二周期不得再拉）', [process.execPath, ['trials/t008-demo/replay_guard_check.mjs'], 240000]],
];
if (!FAST) gates.push(['飞行中不双发哨兵（约 140s）', [process.execPath, ['trials/t008-demo/longrun_guard_check.mjs'], 300000]]);
gates.push(['真宿主不盯房被拽回（真适配器）', [process.execPath, ['trials/t008-demo/i47_real_check.mjs'], 420000]]);

const rows = [];
for (const [name, [cmd, args, ms]] of gates) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: REPO, maxBuffer: 64e6, encoding: 'utf8', timeout: ms, shell: cmd === 'npm' });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = r.status === 0 && !/\bFAIL\b/.test(out);
  rows.push({ name, pass, ms: Date.now() - t0, detail: out.split(/\r?\n/).filter((l) => /判定|汇总|not ok|# fail/.test(l)).slice(-2).join(' | ').slice(0, 180) });
  console.log(`${rows.at(-1).pass ? 'PASS' : 'FAIL'} ${name} (${rows.at(-1).ms}ms)${rows.at(-1).detail ? ' — ' + rows.at(-1).detail : ''}`);
}

const allPass = rows.every((x) => x.pass);
const file = path.join(REPO, 'data', 'selfcheck', new Date().toISOString().replace(/[:.]/g, '-') + '.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, [
  `# 中军帐 装机自测 ${new Date().toISOString()}`,
  '',
  `判定：${allPass ? 'PASS（闭环成立）' : 'FAIL（见下）'}`,
  '',
  '| 判据 | 结果 | 耗时 | 证据尾行 |',
  '|---|---|---|---|',
  ...rows.map((x) => `| ${x.name} | ${x.pass ? 'PASS' : 'FAIL'} | ${x.ms}ms | ${x.detail.replace(/\|/g, '/')} |`),
  '',
  `仓库：${REPO}  节点：${process.version}  参数：--port ${PORT}${FAST ? ' --fast' : ''}`,
].join('\n'), 'utf8');
console.log(`报告：${file}`);
console.log(allPass ? '== 装机自测 PASS ==' : '== 装机自测 FAIL ==');
process.exit(allPass ? 0 : 1);
