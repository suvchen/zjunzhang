// 用 node 直接抓 huddo 原始 stdout 字节，绕开 PowerShell 重定向的二次编码
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = 'C:\\Users\\Administrator\\AppData\\Local\\hermes\\node\\node.exe';
const HM = 'D:\\huddo\\mcp\\node_modules\\huddoai\\huddo.mjs';
const rooms = [
  ['sp_25421dc3-09fb-4256-845e-5574adede84a', 'huddo_room2.txt'],
  ['sp_1d4f459d-a11f-4149-b2db-2095ed0c25c3', 'huddo_room1.txt'],
];
const env = { ...process.env, HUDDO_HOME: 'C:\\Users\\Administrator\\.huddo' };
for (const [roomId, file] of rooms) {
  const out = spawnSync(NODE, [HM, 'read', '--room', roomId, '--limit', '500'], { env, maxBuffer: 64 * 1024 * 1024 });
  const buf = out.stdout || Buffer.alloc(0);
  fs.writeFileSync(path.join(HERE, file), buf);
  const text = buf.toString('utf8');
  const msgLines = text.split('\n').filter((l) => /^#\d+ /.test(l)).length;
  const eventLines = text.split('\n').filter((l) => /^#- /.test(l)).length;
  console.log(`${roomId.slice(0, 14)}… bytes=${buf.length} 消息行=${msgLines} 事件行=${eventLines} stderr=${(out.stderr || Buffer.alloc(0)).toString('utf8').slice(0, 80)}`);
}
