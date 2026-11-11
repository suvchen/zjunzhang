// T-007 I34：项目记忆恢复协议。项目状态只认仓库单一真源，不依赖聊天窗口。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { order } from './core.js';

class ResumeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ResumeError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ResumeError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof ResumeError
      ? { ok: false, code: error.code, message: error.message, path: error.path }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function requireFile(repo, name) {
  const file = path.join(repo, name);
  if (!fs.existsSync(file)) {
    const error = new ResumeError('RESUME_SOURCE_MISSING', `缺少项目记忆源：${name}；请在仓库根运行，或传 --repo <仓库根>`);
    error.path = name;
    throw error;
  }
  return file;
}

function isRepoRoot(dir) {
  // 装机包解压根没有 .git，但有 PROGRESS.md/error-cards.md＝项目记忆源齐备，
  // 不能判成"找不到仓库"（12:00 彩排实弹：任务书让宿主在包内跑 resume，直接 RESUME_SOURCE_MISSING）。
  return fs.existsSync(path.join(dir, 'PROGRESS.md'))
    && fs.existsSync(path.join(dir, 'error-cards.md'));
}

function findRepo(explicit) {
  if (explicit !== undefined && explicit !== null && explicit !== '') return path.resolve(String(explicit));
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (;;) {
      if (isRepoRoot(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function progressSummary(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const preferred = lines.filter((line) => /T-007|中军帐|状态：|M1|M2|M3|M4/.test(line));
  return (preferred.length > 0 ? preferred : lines).slice(0, 30).join('\n');
}

export function resume(home, options = {}) {
  return wrap(() => {
    const h = homeDir(home);
    const repo = findRepo(options.repo);
    if (!repo) {
      const error = new ResumeError('RESUME_SOURCE_MISSING', '未能定位项目仓库；请在仓库根运行，或传 --repo <仓库根>');
      error.path = 'repo';
      throw error;
    }
    const progressFile = requireFile(repo, 'PROGRESS.md');
    const errorCardsFile = requireFile(repo, 'error-cards.md');
    const progressText = fs.readFileSync(progressFile, 'utf8');
    const errorText = fs.readFileSync(errorCardsFile, 'utf8');
    const hasGit = fs.existsSync(path.join(repo, '.git'));
    let commits = [];
    let gitNote = null;
    if (hasGit) {
      const git = spawnSync('git', ['log', '--oneline', '-15'], { cwd: repo, encoding: 'utf8' });
      if (git.status !== 0) {
        const error = new ResumeError('GIT_LOG_FAILED', git.stderr || 'git log failed');
        error.path = 'git log';
        throw error;
      }
      commits = git.stdout.split(/\r?\n/).filter(Boolean);
    } else {
      // 装机包没有 git 历史＝降级为只读 PROGRESS/error-cards，不判失败（状态可查不该栽在打包上）。
      gitNote = '包内无 git 历史（装机包解压根）：本次记忆来自 PROGRESS.md/error-cards.md，提交历史请回真源仓库看';
    }
    const listed = order.list(h, {});
    if (!listed.ok) return listed;
    return ok({
      repo,
      progress_summary: progressSummary(progressText),
      error_cards_summary: errorText.split(/\r?\n/).filter((line) => /^##\s+E\d+/.test(line)).join('\n'),
      recent_commits: commits,
      open_orders: listed.orders.filter((item) => item.status !== 'closed'),
      git_available: hasGit,
      note: gitNote,
      steps: [
        '读 PROGRESS.md（项目单一真源）',
        '读 error-cards.md（错误模式）',
        hasGit ? '核对 git log 与未闭合工单' : '包内无 git 历史：核对 PROGRESS/error-cards 与未闭合工单',
      ],
    });
  });
}

export const resumeApi = { resume };
export default resumeApi;
