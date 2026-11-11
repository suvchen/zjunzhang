import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '../src/serve.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zjz-serve-lock-'));
}

test('serve locks are isolated by home', async () => {
  const homeA = tmpHome();
  const homeB = tmpHome();
  const [a, b] = await Promise.all([
    serve.start(homeA, { port: 0 }),
    serve.start(homeB, { port: 0 }),
  ]);
  try {
    assert.ok(a.address);
    assert.ok(b.address);
    assert.notEqual(a.address, b.address);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
