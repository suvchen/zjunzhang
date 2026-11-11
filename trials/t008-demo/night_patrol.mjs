// 夜间全线巡逻（总管）：一次跑完 npm test＋demo_all＋i47_real＋两哨兵，结果落 data/patrol/<ts>.md。
// 约定：batch 语义已落仓（Codex 2843456/91666b4/d13cefa），replay_guard/longrun_guard 预期转绿——报告如实记，不掩盖。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLUG = process.argv[2] || 'zjz-探针甲1794212057686-ff3e891b';

// 红灯自动复跑一次：本机模型/宿主偶发瞬时不可用（i47_real 曾 ADAPTER_SPAWN_FAILED，直跑即绿）。
// 两次都红才算红，报告里记下两次结果——避免把环境抖动记成产品回归。
function run(label, cmd, args, expect) {
  const once = () => {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, timeout: 900000, shell: true });
    const out = (r.stdout || '') + (r.stderr || '');
    const tail = out.split(/\r?\n/).filter((l) => /PASS|FAIL|判定|汇[总]|tests |pass |fail /.test(l)).slice(-4).join(' | ');
    return { green: r.status === 0, tail };
  };
  let a = once();
  let b = null;
  if (!a.green) { b = a; a = once(); }
  const green = a.green;
  const verdict = (expect === 'red') === !green ? '符合预期' : '!!偏离预期!!';
  const retry = b ? '（首跑红，复跑' + (green ? '绿' : '仍红') + '）' : '';
  return `- ${label}: ${green ? '绿' : '红'}（预期${expect === 'red' ? '红' : '绿'}·${verdict}）${retry}  \n  ${a.tail.slice(0, 400)}`;
}

const lines = [];
const t0 = Date.now();
lines.push(run('npm test', 'npm', ['test'], 'green'));
lines.push(run('demo_all(6/6)', process.execPath, ['trials/t008-demo/demo_all.mjs', '--port', '8888', '--slug', SLUG], 'green'));
lines.push(run('i47_real(真宿主)', process.execPath, ['trials/t008-demo/i47_real_check.mjs'], 'green'));
lines.push(run('replay_guard(跨周期重放)', process.execPath, ['trials/t008-demo/replay_guard_check.mjs'], 'green'));
lines.push(run('longrun_guard(飞行中双发)', process.execPath, ['trials/t008-demo/longrun_guard_check.mjs'], 'green'));

const file = path.join(ROOT, 'data', 'patrol', `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `# 夜巡报告 ${new Date().toISOString()}（用时 ${Math.round((Date.now() - t0) / 1000)}s）\n\n${lines.join('\n')}\n`, 'utf8');
console.log('patrol_written=' + file);
console.log(lines.join('\n'));
