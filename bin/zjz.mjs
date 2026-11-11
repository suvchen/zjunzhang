#!/usr/bin/env node
// 中军帐 CLI：zjz
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { identity, room, msg, order as orderApi, duty as dutyApi } from '../src/core.js';
import { listen as listenApi } from '../src/listen.js';
import { watchdog as watchdogApi } from '../src/watchdog.js';
import { qc as qcApi } from '../src/qc.js';
import { event as eventApi } from '../src/events.js';
import { search as searchApi } from '../src/search.js';
import { skill as skillApi } from '../src/skill.js';
import { monitor as monitorApi } from '../src/monitor.js';
import { config as configApi } from '../src/config.js';
import { dependency as dependencyApi } from '../src/dependency.js';
import { resume as resumeApi } from '../src/resume.js';
import { resource as resourceApi } from '../src/resource.js';
import { delivery as deliveryApi } from '../src/delivery.js';
import { wake as wakeApi } from '../src/wake.js';
import { member as memberApi } from '../src/member.js';
import { adapter as adapterApi } from '../src/adapter.js';
import { feed as feedApi } from '../src/feed.js';
import { serve as serveApi } from '../src/serve.js';
import { selfcheck as selfcheckApi } from '../src/selfcheck.js';

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    let value;
    if (eq !== -1) {
      value = body.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[i + 1];
      i += 1;
    } else {
      value = true;
    }
    if (key === 'mention' || key === 'mentions') {
      if (!Array.isArray(flags.mentions)) flags.mentions = [];
      flags.mentions.push(value);
    } else {
      flags[key] = value;
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgv(process.argv.slice(2));
const home = flags.home || process.env.ZJZ_HOME || process.cwd();

function dataFile(name) {
  return path.join(home, 'data', name);
}

function readCurrent() {
  const file = dataFile('current.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveCurrent(patch) {
  const file = dataFile('current.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = readCurrent() || {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2) + '\n', 'utf8');
}

function requireSlug() {
  const slug = flags.slug || process.env.ZJZ_SLUG || (readCurrent() || {}).slug;
  if (!slug) {
    console.error(JSON.stringify({ ok: false, code: 'BAD_INPUT', message: '未指定身份：先执行 zjz identity new --name X，或用 --slug / ZJZ_SLUG' }, null, 2));
    process.exit(1);
  }
  return slug;
}

function resolveRoom(slug, explicit) {
  if (explicit && explicit !== true) return String(explicit);
  const current = readCurrent() || {};
  if (current.room_id) return current.room_id;
  const listed = room.list(home, slug);
  if (!listed.ok) return null;
  if (listed.rooms.length === 1) return listed.rooms[0].room_id;
  return null;
}

function emit(result) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

function usage() {
  return [
    '中军帐 zjz',
    '',
    '  zjz identity new --name X        新建身份（Ed25519）',
    '  zjz whoami                       当前身份',
    '  zjz new --name 房名               建房 -> room_id + invite_code',
    '  zjz join <invite>                凭邀请码入房',
    '  zjz list                         我加入的房间',
    '  zjz members <room>               房间成员',
    '  zjz send "text" [--room R] [--reply-to M] [--mention X ...]',
    '  zjz read [--room R] [--before S] [--after S] [--limit N]',
    '  zjz wait [--timeout S]           等待新消息（推进游标，daemon 唤醒）',
    '  zjz archive <room>               归档房间（仅房主）',
    '  zjz order dispatch --project P --title T [--deliverables D] [--acceptance A]',
    '  zjz order list [--project P] [--status S] [--assignee X]',
    '  zjz order get|claim|deliver|accept|reject|close <order_id> [--note N]',
    '  zjz duty set [--mode listen|oncall|off] [--project P] [--successor SLUG] [--max-age-ms N] [--check-ms N]',
    '  zjz duty get | duty heartbeat',
    '  zjz duty board [--now T]         投递 SLA 台账（read/answered 超时与工单）',
    '  zjz duty shift --to SLUG [--checkpoint JSON]',
    '  zjz listen start [--timeout S] | listen status | listen stop [--force]',
    '  zjz watchdog tick [--slug S] [--now MS] | watchdog status | watchdog run [--interval S]',
    '  zjz qc open --project P --title T [--gates frame,audio] [--variable-layer L]',
    '  zjz qc attach <case_id> --path FILE --role R [--allow-same --reason R] [--note N]',
    '  zjz qc machine <case_id> --gate G --result pass|fail|insufficient [--metrics JSON]',
    '  zjz qc human <case_id> --verdict pass|fail|conditional [--note N]',
    '  zjz qc close <case_id> --phenomenon P --attribution-layer L --fix F --repro-count N [--conclusion C]',
    '  zjz qc get|verify|summary <case_id> | qc list [--project P] [--status S]',
    '  zjz event list --project P [--after N] [--limit N] | event verify --project P | event projects',
    '  zjz search "关键词" [--room R] [--sender X,Y] [--since T] [--until T] [--limit N]',
    '  zjz search index | search reindex | search audit   增量建索引 / 全量重建 / 索引与消息库对账（I23）',
    '  zjz skill candidates [--room R] [--q 词] [--limit N]',
    '  zjz skill approve <candidate_id> --by SLUG --problem .. --practice .. --evidence .. --boundary .. --pitfalls .. [--sources room/msg,...]',
    '  zjz skill reject <candidate_id> --by SLUG --reason R',
    '  zjz skill list | get <card_id> | verify | audit | search "词"',
    '  zjz monitor probe [--room R]      零消耗只读房间元数据（不消费消息、不推进游标）',
    '  zjz config verify                 配置/环境健康自检（I30/I33）',
    '  zjz dependency check --name N [--endpoint URL] --probe-file F --expect V [--revive-file F]',
    '  zjz resume [--repo R]              按 PROGRESS/error-cards/git log/工单恢复项目记忆（I34）',
    '  zjz resource claim --resource R --ttl-ms N | status R | release R | list',
    '  zjz member set --slug S --adapter-kind spawn|notify|api [--adapter JSON] | wire --slug S --room R | get S | list',
    '    （set 只写配置；要让新用户能被唤醒，用 wire 一条命令建身份＋进房＋绑适配器）',
    '  zjz wake <slug> | wake-exec <slug> | spawn <slug>       投递监督器触发/执行',
    '  zjz selfcheck [--port N] [--fast] [--no-host]  装机验收门：四判据一条命令出 PASS/FAIL（判据3 缺宿主如实 BLOCKED）',
    '  zjz serve [--port N] [--detach] | serve status | serve stop',
    '    （前台跑光标停住是正常的；要后台加 --detach）',
    '',
    '全局：--home H（或 ZJZ_HOME）、--slug S（或 ZJZ_SLUG）',
  ].join('\n');
}

const [command, subcommand] = positional;

async function main() {
  if (!command || command === 'help' || flags.help) {
    process.stdout.write(usage() + '\n');
    return;
  }

  if (command === 'identity') {
    if (subcommand === 'new') {
      const name = flags.name;
      const result = identity.create(home, name);
      if (result.ok) saveCurrent({ slug: result.slug });
      emit({ ok: result.ok, slug: result.slug, code: result.code, message: result.message });
      return;
    }
    if (subcommand === 'list') {
      const file = dataFile('index.json');
      const index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { identities: {} };
      emit({ ok: true, identities: Object.keys(index.identities || {}) });
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz identity new --name X | zjz identity list' });
    return;
  }

  if (command === 'whoami') {
    emit(identity.whoami(home, requireSlug()));
    return;
  }

  if (command === 'new') {
    const slug = requireSlug();
    const result = room.create(home, slug, flags.name);
    if (result.ok) saveCurrent({ room_id: result.room_id });
    emit(result);
    return;
  }

  if (command === 'join') {
    const slug = requireSlug();
    const result = room.join(home, slug, subcommand || flags.invite);
    if (result.ok) saveCurrent({ room_id: result.room_id });
    emit(result);
    return;
  }

  if (command === 'list') {
    emit(room.list(home, requireSlug()));
    return;
  }

  if (command === 'members') {
    const slug = requireSlug();
    const roomId = resolveRoom(slug, subcommand || flags.room);
    if (!roomId) {
      emit({ ok: false, code: 'BAD_INPUT', message: '无法确定房间：请传 <room> 或 --room' });
      return;
    }
    emit(room.members(home, slug, roomId));
    return;
  }

  if (command === 'archive') {
    const slug = requireSlug();
    const roomId = resolveRoom(slug, subcommand || flags.room);
    if (!roomId) {
      emit({ ok: false, code: 'BAD_INPUT', message: '无法确定房间：请传 <room> 或 --room' });
      return;
    }
    emit(room.archive(home, slug, roomId));
    return;
  }

  if (command === 'send') {
    // E21：send 不带 --slug 时署"当前身份"，而 identity new/join 会悄悄切 current → 署错名（署成 @ 对象自己，永不唤醒）。
    // 不硬拦，但署名必须可见：隐式取当前身份时提示署的是谁，建议显式 --slug。
    const explicitSlug = flags.slug || process.env.ZJZ_SLUG;
    const slug = requireSlug();
    if (!explicitSlug) {
      console.error(`[署名提示] 本条以「当前身份」${slug} 署名发出（非 --slug 显式指定）。若这不是你要署的人，请补 --slug <你自己的slug>。`);
    }
    const roomId = resolveRoom(slug, flags.room);
    if (!roomId) {
      emit({ ok: false, code: 'BAD_INPUT', message: '无法确定房间：请传 --room' });
      return;
    }
    let text = subcommand ?? positional[1];
    if (text === '-') {
      if (process.stdin.isTTY) {
        emit({ ok: false, code: 'BAD_INPUT', message: 'send - 需要从 stdin 读取正文，例如：echo 正文 | zjz send -' });
        return;
      }
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      text = chunks.join('');
    }
    text = String(text ?? '').trim();
    if (!text) {
      emit({ ok: false, code: 'BAD_INPUT', message: '正文不能为空；send - 从 stdin 读取正文' });
      return;
    }
    const sent = msg.send(home, slug, roomId, text, {
      reply_to: flags['reply-to'],
      mentions: flags.mentions,
    });
    // E22：CLI 侧回帖也是回帖——zjz send 走 core.msg.send，不经 serve 的 POST 钩子，
    // 不补这一刀 answered_at 就永不写（fresh_home_check 实弹抓到的第三条路径）。
    if (sent.ok) deliveryApi.markAnsweredByAuthor(home, { author: slug });
    emit(sent);
    return;
  }

  // —— 参谋长（会员版）：下达目标 → 拆解 → 派活 → 汇总 ——
  if (command === '参谋长' || command === 'chief' || command === 'plan') {
    if (subcommand === 'list') {
      try {
        const plannerModule = await import('../src/planner.js');
        emit(plannerModule.planner.listPlans(home));
      } catch (error) {
        emit({
          ok: false,
          code: 'FEATURE_NOT_AVAILABLE',
          message: '当前安装包不含会员模块「参谋长」',
          detail: String(error && error.message ? error.message : error),
        });
      }
      return;
    }
    if (subcommand === 'status' || subcommand === 'report') {
      const planId = positional[2] || flags.plan;
      if (!planId) {
        emit({ ok: false, code: 'BAD_INPUT', message: '请提供 plan_id：zjz 参谋长 status <plan_id>' });
        return;
      }
      try {
        const [plannerModule, summarizerModule, supervisorModule] = await Promise.all([
          import('../src/planner.js'),
          import('../src/summarizer.js'),
          import('../src/supervisor.js'),
        ]);
        const loaded = plannerModule.planner.loadPlan(home, planId);
        if (!loaded.ok) { emit(loaded); return; }
        const report = summarizerModule.summarizer.summarizeText(loaded.plan);
        const review = supervisorModule.supervisor.reviewText(loaded.plan);
        emit({ ok: true, plan_id: loaded.plan.plan_id, plan: loaded.plan, report, review });
      } catch (error) {
        emit({
          ok: false,
          code: 'FEATURE_NOT_AVAILABLE',
          message: '当前安装包不含会员模块「参谋长」',
          detail: String(error && error.message ? error.message : error),
        });
      }
      return;
    }
    // 目标来源：--goal / 位置参数 / stdin（避中文命令行转义坑）。支持"参谋长：我要做X"式表述。
    let goal = flags.goal || subcommand || positional.slice(1).join(' ').trim();
    if (!goal && !process.stdin.isTTY) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      goal = chunks.join('').trim();
    }
    goal = String(goal || '').replace(/^参谋长[：:]\s*/, '').trim();
    if (!goal) {
      emit({ ok: false, code: 'BAD_INPUT', message: '参谋长要一个目标。用法：zjz 参谋长 "我要做X"（或 echo 目标 | zjz 参谋长）' });
      return;
    }
    let chief;
    try {
      const [schedulerModule, summarizerModule, supervisorModule] = await Promise.all([
        import('../src/scheduler.js'),
        import('../src/summarizer.js'),
        import('../src/supervisor.js'),
      ]);
      chief = {
        scheduler: schedulerModule.scheduler,
        summarizer: summarizerModule.summarizer,
        supervisor: supervisorModule.supervisor,
      };
    } catch (error) {
      emit({
        ok: false,
        code: 'FEATURE_NOT_AVAILABLE',
        message: '当前安装包不含会员模块「参谋长」',
        detail: String(error && error.message ? error.message : error),
      });
      return;
    }
    const ran = chief.scheduler.runGoal(home, goal);
    if (!ran.ok) { emit(ran); return; }
    const report = chief.summarizer.summarizeText(ran.plan);
    const review = chief.supervisor.reviewText(ran.plan);
    emit({ ok: true, plan_id: ran.plan_id, goal, dispatched: ran.dispatched, report, review });
    return;
  }

  // 删房：能建就能删（仅房主，不可恢复）
  if (command === 'delete' || command === 'rm') {
    const slug = requireSlug();
    const roomId = resolveRoom(slug, subcommand || positional[1] || flags.room);
    if (!roomId) {
      emit({ ok: false, code: 'BAD_INPUT', message: '删哪个房？用法：zjz delete <room_id>（或 --room）' });
      return;
    }
    emit(room.remove(home, slug, roomId));
    return;
  }

  if (command === 'read') {
    const slug = requireSlug();
    const roomId = resolveRoom(slug, flags.room);    if (!roomId) {
      emit({ ok: false, code: 'BAD_INPUT', message: '无法确定房间：请传 --room' });
      return;
    }
    emit(msg.read(home, slug, roomId, {
      before: flags.before,
      after: flags.after,
      limit: flags.limit,
    }));
    return;
  }

  if (command === 'wait') {
    const slug = requireSlug();
    const seconds = flags.timeout === undefined ? 30 : Number(flags.timeout);
    emit(await msg.waitAsync(home, slug, {
      timeout_ms: Math.max(0, seconds) * 1000,
      wake: (ms) => listenApi.waitForChange(home, ms),
    }));
    return;
  }

  if (command === 'order') {
    const slug = requireSlug();
    const orderId = positional[2];
    if (subcommand === 'dispatch') {
      emit(orderApi.dispatch(home, slug, {
        project: flags.project,
        title: flags.title,
        deliverables: flags.deliverables,
        acceptance: flags.acceptance,
        note: flags.note,
      }));
      return;
    }
    if (subcommand === 'list') {
      emit(orderApi.list(home, { project: flags.project, status: flags.status, assignee: flags.assignee }));
      return;
    }
    if (subcommand === 'get') {
      emit(orderApi.get(home, orderId));
      return;
    }
    if (subcommand === 'claim' || subcommand === 'deliver' || subcommand === 'accept' || subcommand === 'reject' || subcommand === 'close') {
      emit(orderApi[subcommand](home, slug, orderId, flags.note));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz order dispatch|list|get|claim|deliver|accept|reject|close' });
    return;
  }

  if (command === 'duty') {
    const slug = requireSlug();
    if (subcommand === 'set') {
      let watchdog;
      if (typeof flags.watchdog === 'string') {
        try {
          watchdog = JSON.parse(flags.watchdog);
        } catch {
          emit({ ok: false, code: 'BAD_INPUT', message: '--watchdog 必须是 JSON' });
          return;
        }
      }
      if (flags.successor !== undefined || flags['max-age-ms'] !== undefined || flags['check-ms'] !== undefined) {
        watchdog = {
          ...(watchdog && typeof watchdog === 'object' ? watchdog : {}),
          ...(flags.successor !== undefined ? { successor: flags.successor } : {}),
          ...(flags['max-age-ms'] !== undefined ? { max_age_ms: Number(flags['max-age-ms']) } : {}),
          ...(flags['check-ms'] !== undefined ? { check_ms: Number(flags['check-ms']) } : {}),
        };
      }
      emit(dutyApi.set(home, slug, { mode: flags.mode, project: flags.project, schedule: flags.schedule, watchdog }));
      return;
    }
    if (subcommand === 'get') {
      emit(dutyApi.get(home, slug));
      return;
    }
    if (subcommand === 'heartbeat') {
      emit(dutyApi.heartbeat(home, slug));
      return;
    }
    if (subcommand === 'shift') {
      let checkpoint;
      if (typeof flags.checkpoint === 'string') {
        try {
          checkpoint = JSON.parse(flags.checkpoint);
        } catch {
          emit({ ok: false, code: 'BAD_INPUT', message: '--checkpoint 必须是 JSON' });
          return;
        }
      }
      emit(dutyApi.shift(home, slug, { to: flags.to, checkpoint }));
      return;
    }
    if (subcommand === 'board') {
      emit(deliveryApi.board(home, { now: flags.now }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz duty set|get|heartbeat|shift|board' });
    return;
  }

  if (command === 'qc') {
    const caseId = positional[2];
    if (subcommand === 'open') {
      const gates = flags.gates === undefined ? [] : String(flags.gates).split(',').map((gate) => gate.trim()).filter(Boolean);
      emit(qcApi.open(home, requireSlug(), {
        project: flags.project,
        title: flags.title,
        variable_layer: flags['variable-layer'],
        gates,
      }));
      return;
    }
    if (subcommand === 'list') {
      emit(qcApi.list(home, { project: flags.project, status: flags.status }));
      return;
    }
    if (subcommand === 'get') {
      emit(qcApi.get(home, caseId));
      return;
    }
    if (subcommand === 'verify') {
      emit(qcApi.verify(home, caseId));
      return;
    }
    if (subcommand === 'summary') {
      emit(qcApi.summary(home, caseId));
      return;
    }
    if (subcommand === 'attach') {
      emit(qcApi.attach(home, requireSlug(), caseId, {
        path: flags.path,
        role: flags.role,
        note: flags.note,
        allow_same: Boolean(flags['allow-same']),
        reason: flags.reason,
      }));
      return;
    }
    if (subcommand === 'machine') {
      let metrics;
      if (typeof flags.metrics === 'string') {
        try {
          metrics = JSON.parse(flags.metrics);
        } catch {
          emit({ ok: false, code: 'BAD_INPUT', message: '--metrics 必须是 JSON' });
          return;
        }
      }
      emit(qcApi.machine(home, requireSlug(), caseId, { gate: flags.gate, result: flags.result, metrics }));
      return;
    }
    if (subcommand === 'human') {
      emit(qcApi.human(home, requireSlug(), caseId, { verdict: flags.verdict, note: flags.note }));
      return;
    }
    if (subcommand === 'close') {
      emit(qcApi.close(home, requireSlug(), caseId, {
        phenomenon: flags.phenomenon,
        attribution_layer: flags['attribution-layer'],
        fix: flags.fix,
        repro_count: flags['repro-count'] === undefined ? undefined : Number(flags['repro-count']),
        repro_note: flags['repro-note'],
        conclusion: flags.conclusion,
      }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz qc open|attach|machine|human|close|get|list|verify|summary' });
    return;
  }

  if (command === 'event') {
    if (subcommand === 'list') {
      emit(eventApi.list(home, { project: flags.project, after: flags.after, limit: flags.limit }));
      return;
    }
    if (subcommand === 'verify') {
      emit(eventApi.verify(home, flags.project));
      return;
    }
    if (subcommand === 'projects') {
      emit(eventApi.projects(home));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz event list|verify|projects' });
    return;
  }

  if (command === 'search') {
    const action = ['index', 'reindex', 'audit'].includes(subcommand) ? subcommand : 'query';
    if (action === 'index') {
      emit(searchApi.index(home));
      return;
    }
    if (action === 'reindex') {
      emit(searchApi.reindex(home));
      return;
    }
    if (action === 'audit') {
      emit(searchApi.audit(home));
      return;
    }
    const q = subcommand || flags.q;
    if (typeof q !== 'string' || q.trim() === '') {
      emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz search "关键词" [--room R] [--sender X,Y] [--since T] [--until T] [--limit N]' });
      return;
    }
    const sender = flags.sender === undefined
      ? undefined
      : String(flags.sender).split(',').map((name) => name.trim()).filter((name) => name !== '');
    emit(searchApi.query(home, {
      q,
      room_id: flags.room,
      slug: flags.slug,
      sender,
      since: flags.since,
      until: flags.until,
      limit: flags.limit === undefined ? undefined : Number(flags.limit),
    }));
    return;
  }

  if (command === 'skill') {
    const action = ['candidates', 'approve', 'reject', 'list', 'get', 'verify', 'audit', 'search'].includes(subcommand) ? subcommand : null;
    if (action === 'candidates') {
      emit(skillApi.candidates(home, {
        room_id: flags.room,
        q: flags.q,
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
      }));
      return;
    }
    if (action === 'approve') {
      const sources = flags.sources === undefined
        ? []
        : String(flags.sources).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
          const cut = part.indexOf('/');
          if (cut <= 0 || cut === part.length - 1) {
            return { invalid: part };
          }
          return { room_id: part.slice(0, cut), msg_id: part.slice(cut + 1) };
        });
      if (sources.some((source) => source.invalid)) {
        emit({ ok: false, code: 'BAD_INPUT', message: '--sources 格式必须是 room/msg[,room/msg...]' });
        return;
      }
      emit(skillApi.approve(home, {
        candidate_id: positional[2],
        by: flags.by,
        card: {
          problem: flags.problem,
          practice: flags.practice,
          evidence: flags.evidence,
          boundary: flags.boundary,
          pitfalls: flags.pitfalls,
        },
        sources,
      }));
      return;
    }
    if (action === 'reject') {
      emit(skillApi.reject(home, { candidate_id: positional[2], by: flags.by, reason: flags.reason }));
      return;
    }
    if (action === 'list') {
      emit(skillApi.list(home));
      return;
    }
    if (action === 'get') {
      emit(skillApi.get(home, positional[2]));
      return;
    }
    if (action === 'verify') {
      emit(skillApi.verify(home));
      return;
    }
    if (action === 'audit') {
      emit(skillApi.audit(home));
      return;
    }
    if (action === 'search') {
      const q = positional[2] || flags.q;
      if (typeof q !== 'string' || q.trim() === '') {
        emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz skill search "关键词" [--room R] [--sender X,Y] [--since T] [--until T] [--limit N]' });
        return;
      }
      const sender = flags.sender === undefined
        ? undefined
        : String(flags.sender).split(',').map((name) => name.trim()).filter((name) => name !== '');
      emit(skillApi.search(home, {
        q,
        room_id: flags.room,
        slug: flags.slug,
        sender,
        since: flags.since,
        until: flags.until,
        limit: flags.limit === undefined ? undefined : Number(flags.limit),
      }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz skill candidates|approve|reject|list|get|verify|audit|search' });
    return;
  }

  if (command === 'monitor') {
    if (subcommand === 'probe') {
      emit(monitorApi.probe(home, { room_id: flags.room }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz monitor probe [--room R]' });
    return;
  }

  if (command === 'config') {
    if (subcommand === 'verify') {
      emit(configApi.verify(home, { file: flags.file }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz config verify' });
    return;
  }

  if (command === 'dependency') {
    if (subcommand === 'check') {
      emit(dependencyApi.check(home, {
        name: flags.name,
        probe_file: flags['probe-file'],
        expect: flags.expect,
        revive_file: flags['revive-file'],
        timeout_ms: flags['timeout-ms'],
      }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz dependency check --name N --probe-file F --expect V [--revive-file F]' });
    return;
  }

  if (command === 'resume') {
    emit(resumeApi(home, { repo: flags.repo }));
    return;
  }

  if (command === 'resource') {
    if (subcommand === 'claim') {
      emit(resourceApi.claim(home, {
        resource: flags.resource,
        slug: requireSlug(),
        ttl_ms: flags['ttl-ms'],
      }));
      return;
    }
    if (subcommand === 'status') {
      emit(resourceApi.status(home, { resource: positional[2] || flags.resource }));
      return;
    }
    if (subcommand === 'release') {
      emit(resourceApi.release(home, { resource: positional[2] || flags.resource, slug: requireSlug() }));
      return;
    }
    if (subcommand === 'list') {
      emit(resourceApi.list(home));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz resource claim|status|release|list' });
    return;
  }

  if (command === 'member') {
    if (subcommand === 'set') {
      let adapterValue = flags.adapter;
      if (typeof adapterValue === 'string') {
        try { adapterValue = JSON.parse(adapterValue); } catch { /* 作为 argv 模板时由 member 校验 */ }
      }
      // E17：shell 转义会把 --adapter 的 JSON 弄成单 token；改用文件传参（不经 shell 引号层）。
      if (flags['adapter-file']) {
        try { adapterValue = JSON.parse(fs.readFileSync(flags['adapter-file'], 'utf8')); }
        catch (error) { emit({ ok: false, code: 'BAD_INPUT', message: `--adapter-file 读不了：${error.message}` }); return; }
      }
      const result = memberApi.set(home, {
        slug: flags.slug,
        adapter_kind: flags['adapter-kind'],
        argv: Array.isArray(adapterValue) ? adapterValue : (typeof adapterValue === 'string' ? [adapterValue] : undefined),
        url: flags.url,
        method: flags.method,
        headers: flags.headers,
        env: flags.env,
        cooldown_ms: flags['cooldown-ms'] === undefined ? undefined : Number(flags['cooldown-ms']),
        max_consecutive: flags['max-consecutive'] === undefined ? undefined : Number(flags['max-consecutive']),
        timeout_ms: flags['timeout-ms'] === undefined ? undefined : Number(flags['timeout-ms']),
        instructions: flags.instructions,
        wake_policy: flags['wake-policy'],
        mention_handles: flags['mention-handles'] === undefined ? undefined : String(flags['mention-handles']).split(',').map((x) => x.trim()).filter(Boolean),
        provider: flags.provider,
      });
      // E20：配置写进去了不等于接通了——当场告警，别让用户跑完 README 却永远等不到唤醒。
      if (result.ok && flags.slug) {
        const wired = memberApi.wiring(home, flags.slug);
        if (wired.ok && !wired.wired) result.warning = wired.warning;
      }
      emit(result);
      return;
    }
    if (subcommand === 'wire') {
      // E20/E28：一条命令接通「建身份＋进房＋绑适配器」。实现统一走 memberApi.wire，CLI 不再自己拼一遍（避免两份实现跑偏）。
      let adapterValue = flags.adapter;
      if (typeof adapterValue === 'string') {
        try { adapterValue = JSON.parse(adapterValue); } catch { /* 交 member 校验 */ }
      }
      if (flags['adapter-file']) {
        try { adapterValue = JSON.parse(fs.readFileSync(flags['adapter-file'], 'utf8')); }
        catch (error) { emit({ ok: false, code: 'BAD_INPUT', message: `--adapter-file 读不了：${error.message}` }); return; }
      }
      emit(memberApi.wire(home, {
        slug: flags.slug,
        room_id: flags.room,
        name: flags.name,
        adapter_kind: flags['adapter-kind'],
        argv: Array.isArray(adapterValue) ? adapterValue : (typeof adapterValue === 'string' ? [adapterValue] : undefined),
        url: flags.url,
        method: flags.method,
        headers: flags.headers,
        env: flags.env,
        cooldown_ms: flags['cooldown-ms'] === undefined ? undefined : Number(flags['cooldown-ms']),
        max_consecutive: flags['max-consecutive'] === undefined ? undefined : Number(flags['max-consecutive']),
        timeout_ms: flags['timeout-ms'] === undefined ? undefined : Number(flags['timeout-ms']),
        instructions: flags.instructions,
        wake_policy: flags['wake-policy'],
        mention_handles: flags['mention-handles'] === undefined ? undefined : String(flags['mention-handles']).split(',').map((x) => x.trim()).filter(Boolean),
        provider: flags.provider,
      }));
      return;
    }
    if (subcommand === 'get') {
      emit(memberApi.get(home, positional[2] || flags.slug));
      return;
    }
    if (subcommand === 'list') {
      emit(memberApi.list(home));
      return;
    }
    if (subcommand === 'providers') {
      emit(memberApi.providers(home, { resource: flags.resource }));
      return;
    }
    if (subcommand === 'adapter-state') {
      emit(adapterApi.state(home, { slug: positional[2] || flags.slug }));
      return;
    }
    if (subcommand === 'reset-adapter') {
      emit(adapterApi.reset(home, { slug: positional[2] || flags.slug }));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz member set|wire|get|list|providers|adapter-state|reset-adapter' });
    return;
  }

  if (command === 'feed') {
    if (subcommand === 'bind') {
      emit(feedApi.bind(home, {
        huddo_room: positional[2] || flags.room,
        slug: flags.slug,
        name: flags.name,
        huddo_home: flags['huddo-home'],
      }));
      return;
    }
    if (subcommand === 'poll') {
      emit(feedApi.poll(home, { huddo_home: flags['huddo-home'], limit: flags.limit === undefined ? undefined : Number(flags.limit) }));
      return;
    }
    if (subcommand === 'bindings') {
      emit(feedApi.bindings(home));
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz feed bind|poll|bindings' });
    return;
  }

  if (command === 'wake' || command === 'wake-exec' || command === 'spawn') {
    const slug = positional[1] || flags.slug;
    if (!slug) {
      emit({ ok: false, code: 'BAD_INPUT', message: `用法：zjz ${command} <slug>` });
      return;
    }
    if (command === 'wake-exec') {
      emit(wakeApi.exec(home, { slug, force: Boolean(flags.force) }));
      return;
    }
    emit(wakeApi.dispatchSync(home, { slug, force: Boolean(flags.force), timeout_ms: flags['timeout-ms'] }));
    return;
  }


  if (command === 'selfcheck') {
    const result = await selfcheckApi.run(home, {
      port: flags.port === undefined ? undefined : Number(flags.port),
      fast: flags.fast === true,
      noHost: flags['no-host'] === true,
      only: typeof flags.only === 'string' ? flags.only.split(',').map((x) => x.trim()).filter(Boolean) : [],
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(result.verdict === 'PASS' ? 0 : result.verdict === 'BLOCKED' ? 2 : 1);
  }

  if (command === 'serve') {
    if (subcommand === 'status') {
      emit(serveApi.status(home));
      return;
    }
    if (subcommand === 'stop') {
      emit(serveApi.stop(home));
      return;
    }
    // E19 --detach：不占前台、不写自己的租约，起一个独立后台 serve 子进程后返回其状态。
    if (flags.detach === true) {
      const childArgs = process.argv.slice(1).filter((token) => token !== '--detach');
      const child = spawn(process.execPath, childArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline) {
        const st = serveApi.status(home);
        if (st.ok && st.running) { ready = true; break; }
        await new Promise((r) => setTimeout(r, 300));
      }
      emit({ ok: ready, detached: true, pid: child.pid, ...(ready ? serveApi.status(home) : { message: 'detached 子进程 20s 内没就绪，查 data/serve/lease.json 与日志' }) });
      return;
    }
    const started = await serveApi.start(home, { port: flags.port === undefined ? undefined : Number(flags.port) });
    if (!started.ok) {
      emit(started);
      return;
    }
    // E19：绑定成功先说清楚"这是正常的前台停住"，再告诉怎么后台起——避免人误 Ctrl+C 把服务关了。
    process.stderr.write('前台运行中，Ctrl+C 停止。要后台：加 --detach，或 Start-Process -WindowStyle Hidden -FilePath node -ArgumentList "bin\\zjz.mjs","--home","<HOME>","serve","--port","<PORT>"\n');
    process.stdout.write(JSON.stringify({ ok: true, address: started.address, host: started.host, port: started.port }, null, 2) + '\n');
    await new Promise((resolve) => {
      let done = false;
      const finish = async () => {
        if (done) return;
        done = true;
        await started.close();
        resolve();
      };
      process.once('SIGINT', finish);
      process.once('SIGTERM', finish);
    });
    return;
  }

  if (command === 'listen') {
    if (subcommand === 'status') {
      emit(listenApi.status(home));
      return;
    }
    if (subcommand === 'stop') {
      emit(listenApi.stop(home, { force: Boolean(flags.force) }));
      return;
    }
    if (subcommand === 'start') {
      const started = listenApi.start(home, {
        ttl_ms: flags['ttl-ms'] === undefined ? undefined : Number(flags['ttl-ms']),
        heartbeat_ms: flags['heartbeat-ms'] === undefined ? undefined : Number(flags['heartbeat-ms']),
      });
      emit(started);
      if (!started.ok) return;
      const seconds = flags.timeout === undefined ? 0 : Number(flags.timeout);
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          listenApi.stop(home);
          resolve();
        };
        process.once('SIGINT', finish);
        process.once('SIGTERM', finish);
        if (Number.isFinite(seconds) && seconds > 0) {
          const timer = setTimeout(finish, seconds * 1000);
          timer.unref();
        }
      });
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz listen start|status|stop' });
    return;
  }

  if (command === 'watchdog') {
    if (subcommand === 'status') {
      if (!flags.slug && !process.env.ZJZ_SLUG && !(readCurrent() || {}).slug) {
        emit({ ok: false, code: 'BAD_INPUT', message: 'watchdog status 需要 --slug 或当前身份' });
        return;
      }
      emit(watchdogApi.status(home, requireSlug()));
      return;
    }
    if (subcommand === 'tick') {
      emit(watchdogApi.tick(home, {
        slug: flags.slug,
        now: flags.now === undefined ? undefined : Number(flags.now),
      }));
      return;
    }
    if (subcommand === 'run') {
      const interval = flags.interval === undefined ? 15 : Number(flags.interval);
      if (!Number.isFinite(interval) || interval <= 0) {
        emit({ ok: false, code: 'BAD_INPUT', message: '--interval 必须是正数（秒）' });
        return;
      }
      let stopping = false;
      process.once('SIGINT', () => { stopping = true; });
      process.once('SIGTERM', () => { stopping = true; });
      while (!stopping) {
        const result = watchdogApi.tick(home, { slug: flags.slug });
        if (!result.ok || result.shifted.length > 0 || result.alerts.length > 0) {
          process.stdout.write(JSON.stringify(result) + '\n');
        }
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
      return;
    }
    emit({ ok: false, code: 'BAD_INPUT', message: '用法：zjz watchdog tick|status|run' });
    return;
  }

  emit({ ok: false, code: 'BAD_INPUT', message: `未知命令：${command}` });
}

await main();


