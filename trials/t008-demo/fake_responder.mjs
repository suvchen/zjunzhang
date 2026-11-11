// I47 演示夹具：假应答者（被 adapter.run 拉起的无头会话替身）。
// 职责＝模拟「被唤醒的真成员」：读任务文件 → 校验任务含正文与 resume 协议 → 用 zjz CLI 以成员身份回帖。
// 用法（适配器 argv 模板）：node fake_responder.mjs {task_file}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'bin', 'zjz.mjs');
const taskFile = process.argv[2] || process.env.ZJZ_TASK_FILE || '';
if (!taskFile || !fs.existsSync(taskFile)) {
  console.error('fake_responder: 无任务文件');
  process.exit(2);
}
const task = fs.readFileSync(taskFile, 'utf8');

// 从任务体提取要回哪个房（composeTask 格式：--- <room_id> #<seq> <author> ---）
const m = /^--- (\S+) #(\d+) /m.exec(task);
if (!m) {
  console.error('fake_responder: 任务体缺房号行');
  process.exit(3);
}
const [, roomId, seq] = m;
const home = process.env.ZJZ_DEMO_HOME || '';
const slug = process.env.ZJZ_DEMO_SLUG || '';

const res = spawnSync(process.execPath, [CLI, '--home', home, 'send',
  `自动唤醒应答（针对 #${seq}）：任务含正文=${task.includes('必须出现在任务里')}，含 resume 协议=${task.includes('zjz.mjs resume')}`,
  '--room', roomId, '--slug', slug], { encoding: 'utf8', maxBuffer: 16e6 });
console.log((res.stdout || '').trim());
process.exit(res.status === 0 ? 0 : 1);
