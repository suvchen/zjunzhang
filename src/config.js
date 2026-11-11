// T-007 I30/I33：配置健康自检与加载验证。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

class ConfigError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConfigError(code, message);
}

function ok(payload = {}) {
  return { ok: true, ...payload };
}

function wrap(fn) {
  try {
    return fn();
  } catch (error) {
    return error instanceof ConfigError
      ? { ok: false, code: error.code, message: error.message, path: error.path }
      : { ok: false, code: 'INTERNAL', message: String(error && error.message ? error.message : error) };
  }
}

function homeDir(home) {
  return path.resolve(home || process.env.ZJZ_HOME || process.cwd());
}

function activeFile(home) {
  return path.join(homeDir(home), 'data', 'config.active.json');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readActive(home) {
  try {
    return readJson(activeFile(home));
  } catch {
    return null;
  }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function validate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return 'config';
  if (!Number.isInteger(candidate.version) || candidate.version < 1) return 'version';
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.trim() === '') return 'endpoint';
  return null;
}

function drift(home) {
  const expectedHome = homeDir(home);
  const envHome = process.env.ZJZ_HOME;
  if (envHome && path.resolve(envHome) !== expectedHome) {
    return {
      ok: false,
      code: 'CONFIG_DRIFT',
      path: 'ZJZ_HOME',
      message: `ZJZ_HOME 指向 ${path.resolve(envHome)}，当前 home 为 ${expectedHome}`,
      active_config: readActive(home),
    };
  }
  return null;
}

export function verify(home, options = {}) {
  return wrap(() => {
    const expectedHome = homeDir(home);
    const drifted = drift(home);
    if (drifted) return drifted;
    const file = options.file === undefined || options.file === null || options.file === ''
      ? path.join(expectedHome, 'config.json')
      : path.resolve(String(options.file));
    let candidate;
    try {
      candidate = readJson(file);
    } catch (error) {
      return {
        ok: false,
        code: 'CONFIG_INVALID',
        path: 'file',
        message: `配置无法读取：${error.message}`,
        active_config: readActive(home),
      };
    }
    const invalidPath = validate(candidate);
    if (invalidPath) {
      return {
        ok: false,
        code: 'CONFIG_INVALID',
        path: invalidPath,
        message: `配置字段非法：${invalidPath}`,
        active_config: readActive(home),
      };
    }
    const target = activeFile(home);
    atomicJson(target, candidate);
    const loaded = readActive(home);
    if (JSON.stringify(loaded) !== JSON.stringify(candidate)) {
      return {
        ok: false,
        code: 'CONFIG_LOAD_FAILED',
        path: 'active_config',
        message: '配置写入后读回不一致',
        active_config: loaded,
      };
    }
    return ok({
      home: expectedHome,
      file,
      checked_at: new Date().toISOString(),
      config: candidate,
      active_config: loaded,
    });
  });
}

export const config = { verify };
export default config;
