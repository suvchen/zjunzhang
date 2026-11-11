import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const desktopHtml = fs.readFileSync(path.join(ROOT, 'desktop', 'index.html'), 'utf8');
const publicHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const shortcutScript = fs.readFileSync(path.join(ROOT, 'scripts', 'create-shortcut.ps1'), 'utf8');

test('E44 desktop brand image has no dark overlay or shadow', () => {
  assert.match(desktopHtml, /\.titlebar img \{[^}]*background:#fff;[^}]*opacity:1; filter:none; box-shadow:none;/);
  assert.match(desktopHtml, /\.titlebar img \{[^}]*box-shadow:none;/);
});

test('E44-B web brand image has no dark overlay or shadow', () => {
  assert.match(publicHtml, /header \.logo img \{[^}]*background:#fff;[^}]*opacity:1; filter:none; box-shadow:none;/);
  assert.match(publicHtml, /header \.logo img \{[^}]*box-shadow:none;/);
});

test('E44-C desktop shortcut uses the white-background raster icon', () => {
  assert.match(shortcutScript, /public\\icon-256\.png/);
  assert.doesNotMatch(shortcutScript, /public\\favicon\.ico/);
});

test('E44-D raster icon is transparent RGBA (blends with UI) and favicon is populated', () => {
  const png = fs.readFileSync(path.join(ROOT, 'public', 'icon-256.png'));
  assert.equal(png[24], 8, 'PNG bit depth must be 8');
  assert.equal(png[25], 6, 'PNG must be RGBA transparent so the logo blends with the UI background');
  const ico = fs.readFileSync(path.join(ROOT, 'public', 'favicon.ico'));
  assert.ok(ico.length > 1000, 'favicon must contain real image data');
});
