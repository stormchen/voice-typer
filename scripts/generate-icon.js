// 產生 assets/icon.png（512x512 應用程式圖示）
// 純 Node 實作（zlib + 手寫 PNG 編碼），無需任何外部依賴
// 執行：node scripts/generate-icon.js（npm run build 前會自動執行）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const OUT = path.join(__dirname, '../assets/icon.png');

// ===== 顏色 =====
const BG = [30, 30, 46, 255];      // #1e1e2e
const FG = [137, 180, 250, 255];   // #89b4fa

// ===== 幾何判定（座標系 512x512）=====
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  // 最近的「圓角圓心矩形」內點：中段區域距離為 0，角落區域為到角圓心的距離
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function distToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx, py = ay + t * dy;
  return Math.hypot(x - px, y - py);
}

function samplePixel(x, y) {
  // 背景：圓角方形
  if (!inRoundedRect(x, y, 16, 16, 496, 496, 100)) return [0, 0, 0, 0];

  // 麥克風膠囊：垂直線段 (256,170)-(256,240) 半徑 62
  if (distToSegment(x, y, 256, 170, 256, 240) <= 62) return FG;

  // U 型支架：以 (256,268) 為圓心的下半環，外徑 108 內徑 84
  const d = Math.hypot(x - 256, y - 268);
  if (d >= 84 && d <= 108 && y >= 268) return FG;

  // 直立支桿
  if (Math.abs(x - 256) <= 11 && y >= 376 && y <= 414) return FG;

  // 底座
  if (distToSegment(x, y, 208, 424, 304, 424) <= 12) return FG;

  return BG;
}

// 2x2 超取樣抗鋸齒
function renderPixel(px, py) {
  let r = 0, g = 0, b = 0, a = 0;
  for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const c = samplePixel(px + ox, py + oy);
    r += c[0]; g += c[1]; b += c[2]; a += c[3];
  }
  return [r / 4, g / 4, b / 4, a / 4].map(Math.round);
}

// ===== PNG 編碼 =====
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // 每列前綴 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ===== 主流程 =====
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b, a] = renderPixel(x, y);
    const i = (y * SIZE + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(pixels, SIZE));
console.log('已產生', OUT);
