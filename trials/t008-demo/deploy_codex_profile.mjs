// 修档案：成员 slug 用 core 真实身份（zjz- 前缀），handle 存进 instructions 与 env；分身入镜像房
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const zjz = await import(pathToFileURL(path.join(ROOT, 'src', 'core.js')));
const { member } = await import(pathToFileURL(path.join(ROOT, 'src', 'member.js')));

const H = ROOT;
const MIRROR = 'room_1fd74bec46e7f70f';
const ROOM2 = 'sp_25421dc3-09fb-4256-845e-5574adede84a';

const ident = zjz.identity.create(H, 'Codex分身');
const slug = ident.slug;
const meta = JSON.parse(fs.readFileSync(path.join(H, 'data', 'rooms', MIRROR, 'meta.json'), 'utf8'));
const join = zjz.room.join(H, slug, meta.invite);
console.log('slug=' + slug + ' join=' + JSON.stringify(join).slice(0, 80));

// 清旧（slug=handle 的档案留着无害但会误导，删）
try { fs.unlinkSync(path.join(H, 'data', 'members', 'huddo-codex-362738b0.json')); } catch { }

const reg = member.set(H, {
  slug,
  adapter_kind: 'spawn',
  argv: ['C:\\Users\\Administrator\\AppData\\Roaming\\ai.opencode.desktop\\cli\\2.2.5-x64\\opencode-cli.exe', 'run', '--model', 'local-strata/strata-iq3s-125b', '{task}'],
  env: { HUDDO_HOME: 'D:\\huddo\\data-codex' },
  wake_policy: 'mention',
  mention_handles: ['huddo-codex-362738b0'],
  cooldown_ms: 90000,
  max_consecutive: 2,
  instructions: [
    '你是 huddo 成员 huddo-codex-362738b0 的数字分身，由中军帐唤醒器自动拉起（本体不在盯房）。',
    'HUDDO_HOME 已注入你的环境＝你以该成员本人身份行动。要求：',
    '1) 阅读下方 pending 消息；2) 处理完只回帖一次，命令＝',
    `   node D:/huddo/mcp/node_modules/huddoai/huddo.mjs send - --room ${ROOM2}`,
    '   （把回帖文本经 stdin 管道给该命令）；3) 不做其他任何事、不跑测试、不多发。回帖切题、注明由唤醒器代答。',
  ].join('\n'),
});
console.log('member=' + JSON.stringify(reg));
