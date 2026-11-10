// Gera build/icon.png (512x512) sem dependências — mesmo desenho do src/logo.svg
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 512;
const px = Buffer.alloc(S * S * 4);
const k = S / 64; // o SVG usa viewBox 64

const clamp = (v) => Math.max(0, Math.min(1, v));
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(x, y, ax, ay, bx, by) {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}
function blend(i, r, g, b, a) {
  const ia = 1 - a;
  px[i] = px[i] * ia + r * a; px[i + 1] = px[i + 1] * ia + g * a; px[i + 2] = px[i + 2] * ia + b * a;
  px[i + 3] = Math.min(255, px[i + 3] * ia + 255 * a);
}
const cov = (d) => clamp(0.5 - d); // anti-aliasing

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const u = (x + 0.5) / k, v = (y + 0.5) / k; // coords no espaço 64
    // fundo com gradiente
    const bg = cov(sdRoundRect(u, v, 32, 32, 32, 32, 16) * k);
    if (bg > 0) {
      const t = clamp((u + v) / 128);
      blend(i, 0x8b + (0xec - 0x8b) * t, 0x5c + (0x48 - 0x5c) * t, 0xf6 + (0x99 - 0xf6) * t, bg);
    }
    // monitor (contorno)
    const mon = Math.abs(sdRoundRect(u, v, 32, 29.5, 19, 12.5, 5)) - 2.25;
    blend(i, 255, 255, 255, cov(mon * k) * bg);
    // pé
    const st = Math.min(sdSegment(u, v, 25, 49, 39, 49), sdSegment(u, v, 32, 42, 32, 49)) - 2.25;
    blend(i, 255, 255, 255, cov(st * k) * bg);
    // câmera
    blend(i, 255, 255, 255, cov((Math.hypot(u - 46, v - 18) - 7.5) * k));
    blend(i, 0xc0, 0x26, 0xd3, cov((Math.hypot(u - 46, v - 18) - 3.5) * k));
  }
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('ícone gerado:', out, png.length, 'bytes');
