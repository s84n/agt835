import * as THREE from 'three';
import { seeded } from './noise.js';

// Prozedurale Canvas-Texturen (keine externen Bilddateien nötig).

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}

// Zeichnet kachelbar: wiederholt Formen über die Kanten
function wrapped(size, x, y, r, fn) {
  for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
    const px = x + ox, py = y + oy;
    if (px + r < 0 || px - r > size || py + r < 0 || py - r > size) continue;
    fn(px, py);
  }
}

// Höhenbild -> Normal-Map (Sobel)
export function heightToNormal(src, strength = 2) {
  const w = src.width, h = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, w, h).data;
  const [c, g] = canvas(w, h);
  const out = g.createImageData(w, h);
  const H = (x, y) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = -dy * strength, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4;
    out.data[i] = (nx * 0.5 + 0.5) * 255; out.data[i + 1] = (ny * 0.5 + 0.5) * 255; out.data[i + 2] = (nz * 0.5 + 0.5) * 255; out.data[i + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c;
}

function toTex(c, srgb, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Bodentextur: Grasnarbe mit Halmen, Klee, Erdflecken – kachelbar, ~3 m pro Kachel
export function groundTextures() {
  const S = 512;
  const rnd = seeded(31);
  const [col, g] = canvas(S);
  const [hgt, hg] = canvas(S);
  g.fillStyle = 'rgb(200,202,192)'; g.fillRect(0, 0, S, S);
  hg.fillStyle = 'rgb(110,110,110)'; hg.fillRect(0, 0, S, S);

  // Erdflecken (dunkler, tiefer)
  for (let i = 0; i < 26; i++) {
    const x = rnd() * S, y = rnd() * S, r = 10 + rnd() * 34;
    wrapped(S, x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, 'rgba(135,115,90,0.32)'); gr.addColorStop(1, 'rgba(135,115,90,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(px, py, r, 0, 7); g.fill();
      const hgr = hg.createRadialGradient(px, py, 0, px, py, r);
      hgr.addColorStop(0, 'rgba(40,40,40,0.6)'); hgr.addColorStop(1, 'rgba(40,40,40,0)');
      hg.fillStyle = hgr; hg.beginPath(); hg.arc(px, py, r, 0, 7); hg.fill();
    });
  }
  // Halme (von oben gesehen)
  for (let i = 0; i < 14000; i++) {
    const x = rnd() * S, y = rnd() * S;
    const a = rnd() * Math.PI * 2, len = 5 + rnd() * 14;
    const l = 165 + rnd() * 80;
    const hue = rnd();
    const r = l * (0.94 + hue * 0.08), gg = l, b = l * (0.84 + hue * 0.08);
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
    const w = 0.8 + rnd() * 1.4;
    wrapped(S, x, y, len, (px, py) => {
      g.strokeStyle = `rgba(${r | 0},${gg | 0},${b | 0},0.85)`; g.lineWidth = w;
      g.beginPath(); g.moveTo(px, py); g.quadraticCurveTo(px + dx * 0.6 + dy * 0.15, py + dy * 0.6 - dx * 0.15, px + dx, py + dy); g.stroke();
      const hv = 140 + rnd() * 110;
      hg.strokeStyle = `rgba(${hv | 0},${hv | 0},${hv | 0},0.9)`; hg.lineWidth = w;
      hg.beginPath(); hg.moveTo(px, py); hg.lineTo(px + dx, py + dy); hg.stroke();
    });
  }
  // Kleeblätter & kleine Wildkräuter
  for (let i = 0; i < 420; i++) {
    const x = rnd() * S, y = rnd() * S, s = 2 + rnd() * 3;
    const l = 150 + rnd() * 50;
    wrapped(S, x, y, s * 2, (px, py) => {
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + rnd();
        g.fillStyle = `rgba(${l * 0.9 | 0},${l | 0},${l * 0.8 | 0},0.7)`;
        g.beginPath(); g.arc(px + Math.cos(a) * s, py + Math.sin(a) * s, s, 0, 7); g.fill();
        hg.fillStyle = 'rgba(230,230,230,0.8)';
        hg.beginPath(); hg.arc(px + Math.cos(a) * s, py + Math.sin(a) * s, s, 0, 7); hg.fill();
      }
    });
  }
  // Steinchen
  for (let i = 0; i < 160; i++) {
    const x = rnd() * S, y = rnd() * S, s = 0.8 + rnd() * 2.2;
    const l = 170 + rnd() * 60;
    wrapped(S, x, y, s, (px, py) => {
      g.fillStyle = `rgba(${l | 0},${l * 0.95 | 0},${l * 0.85 | 0},0.9)`; g.beginPath(); g.arc(px, py, s, 0, 7); g.fill();
      hg.fillStyle = 'rgba(255,255,255,1)'; hg.beginPath(); hg.arc(px, py, s, 0, 7); hg.fill();
    });
  }
  const map = toTex(col, true);
  const normalMap = toTex(heightToNormal(hgt, 1.7), false);
  return { map, normalMap };
}

// Blattbüschel mit Alpha für die Obstbäume
export function leafTexture() {
  const S = 256;
  const rnd = seeded(8);
  const [c, g] = canvas(S);
  g.clearRect(0, 0, S, S);
  for (let i = 0; i < 34; i++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * S * 0.33;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const rot = rnd() * Math.PI * 2, L = 22 + rnd() * 16, W = L * (0.42 + rnd() * 0.12);
    const l = 150 + rnd() * 105;
    g.save(); g.translate(x, y); g.rotate(rot);
    g.fillStyle = `rgb(${l * 0.82 | 0},${l | 0},${l * 0.6 | 0})`;
    g.beginPath(); g.moveTo(-L / 2, 0);
    g.quadraticCurveTo(0, -W, L / 2, 0); g.quadraticCurveTo(0, W, -L / 2, 0); g.fill();
    g.strokeStyle = `rgba(0,0,0,0.25)`; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(-L / 2, 0); g.lineTo(L / 2, 0); g.stroke();
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath(); g.moveTo(-L / 2, 0); g.quadraticCurveTo(0, W, L / 2, 0); g.fill();
    g.restore();
  }
  const t = toTex(c, true, false);
  return t;
}

// Stirnseite eines Holzscheits: Jahresringe + Risse
export function logEndTexture() {
  const S = 128;
  const rnd = seeded(12);
  const [c, g] = canvas(S);
  g.fillStyle = '#7a5a3a'; g.fillRect(0, 0, S, S);
  const cx = S / 2 + (rnd() - 0.5) * 10, cy = S / 2 + (rnd() - 0.5) * 10;
  g.fillStyle = '#d9bb8c'; g.beginPath(); g.arc(S / 2, S / 2, S * 0.46, 0, 7); g.fill();
  for (let r = 4; r < S * 0.44; r += 2.5 + rnd() * 2.5) {
    g.strokeStyle = `rgba(150,105,60,${0.25 + rnd() * 0.35})`; g.lineWidth = 0.8 + rnd();
    g.beginPath(); g.ellipse(cx, cy, r, r * (0.92 + rnd() * 0.1), rnd(), 0, 7); g.stroke();
  }
  g.strokeStyle = 'rgba(70,45,25,0.6)'; g.lineWidth = 1.5;
  for (let i = 0; i < 3; i++) { const a = rnd() * 7; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * S * 0.4, cy + Math.sin(a) * S * 0.4); g.stroke(); }
  return toTex(c, true, false);
}

// Rinde für die Seiten der Holzscheite
export function barkTexture() {
  const S = 128;
  const rnd = seeded(13);
  const [c, g] = canvas(S);
  g.fillStyle = '#6b5340'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S, l = 60 + rnd() * 70;
    g.strokeStyle = `rgba(${l + 30 | 0},${l + 10 | 0},${l - 10 | 0},0.7)`; g.lineWidth = 1 + rnd() * 2.5;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 4, y + 6 + rnd() * 18); g.stroke();
  }
  return toTex(c, true);
}
