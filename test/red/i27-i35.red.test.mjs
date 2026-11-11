// T-007 需求①产品化红测（I27-I35）。
// 这组测试刻意留在 npm test 之外：当前应为 RED，待各能力逐条实现后转绿。
// 运行：node --test test/red/i27-i35.red.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'zjz.mjs');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-t007-red-'));
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function run(home, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, '--home', home, ...args], {
    cwd: ROOT,
    env: { ...process.env, ZJZ_HOME: home, ZJZ_DAEMON: '0', ...extraEnv },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    json: parseJson(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function mustRun(home, args, extraEnv = {}) {
  const result = run(home, args, extraEnv);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
  assert.equal(result.json && result.json.ok, true, JSON.stringify(result.json));
  return result.json;
}

function seed(home, texts) {
  const identity = mustRun(home, ['identity', 'new', '--name', `红测员-${Date.now()}`]);
  const room = mustRun(home, ['new', '--name', 'T-007红测房', '--slug', identity.slug]);
  const messages = texts.map((text) => mustRun(home, ['send', text, '--room', room.room_id, '--slug', identity.slug]));
  return { identity, room, messages };
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('I27 检测器零消耗：探活后 wait 仍完整拿走全部消息', () => {
  const home = tmpHome();
  const ctx = seed(home, ['第一条待投递', '第二条待投递', '第三条待投递']);

  const probe1 = run(home, ['monitor', 'probe', '--room', ctx.room.room_id]);
  assert.equal(probe1.json && probe1.json.ok, true, '需要零消耗 monitor probe 接口');
  const probe2 = run(home, ['monitor', 'probe', '--room', ctx.room.room_id]);
  assert.equal(probe2.json && probe2.json.ok, true);

  const waited = mustRun(home, ['wait', '--timeout', '200']);
  assert.deepEqual(waited.messages.map((row) => row.seq), [1, 2, 3], '检测器不得消费业务信号');
});

test('I28 在岗可见性：心跳超龄 60 秒内报 LOST 并落事件', () => {
  const home = tmpHome();
  const ctx = seed(home, ['值班消息']);
  const successor = mustRun(home, ['identity', 'new', '--name', 'I28接班人']);
  mustRun(home, ['duty', 'set', '--slug', ctx.identity.slug, '--mode', 'listen', '--project', 'I28', '--watchdog', `{"enabled":true,"max_age_ms":60000,"successor":"${successor.slug}"}`]);
  mustRun(home, ['duty', 'heartbeat', '--slug', ctx.identity.slug]);

  const tick = mustRun(home, ['watchdog', 'tick', '--slug', ctx.identity.slug, '--now', String(Date.now() + 61000)]);
  assert.ok(tick.alerts.length + tick.shifted.length >= 1, '超龄必须告警或换班');
  const status = mustRun(home, ['watchdog', 'status', '--slug', ctx.identity.slug]);
  assert.equal(status.presence, 'LOST', 'duty/watchdog status 必须给出在岗状态');
  const events = mustRun(home, ['event', 'list', '--project', 'I28']);
  assert.ok(events.events.some((event) => /duty\.(lost|watchdog_alert|watchdog_shift)/.test(event.type)), '失联必须落事件流');
});

test('I29 同身份两会话交替 wait：无重复无遗漏，旧消息可检索', async () => {
  const home = tmpHome();
  const identity = mustRun(home, ['identity', 'new', '--name', '双会话红测员']);
  const room = mustRun(home, ['new', '--name', '双会话房', '--slug', identity.slug]);
  const sent = [];
  for (const text of ['会话甲应收到一', '会话乙应收到二', '会话甲应收到三']) {
    sent.push(mustRun(home, ['send', text, '--room', room.room_id, '--slug', identity.slug]));
  }

  function wait(session) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, '--home', home, 'wait', '--timeout', '1', '--session', session], {
        cwd: ROOT,
        env: { ...process.env, ZJZ_HOME: home, ZJZ_DAEMON: '0' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, json: parseJson(stdout), stderr }));
    });
  }

  const [a, b] = await Promise.all([wait('A'), wait('B')]);
  assert.equal(a.json && a.json.ok, true, a.stderr);
  assert.equal(b.json && b.json.ok, true, b.stderr);
  const seqs = [...(a.json.messages || []), ...(b.json.messages || [])].map((row) => row.seq).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2, 3], '两会话合并不得重复或漏消息');
  mustRun(home, ['search', 'index']);
  const old = mustRun(home, ['search', '会话甲应收到一']);
  assert.equal(old.total, 1, '游标之外必须能检索旧消息');
});

test('I30 环境漂移防御：错误 HOME 启动必须报 CONFIG_DRIFT', () => {
  const home = tmpHome();
  seed(home, ['配置漂移样本']);
  const wrongHome = tmpHome();
  const check = run(home, ['config', 'verify'], { ZJZ_HOME: wrongHome });
  assert.equal(check.json && check.json.ok, false);
  assert.equal(check.json && check.json.code, 'CONFIG_DRIFT');
  assert.match(String(check.json && check.json.path), /ZJZ_HOME|identity_home/);
});

test('I31 保活件静默化：拉起日志必须记录探针与 session=0', () => {
  const home = tmpHome();
  const ctx = seed(home, ['保活件红测']);
  const successor = mustRun(home, ['identity', 'new', '--name', 'I31接班人']);
  mustRun(home, ['duty', 'set', '--slug', ctx.identity.slug, '--mode', 'oncall', '--watchdog', `{"enabled":true,"max_age_ms":1000,"successor":"${successor.slug}"}`]);
  mustRun(home, ['watchdog', 'tick', '--slug', ctx.identity.slug, '--now', String(Date.now() + 2000)]);
  const actions = readJsonl(path.join(home, 'data', 'watchdog', 'actions.jsonl'));
  assert.ok(actions.length > 0);
  assert.ok(actions.some((row) => row.session_id === 0), 'watchdog 动作必须证明 session=0');
  assert.ok(actions.some((row) => row.probe && typeof row.probe.ok === 'boolean'), '拉起/告警必须留探针结果');
});

test('I32 桥链路猝死自愈：探活、静默拉起、revive 事件三件齐全', () => {
  const home = tmpHome();
  const probeFile = path.join(home, 'bridge-probe.txt');
  const reviveFile = path.join(home, 'revive.mjs');
  fs.writeFileSync(probeFile, 'down', 'utf8');
  fs.writeFileSync(reviveFile, `import fs from 'node:fs';\nfs.writeFileSync(process.argv[2], 'up', 'utf8');\n`, 'utf8');
  const check = run(home, ['dependency', 'check', '--name', 'test-bridge', '--probe-file', probeFile, '--expect', 'up', '--revive-file', reviveFile]);
  assert.equal(check.json && check.json.ok, true, '需要依赖链 check 接口');
  assert.equal(check.json && check.json.revived, true);
  assert.equal(fs.readFileSync(probeFile, 'utf8'), 'up');
  const events = mustRun(home, ['event', 'list', '--project', 'dependencies']);
  assert.ok(events.events.some((event) => event.type === 'dependency.revive'), '必须留下 .revive 事件');
});

test('I33 配置加载验证：坏字段点名 path，旧配置保持可用', () => {
  const home = tmpHome();
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:9999' }), 'utf8');
  const good = run(home, ['config', 'verify']);
  assert.equal(good.json && good.json.ok, true, '需要 config verify 加载验证');

  fs.writeFileSync(config, JSON.stringify({ version: 1, endpoint: 123 }), 'utf8');
  const bad = run(home, ['config', 'verify']);
  assert.equal(bad.json && bad.json.ok, false);
  assert.equal(bad.json && bad.json.code, 'CONFIG_INVALID');
  assert.equal(bad.json && bad.json.path, 'endpoint', '错误必须点名字段 path');
  assert.equal(bad.json && bad.json.active_config && bad.json.active_config.endpoint, 'http://127.0.0.1:9999', '坏候选不得替换旧配置');
});

test('I34 项目记忆：resume 返回恢复摘要、最近提交、未闭合工单', () => {
  const home = tmpHome();
  seed(home, ['记忆恢复红测']);
  mustRun(home, ['order', 'dispatch', '--project', 'T-007', '--title', '未闭合红测工单']);
  const repo = tmpHome();
  fs.copyFileSync(path.join(ROOT, 'PROGRESS.md'), path.join(repo, 'PROGRESS.md'));
  fs.copyFileSync(path.join(ROOT, 'error-cards.md'), path.join(repo, 'error-cards.md'));
  spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'red'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'red@local'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['add', 'PROGRESS.md', 'error-cards.md'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'red fixture'], { cwd: repo, encoding: 'utf8' });
  const resumed = run(home, ['resume', '--repo', repo]);
  assert.equal(resumed.json && resumed.json.ok, true, '需要 zjz resume');
  assert.match(String(resumed.json && resumed.json.progress_summary), /T-007|中军帐/);
  assert.ok(Array.isArray(resumed.json && resumed.json.recent_commits) && resumed.json.recent_commits.length > 0);
  assert.ok((resumed.json && resumed.json.open_orders || []).some((order) => order.title === '未闭合红测工单'));

  const anywhere = spawnSync(process.execPath, [CLI, '--home', home, 'resume'], {
    cwd: os.tmpdir(),
    env: { ...process.env, ZJZ_HOME: home, ZJZ_DAEMON: '0' },
    encoding: 'utf8',
  });
  const anywhereJson = parseJson(anywhere.stdout);
  assert.equal(anywhereJson && anywhereJson.ok, true, 'resume 必须能从任意 cwd 定位模块所在仓库');
  assert.match(String(anywhereJson.progress_summary), /T-007|中军帐/);

  fs.renameSync(path.join(repo, 'PROGRESS.md'), path.join(repo, 'PROGRESS.md.red-backup'));
  try {
    const missing = run(home, ['resume', '--repo', repo]);
    assert.equal(missing.json && missing.json.ok, false);
    assert.equal(missing.json && missing.json.code, 'RESUME_SOURCE_MISSING');
  } finally {
    fs.renameSync(path.join(repo, 'PROGRESS.md.red-backup'), path.join(repo, 'PROGRESS.md'));
  }
});

test('I35 资源仲裁：同资源双 claim 只成一个，失败者拿到排队信息', async () => {
  const home = tmpHome();
  const identity = mustRun(home, ['identity', 'new', '--name', '资源仲裁红测员']);

  function claim() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, '--home', home, 'resource', 'claim', '--resource', 'strata-gpu', '--slug', identity.slug, '--ttl-ms', '60000'], {
        cwd: ROOT,
        env: { ...process.env, ZJZ_HOME: home, ZJZ_DAEMON: '0' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, json: parseJson(stdout), stderr }));
    });
  }

  const [first, second] = await Promise.all([claim(), claim()]);
  const results = [first, second].map((item) => item.json).filter(Boolean);
  assert.equal(results.filter((item) => item.ok === true).length, 1, '同一资源只许一个 claim 成功');
  const loser = results.find((item) => item.ok === false);
  assert.equal(loser && loser.code, 'RESOURCE_HELD');
  assert.ok(loser && Number(loser.queue_position) >= 1, '失败者必须拿到排队位置');
  assert.ok(loser && Number(loser.hold_remaining_ms) > 0, '失败者必须看到持有时长');
});
