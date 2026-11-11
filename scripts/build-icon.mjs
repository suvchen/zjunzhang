// 中军帐 应用图标构建（Codex，房② #57283 接线侧）
// 输入：public/icon.svg（MiMo 设计）→ 输出：icon-{256,64,48,32,16}.png + favicon.ico + icon.png
// 256px 用 Edge 无头渲染；小尺寸用 System.Drawing 高质量双三次降采样（Edge 小视口会渲染成空白，实测 16px 只有 108B）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SVG = path.join(ROOT, 'public', 'icon.svg');
const OUT = path.join(ROOT, 'public');
const SIZES = [256, 64, 48, 32, 16];
const BIG = 256;

if (!fs.existsSync(SVG)) { console.error('缺 public/icon.svg'); process.exit(1); }

// 1) 256px：Edge 无头渲染 SVG（每次独立 profile，避开与运行中 app 窗口抢 profile）
const big = path.join(OUT, `icon-${BIG}.png`);
if (!fs.existsSync(big) || fs.statSync(big).size < 1000) {
  for (let i = 1; i <= 3; i++) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-icon-'));
    spawnSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
      '--default-background-color=00000000', '--user-data-dir=' + profile,
      `--screenshot=${big}`, `--window-size=${BIG},${BIG}`,
      'file:///' + SVG.replace(/\\/g, '/')], { encoding: 'utf8', timeout: 30000 });
    if (fs.existsSync(big) && fs.statSync(big).size > 1000) break;
  }
}
if (!fs.existsSync(big) || fs.statSync(big).size < 1000) { console.error('256px 渲染失败'); process.exit(1); }
console.log(`256px -> ${fs.statSync(big).size}B`);

// 2) 小尺寸：System.Drawing 高质量降采样（PowerShell 一次性，脚本必须 UTF-8 BOM）
const ps = [
  'Add-Type -AssemblyName System.Drawing',
  `$img = [System.Drawing.Image]::FromFile('${big.replace(/\//g, '\\')}')`,
  'foreach ($n in @(64,48,32,16)) {',
  '  $bmp = New-Object System.Drawing.Bitmap $n, $n',
  '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
  '  $g.InterpolationMode = \'HighQualityBicubic\'; $g.SmoothingMode = \'HighQuality\'',
  '  $g.PixelOffsetMode = \'HighQuality\'; $g.CompositingQuality = \'HighQuality\'',
  '  $g.Clear([System.Drawing.Color]::Transparent)',
  '  $g.DrawImage($img, 0, 0, $n, $n)',
  `  $bmp.Save((Join-Path '${OUT.replace(/\//g, '\\')}' ('icon-' + $n + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)`,
  '  $g.Dispose(); $bmp.Dispose()',
  '}',
  '$img.Dispose()',
].join('\r\n');
const psFile = path.join(os.tmpdir(), 'zjz-downscale.ps1');
fs.writeFileSync(psFile, '\uFEFF' + ps, 'utf8');
const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { encoding: 'utf8', timeout: 30000 });
if (r.status !== 0) { console.error('降采样失败: ' + (r.stderr || '').slice(0, 300)); process.exit(1); }

// 3) 打包 ICO：PNG 压缩条目（Vista+ 原生支持）
const pngs = SIZES.map((s) => ({ size: s, data: fs.readFileSync(path.join(OUT, `icon-${s}.png`)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = 6 + 16 * pngs.length;
const dir = [];
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(p.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.data.length;
  dir.push(e);
}
const ico = Buffer.concat([header, ...dir, ...pngs.map((p) => p.data)]);
fs.writeFileSync(path.join(OUT, 'favicon.ico'), ico);
fs.copyFileSync(big, path.join(OUT, 'icon.png'));
console.log(`favicon.ico -> ${ico.length}B（${SIZES.join('/')}）`);
for (const p of pngs) console.log(`  ${p.size}px ${p.data.length}B`);