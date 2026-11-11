// 初级品 v0.1 装机验收门（Codex）：`zjz selfcheck` 一条命令跑完四判据。
// 装机门第 3 件：这条命令是验收门本身，不是附加功能——对方装上只跑这一条就知道闭环通不通。
// 判据按《初级品-v0.1-装机门.md》第二节；缺前置如实报 BLOCKED（退出码 2），不与产品红混淆。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function tailLines(text) {
  return String(text || '').split(/\r?\n/).filter((l) => /判定|汇总|not ok|# fail|# pass/.test(l)).slice(-2).join(' | ').slice(0, 200);
}

function runGate(cmd, args, ms, cwd) {
  const t0 = Date.now();
  // npm 在 Windows 是 .cmd，Node 22 裸 spawn 会 EINVAL——必须走 shell（其余判据一律直跑，不经 shell）。
  const useShell = cmd === npmCmd;
  const r = spawnSync(cmd, args, { cwd: cwd || REPO, encoding: 'utf8', maxBuffer: 64e6, timeout: ms, shell: useShell });
  const out = (r.stdout || '') + (r.stderr || '');
  return {
    status: r.error ? 'fail' : r.status === 0 ? 'pass' : r.status === 2 ? 'blocked' : 'fail',
    code: r.status === null ? 'TIMEOUT_OR_KILLED' : r.status,
    ms: Date.now() - t0,
    evidence: tailLines(out) || String((r.error && r.error.message) || out || '').slice(0, 200),
  };
}

function serveHealth(port) {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((res) => res.json())
    .catch(() => null);
}

async function ensureServe(home, port) {
  const existing = await serveHealth(port);
  if (existing && existing.ok) return { child: null, health: existing };
  const child = spawn(process.execPath, [path.join(REPO, 'bin', 'zjz.mjs'), '--home', home, 'serve', '--port', String(port)], {
    cwd: REPO, stdio: 'ignore', windowsHide: true,
  });
  for (let i = 0; i < 40; i += 1) {
    const health = await serveHealth(port);
    if (health && health.ok) return { child, health };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try { child.kill(); } catch { /* already gone */ }
  return { child: null, health: null };
}

function closeServe(child) {
  if (!child) return;
  try { child.kill(); } catch { /* already gone */ }
}

function findHostCli() {
  if (process.env.ZJZ_HOST_CLI && fs.existsSync(process.env.ZJZ_HOST_CLI)) return process.env.ZJZ_HOST_CLI;
  const root = path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli');
  if (root && fs.existsSync(root)) {
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const exe = path.join(root, v, 'opencode-cli.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['opencode-cli'], { encoding: 'utf8' });
  return (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

export const selfcheck = {
  async run(home, options = {}) {
    const port = Number(options.port || 8888);
    const fast = options.fast === true;
    const noHost = options.noHost === true;
    const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
    const startedAt = new Date();
    const gates = [];
    const want = (id) => !only || only.has(id);
    const skipped = (name, why, repro) => push(name, { status: 'skip', ms: 0, evidence: why }, repro);
    const push = (name, gate, repro) => {
      gates.push({ name, ...gate, repro: repro || null });
      const mark = { pass: 'PASS', fail: 'FAIL', blocked: 'BLOCKED', skip: 'SKIP' }[gate.status];
      process.stderr.write(`${mark} ${name} (${gate.ms}ms)${gate.evidence ? ' — ' + gate.evidence : ''}\n`);
    };

    if (want('test')) {
      push('判据1 单元测试全绿', runGate(npmCmd, ['test'], 240000), 'npm test');
    } else {
      skipped('判据1 单元测试全绿', '--only 未选', 'npm test');
    }

    if (want('demo')) {
      const served = await ensureServe(home, port);
      const demo = runGate(process.execPath, [path.join(REPO, 'trials', 't008-demo', 'demo_all.mjs'), '--port', String(port), '--home', path.resolve(home)], 300000);
      if (!served.health && demo.status === 'blocked') {
        push('判据2 演示收口 6/6（I45/I46/I47/I48/I49）', { status: 'blocked', ms: demo.ms, evidence: `起服务失败：端口 ${port} 上 /api/health 无响应` }, `node bin/zjz.mjs --home ${home} serve --port ${port}`);
      } else {
        push('判据2 演示收口 6/6（I45/I46/I47/I48/I49）', demo, `node bin/zjz.mjs --home ${home} serve --port ${port} ; node trials/t008-demo/demo_all.mjs --port ${port}`);
      }
      closeServe(served.child);
    } else {
      skipped('判据2 演示收口 6/6（I45/I46/I47/I48/I49）', '--only 未选', 'node trials/t008-demo/demo_all.mjs');
    }

    // 判据5 UI 冒烟：真加载页面，断言 JS 跑起来、房间栏/消息流渲染出来。
    // 教训：node --check 抓不到运行时 TypeError（E24-C 的 const j 崩溃），必须真跑 DOM。
    if (want('ui')) {
      const served = await ensureServe(home, port);
      const ui = runGate(process.execPath, [path.join(REPO, 'scripts', 'check-ui.mjs'), `http://127.0.0.1:${port}/`], 90000);
      if (!served.health && ui.status === 'blocked') {
        push('判据5 UI 冒烟（页面真渲染）', { status: 'blocked', ms: ui.ms, evidence: `起服务失败：端口 ${port} 上 /api/health 无响应` }, `node bin/zjz.mjs --home ${home} serve --port ${port}`);
      } else {
        push('判据5 UI 冒烟（页面真渲染）', ui, `node scripts/check-ui.mjs http://127.0.0.1:${port}/`);
      }
      closeServe(served.child);
    } else {
      skipped('判据5 UI 冒烟（页面真渲染）', '--only 未选', 'node scripts/check-ui.mjs http://127.0.0.1:8888/');
    }
    if (want('replay')) {
      push('判据4a 防重放哨兵（第二周期不得再拉）', runGate(process.execPath, [path.join(REPO, 'trials', 't008-demo', 'replay_guard_check.mjs')], 240000), 'node trials/t008-demo/replay_guard_check.mjs');
    } else {
      skipped('判据4a 防重放哨兵（第二周期不得再拉）', '--only 未选', 'node trials/t008-demo/replay_guard_check.mjs');
    }

    if (!want('longrun')) {
      skipped('判据4b 飞行中不双发哨兵', '--only 未选', 'node trials/t008-demo/longrun_guard_check.mjs');
    } else if (fast) {
      skipped('判据4b 飞行中不双发哨兵', '--fast 跳过（约 140s）', 'node trials/t008-demo/longrun_guard_check.mjs');
    } else {
      push('判据4b 飞行中不双发哨兵', runGate(process.execPath, [path.join(REPO, 'trials', 't008-demo', 'longrun_guard_check.mjs')], 300000), 'node trials/t008-demo/longrun_guard_check.mjs');
    }

    const host = options.hostCli !== undefined ? (options.hostCli || null) : findHostCli();
    if (!want('host')) {
      skipped('判据3 真宿主不盯房被拽回', '--only 未选', 'node trials/t008-demo/i47_real_check.mjs');
    } else if (noHost) {
      skipped('判据3 真宿主不盯房被拽回', '--no-host 跳过（装机演示当天必须跑）', 'node trials/t008-demo/i47_real_check.mjs');
    } else if (!host) {
      push('判据3 真宿主不盯房被拽回', { status: 'blocked', ms: 0, evidence: '未找到宿主 CLI：装 opencode-cli 或设 ZJZ_HOST_CLI 指向可执行' }, '先 powershell -File scripts/install-check.ps1');
    } else {
      push('判据3 真宿主不盯房被拽回', runGate(process.execPath, [path.join(REPO, 'trials', 't008-demo', 'i47_real_check.mjs')], 420000), 'node trials/t008-demo/i47_real_check.mjs');
    }
    const pass = gates.every((g) => g.status === 'pass' || g.status === 'skip');
    const blocked = gates.some((g) => g.status === 'blocked');
    const verdict = pass ? 'PASS' : blocked ? 'BLOCKED' : 'FAIL';

    const dir = path.join(path.resolve(home), 'data', 'selfcheck');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, startedAt.toISOString().replace(/[:.]/g, '-') + '.md');
    fs.writeFileSync(file, [
      `# 中军帐 装机自测 ${startedAt.toISOString()}`,
      '',
      `判定：${verdict}`,
      '',
      '| 判据 | 结果 | 耗时 | 证据尾行 | 复现命令 |',
      '|---|---|---|---|---|',
      ...gates.map((g) => `| ${g.name} | ${g.status} | ${g.ms}ms | ${String(g.evidence || '').replace(/\|/g, '/')} | ${g.repro || ''} |`),
      '',
      `仓库：${REPO}  home：${path.resolve(home)}  节点：${process.version}  端口：${port}  宿主：${host || '未找到'}`,
      `机器：${os.hostname()} ${os.platform()} ${os.release()}`,
    ].join('\n'), 'utf8');

    return {
      ok: verdict === 'PASS',
      verdict,
      gates,
      report: file,
      repo: REPO,
      host_cli: host,
      port,
      node: process.version,
      duration_ms: Date.now() - startedAt.getTime(),
    };
  },
};
