#!/usr/bin/env node
// 中军帐 MCP stdio 服务：zjz_* 工具，同一核心库。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import process from 'node:process';
import { identity, room, msg, order, duty } from '../src/core.js';
import { inbox } from '../src/inbox.js';
import { search as searchApi } from '../src/search.js';
import { listen } from '../src/listen.js';
import { watchdog } from '../src/watchdog.js';
import { qc } from '../src/qc.js';
import { event } from '../src/events.js';
import { skill as skillApi } from '../src/skill.js';

const argv = process.argv.slice(2);
let home = process.env.ZJZ_HOME || process.cwd();
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--home' && i + 1 < argv.length) {
    home = argv[i + 1];
    i += 1;
  }
}

const SERVER_INFO = { name: 'zjz-mcp', version: '1.0.0' };

function currentSlug() {
  const file = path.join(home, 'data', 'current.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).slug || null;
  } catch {
    return null;
  }
}

function resolveSlug(args) {
  return (args && args.slug) || process.env.ZJZ_SLUG || currentSlug();
}

function needSlug(args) {
  const slug = resolveSlug(args);
  if (!slug) {
    return { ok: false, code: 'BAD_INPUT', message: '未指定身份：先调用 zjz_identity_new，或传 slug / 设置 ZJZ_SLUG' };
  }
  return slug;
}

const TOOLS = [
  {
    name: 'zjz_identity_new',
    description: '新建本地身份（Ed25519 密钥对，slug = zjz-<name>-<rand8>）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '身份名' } },
      required: ['name'],
    },
  },
  {
    name: 'zjz_new',
    description: '新建房间，返回 room_id 与 invite_code（创建者即房主）',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '房间名' },
        slug: { type: 'string', description: '身份 slug（省略则用当前身份）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'zjz_join',
    description: '凭邀请码加入房间',
    inputSchema: {
      type: 'object',
      properties: {
        invite: { type: 'string', description: '邀请码（ZJZ-XXXX-XXXX）' },
        slug: { type: 'string' },
      },
      required: ['invite'],
    },
  },
  {
    name: 'zjz_send',
    description: '向房间发消息（作者私钥签名）',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        text: { type: 'string' },
        slug: { type: 'string' },
        reply_to: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
      },
      required: ['room_id', 'text'],
    },
  },
  {
    name: 'zjz_read',
    description: '读取房间消息（验签；不推进游标）',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        slug: { type: 'string' },
        before: { type: 'number' },
        after: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['room_id'],
    },
  },
  {
    name: 'zjz_wait',
    description: '等待新消息并推进游标（跨已加入房间按 seq 归并）',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: '超时毫秒，默认 30000' },
        slug: { type: 'string' },
      },
    },
  },
  {
    name: 'zjz_members',
    description: '列出房间成员',
    inputSchema: {
      type: 'object',
      properties: { room_id: { type: 'string' }, slug: { type: 'string' } },
      required: ['room_id'],
    },
  },
  {
    name: 'zjz_list',
    description: '列出我加入的房间',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'zjz_whoami',
    description: '当前身份信息',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'zjz_archive',
    description: '归档房间（仅房主；归档后拒收新消息）',
    inputSchema: {
      type: 'object',
      properties: { room_id: { type: 'string' }, slug: { type: 'string' } },
      required: ['room_id'],
    },
  },
  {
    name: 'zjz_order_dispatch',
    description: '派单：创建工单（project/title 必填，状态 dispatched）',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        deliverables: { type: 'string' },
        acceptance: { type: 'string' },
        note: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'zjz_order_list',
    description: '工单列表，可按 project / status / assignee 过滤',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string' },
        assignee: { type: 'string' },
      },
    },
  },
  {
    name: 'zjz_order_get',
    description: '读取单个工单（含 history）',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_order_claim',
    description: '接单：claim_seq 小者胜，后到者返回 CLAIM_LOST',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, slug: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_order_deliver',
    description: '交付工单（仅认领人）',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, note: { type: 'string' }, slug: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_order_accept',
    description: '验收工单（仅派单人）',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, note: { type: 'string' }, slug: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_order_reject',
    description: '驳回工单（仅派单人）',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, note: { type: 'string' }, slug: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_order_close',
    description: '结单（仅派单人；accepted/rejected 可结）',
    inputSchema: {
      type: 'object',
      properties: { order_id: { type: 'string' }, note: { type: 'string' }, slug: { type: 'string' } },
      required: ['order_id'],
    },
  },
  {
    name: 'zjz_duty_set',
    description: '设置值班模式 listen/oncall/off',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        project: { type: 'string' },
        schedule: { type: 'array', items: { type: 'string' } },
        watchdog: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            successor: { type: 'string' },
            max_age_ms: { type: 'number' },
            check_ms: { type: 'number' },
          },
        },
        slug: { type: 'string' },
      },
    },
  },
  {
    name: 'zjz_duty_get',
    description: '读取值班记录（模式/checkpoint/换班日志）',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'zjz_duty_shift',
    description: '换班：存 checkpoint 并交接给接班者（可显式传 checkpoint）',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        checkpoint: { type: 'object' },
        slug: { type: 'string' },
      },
      required: ['to'],
    },
  },
  {
    name: 'zjz_duty_heartbeat',
    description: '更新当前值班心跳（看门狗据此判超龄）',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'zjz_listen_start',
    description: '启动常驻监听（租约单例，跨进程广播有变化；不消费消息）',
    inputSchema: {
      type: 'object',
      properties: {
        ttl_ms: { type: 'number' },
        heartbeat_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'zjz_listen_status',
    description: '查看常驻监听租约状态',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_listen_stop',
    description: '停止常驻监听并释放租约（force=true 可终止其它进程持有的监听）',
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
  },
  {
    name: 'zjz_watchdog_tick',
    description: '执行一次看门狗检查：心跳超龄则按 checkpoint 换班（幂等）',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: '只检查指定值班人，省略则扫描全部' },
        now: { type: 'number', description: '测试用时间注入（毫秒）' },
      },
    },
  },
  {
    name: 'zjz_watchdog_status',
    description: '查看值班人看门狗状态：心跳年龄/是否超龄/接班人',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } },
  },
  {
    name: 'zjz_qc_open',
    description: '开质检台账：project/title 必填，gates 为机器闸清单',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        title: { type: 'string' },
        variable_layer: { type: 'string' },
        gates: { type: 'array', items: { type: 'string' } },
        slug: { type: 'string' },
      },
      required: ['project', 'title'],
    },
  },
  {
    name: 'zjz_qc_attach',
    description: '挂证据：流式计算 SHA256；跨角色同哈希默认拒，allow_same+reason 显式豁免',
    inputSchema: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        path: { type: 'string' },
        role: { type: 'string' },
        note: { type: 'string' },
        allow_same: { type: 'boolean' },
        reason: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['case_id', 'path', 'role'],
    },
  },
  {
    name: 'zjz_qc_machine',
    description: '写机器判定（只认已注册 gate；结果 pass/fail/insufficient）',
    inputSchema: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        gate: { type: 'string' },
        result: { type: 'string', enum: ['pass', 'fail', 'insufficient'] },
        metrics: { type: 'object' },
        slug: { type: 'string' },
      },
      required: ['case_id', 'gate', 'result'],
    },
  },
  {
    name: 'zjz_qc_human',
    description: '写人工终判（与机器判定分栏，不覆盖机器历史）',
    inputSchema: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'conditional'] },
        note: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['case_id', 'verdict'],
    },
  },
  {
    name: 'zjz_qc_close',
    description: '关台账：四栏齐全才可关；baseline 结论需复现 >=2 次',
    inputSchema: {
      type: 'object',
      properties: {
        case_id: { type: 'string' },
        phenomenon: { type: 'string' },
        attribution_layer: { type: 'string' },
        fix: { type: 'string' },
        repro_count: { type: 'number' },
        repro_note: { type: 'string' },
        conclusion: { type: 'string' },
        slug: { type: 'string' },
      },
      required: ['case_id', 'phenomenon', 'attribution_layer', 'fix', 'repro_count'],
    },
  },
  {
    name: 'zjz_qc_get',
    description: '读取质检台账（含证据、机器历史、人工终判、聚合）',
    inputSchema: { type: 'object', properties: { case_id: { type: 'string' } }, required: ['case_id'] },
  },
  {
    name: 'zjz_qc_list',
    description: '质检台账列表，可按 project / status 过滤',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' } } },
  },
  {
    name: 'zjz_qc_verify',
    description: '重算证据哈希，发现篡改/缺失',
    inputSchema: { type: 'object', properties: { case_id: { type: 'string' } }, required: ['case_id'] },
  },
  {
    name: 'zjz_qc_summary',
    description: '质检一行摘要：现象→归因层→修法→复现',
    inputSchema: { type: 'object', properties: { case_id: { type: 'string' } }, required: ['case_id'] },
  },
  {
    name: 'zjz_event_list',
    description: '项目事件流（seq 连续 + 哈希链），after 增量拉取',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        after: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['project'],
    },
  },
  {
    name: 'zjz_event_verify',
    description: '校验项目事件流哈希链完整性',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  },
  {
    name: 'zjz_event_projects',
    description: '列出所有已建事件流的项目',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_search',
    description: '关键词检索全部房间历史消息（两层召回：规范化子串兜底 100% 召回＋FTS5 trigram 预筛），返回消息号/房号/发送者/时间/前后文',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        room_id: { type: 'string' },
        slug: { type: 'string' },
        sender: { type: ['string', 'array'], items: { type: 'string' } },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'zjz_search_index',
    description: '增量补建检索索引（按房 jsonl byte offset 只吃新完整行，幂等；I24）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_search_reindex',
    description: '全量重建检索索引',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_search_audit',
    description: 'I23 对账：索引与消息库逐条核对，自动清幽灵/去重/补漏后报数，intact 必须为 true',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_skill_candidates',
    description: '从消息流定位技能候选；只列带信号词且能回溯到房号/消息号的经验',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string' },
        q: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'zjz_skill_approve',
    description: '通过认可门入库五栏技能卡；缺栏或来源不存在必须拒绝',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        by: { type: 'string' },
        card: {
          type: 'object',
          properties: {
            problem: { type: 'string' },
            practice: { type: 'string' },
            evidence: { type: 'string' },
            boundary: { type: 'string' },
            pitfalls: { type: 'string' },
          },
          required: ['problem', 'practice', 'evidence', 'boundary', 'pitfalls'],
        },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              room_id: { type: 'string' },
              msg_id: { type: 'string' },
              ext_id: { type: 'string' },
            },
          },
        },
      },
      required: ['candidate_id', 'by', 'card', 'sources'],
    },
  },
  {
    name: 'zjz_skill_reject',
    description: '驳回技能候选并保留原因台账',
    inputSchema: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        by: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['candidate_id', 'by', 'reason'],
    },
  },
  {
    name: 'zjz_skill_list',
    description: '列出已认可并入库的技能卡',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_skill_get',
    description: '读取技能卡并回到来源原文',
    inputSchema: {
      type: 'object',
      properties: { card_id: { type: 'string' } },
      required: ['card_id'],
    },
  },
  {
    name: 'zjz_skill_verify',
    description: '校验技能卡哈希链与防篡改完整性',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'zjz_skill_search',
    description: '在已认可技能卡中检索关键词',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        room_id: { type: 'string' },
        slug: { type: 'string' },
        sender: { type: ['string', 'array'], items: { type: 'string' } },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['q'],
    },
  },
  {
    name: 'zjz_skill_audit',
    description: '技能卡↔技能索引对账；补漏、清幽灵、验哈希链',
    inputSchema: { type: 'object', properties: {} },
  },
];

function saveCurrent(patch) {
  const file = path.join(home, 'data', 'current.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    current = {};
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf8');
}

function withCurrent(result, patch) {
  if (result && result.ok) saveCurrent(patch(result));
  return result;
}

// I45：横幅 slug 优先级＝显式 args.slug → 结果里的新 slug → data/current.json 当前身份。
function inboxBanner(args, result) {
  let slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug && result && typeof result.slug === 'string') slug = result.slug;
  if (!slug) {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(home, 'data', 'current.json'), 'utf8'));
      if (typeof cur.slug === 'string') slug = cur.slug;
    } catch { /* 无当前身份则无横幅 */ }
  }
  if (!slug) return null;
  const res = inbox.compose(home, { slug });
  if (!res.ok) return null;
  return { pending_rooms: res.pending_rooms, mention_me: res.mention_me, duty: res.duty, generated_at: res.generated_at };
}

const HANDLERS = {
  zjz_identity_new: (args) => withCurrent(identity.create(home, args.name), (r) => ({ slug: r.slug })),
  zjz_new: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? withCurrent(room.create(home, slug, args.name), (r) => ({ room_id: r.room_id }))
      : slug;
  },
  zjz_join: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? withCurrent(room.join(home, slug, args.invite), (r) => ({ room_id: r.room_id }))
      : slug;
  },
  zjz_send: (args) => {
    const slug = needSlug(args);
    if (typeof slug !== 'string') return slug;
    return msg.send(home, slug, args.room_id, args.text, {
      reply_to: args.reply_to,
      mentions: args.mentions,
    });
  },
  zjz_read: (args) => {
    const slug = needSlug(args);
    if (typeof slug !== 'string') return slug;
    return msg.read(home, slug, args.room_id, {
      before: args.before,
      after: args.after,
      limit: args.limit,
    });
  },
  zjz_wait: async (args) => {
    const slug = needSlug(args);
    if (typeof slug !== 'string') return slug;
    const res = await msg.waitAsync(home, slug, {
      timeout_ms: args.timeout_ms === undefined ? 30000 : args.timeout_ms,
      wake: (ms) => listen.waitForChange(home, ms),
    });
    // I45 自持续契约：每次返回（含超时）都点名「立即再调」＋剩余 pending 计数——值班链不断。
    if (res && res.ok) {
      const banner = inboxBanner(args, res);
      res.pending_after = banner ? banner.pending_rooms.reduce((n, r) => n + r.unread_count, 0) : 0;
      res.next = '立即再调 zjz_wait（值班续听）；inbox 里有未读就先处理再续';
    }
    return res;
  },
  zjz_members: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? room.members(home, slug, args.room_id) : slug;
  },
  zjz_list: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? room.list(home, slug) : slug;
  },
  zjz_whoami: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? identity.whoami(home, slug) : slug;
  },
  zjz_archive: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? room.archive(home, slug, args.room_id) : slug;
  },
  zjz_order_dispatch: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? order.dispatch(home, slug, {
        project: args.project,
        title: args.title,
        deliverables: args.deliverables,
        acceptance: args.acceptance,
        note: args.note,
      })
      : slug;
  },
  zjz_order_list: (args) => order.list(home, {
    project: args.project,
    status: args.status,
    assignee: args.assignee,
  }),
  zjz_order_get: (args) => order.get(home, args.order_id),
  zjz_order_claim: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? order.claim(home, slug, args.order_id) : slug;
  },
  zjz_order_deliver: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? order.deliver(home, slug, args.order_id, args.note) : slug;
  },
  zjz_order_accept: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? order.accept(home, slug, args.order_id, args.note) : slug;
  },
  zjz_order_reject: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? order.reject(home, slug, args.order_id, args.note) : slug;
  },
  zjz_order_close: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? order.close(home, slug, args.order_id, args.note) : slug;
  },
  zjz_duty_set: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? duty.set(home, slug, { mode: args.mode, project: args.project, schedule: args.schedule, watchdog: args.watchdog }) : slug;
  },
  zjz_duty_get: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? duty.get(home, slug) : slug;
  },
  zjz_duty_shift: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? duty.shift(home, slug, { to: args.to, checkpoint: args.checkpoint })
      : slug;
  },
  zjz_duty_heartbeat: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? duty.heartbeat(home, slug) : slug;
  },
  zjz_listen_start: (args) => listen.start(home, {
    ttl_ms: args.ttl_ms,
    heartbeat_ms: args.heartbeat_ms,
  }),
  zjz_listen_status: () => listen.status(home),
  zjz_listen_stop: (args) => listen.stop(home, { force: Boolean(args.force) }),
  zjz_watchdog_tick: (args) => watchdog.tick(home, { slug: args.slug, now: args.now }),
  zjz_watchdog_status: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string' ? watchdog.status(home, slug) : slug;
  },
  zjz_qc_open: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? qc.open(home, slug, {
        project: args.project,
        title: args.title,
        variable_layer: args.variable_layer,
        gates: args.gates,
      })
      : slug;
  },
  zjz_qc_attach: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? qc.attach(home, slug, args.case_id, {
        path: args.path,
        role: args.role,
        note: args.note,
        allow_same: Boolean(args.allow_same),
        reason: args.reason,
      })
      : slug;
  },
  zjz_qc_machine: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? qc.machine(home, slug, args.case_id, { gate: args.gate, result: args.result, metrics: args.metrics })
      : slug;
  },
  zjz_qc_human: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? qc.human(home, slug, args.case_id, { verdict: args.verdict, note: args.note })
      : slug;
  },
  zjz_qc_close: (args) => {
    const slug = needSlug(args);
    return typeof slug === 'string'
      ? qc.close(home, slug, args.case_id, {
        phenomenon: args.phenomenon,
        attribution_layer: args.attribution_layer,
        fix: args.fix,
        repro_count: args.repro_count,
        repro_note: args.repro_note,
        conclusion: args.conclusion,
      })
      : slug;
  },
  zjz_qc_get: (args) => qc.get(home, args.case_id),
  zjz_qc_list: (args) => qc.list(home, { project: args.project, status: args.status }),
  zjz_qc_verify: (args) => qc.verify(home, args.case_id),
  zjz_qc_summary: (args) => qc.summary(home, args.case_id),
  zjz_event_list: (args) => event.list(home, { project: args.project, after: args.after, limit: args.limit }),
  zjz_event_verify: (args) => event.verify(home, args.project),
  zjz_search: (args) => searchApi.query(home, {
    q: args.q,
    room_id: args.room_id,
    slug: args.slug,
    sender: args.sender,
    since: args.since,
    until: args.until,
    limit: args.limit,
  }),
  zjz_search_index: () => searchApi.index(home),
  zjz_search_reindex: () => searchApi.reindex(home),
  zjz_search_audit: () => searchApi.audit(home),
  zjz_skill_candidates: (args) => skillApi.candidates(home, {
    room_id: args.room_id,
    q: args.q,
    limit: args.limit,
  }),
  zjz_skill_approve: (args) => skillApi.approve(home, {
    candidate_id: args.candidate_id,
    by: args.by,
    card: args.card || {
      problem: args.problem,
      practice: args.practice,
      evidence: args.evidence,
      boundary: args.boundary,
      pitfalls: args.pitfalls,
    },
    sources: args.sources,
  }),
  zjz_skill_reject: (args) => skillApi.reject(home, {
    candidate_id: args.candidate_id,
    by: args.by,
    reason: args.reason,
  }),
  zjz_skill_list: () => skillApi.list(home),
  zjz_skill_get: (args) => skillApi.get(home, args.card_id),
  zjz_skill_verify: () => skillApi.verify(home),
  zjz_skill_search: (args) => skillApi.search(home, {
    q: args.q,
    room_id: args.room_id,
    slug: args.slug,
    sender: args.sender,
    since: args.since,
    until: args.until,
    limit: args.limit,
  }),
  zjz_skill_audit: () => skillApi.audit(home),
  zjz_event_projects: () => event.projects(home),
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const handler = HANDLERS[name];
    if (!handler) {
      replyError(id, -32602, `未知工具：${name}`);
      return;
    }
    let result;
    try {
      result = await handler(args);
    } catch (error) {
      result = { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
    }
    // I45 被动带出（T-008 第 0.5 层）：任何工具返回一律附 inbox 横幅——Agent 干活必然调工具，
    // 房讯就骑在每次返回上，零自觉要求。compose 纯读游标对账、不消费游标（I27 不破）。
    // 关键路径越权接线：原分工在 Codex（bin/*），但他未接线前 I45 死锁（见房② #55244/#55234）。
    try {
      const banner = inboxBanner(args, result);
      if (banner) result = { ...result, inbox: banner };
    } catch { /* 横幅失败绝不影响主结果 */ }
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: result.ok === false,
    });
    return;
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] });
    return;
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] });
    return;
  }
  if (id !== undefined) replyError(id, -32601, `未实现方法：${method}`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    replyError(null, -32700, 'JSON 解析失败');
    return;
  }
  if (Array.isArray(request)) {
    for (const item of request) handle(item);
    return;
  }
  handle(request);
});


