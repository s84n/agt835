import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, meshHeightAt, villageMask } from './terrain.js';
import { seeded, noise2 } from './noise.js';
import { shared, decidGeo } from './vegetation.js';

// Albdorf im Tal: verputzte Wohnhäuser mit Fensterläden, Fachwerkhäuser, Scheunen mit Holzschalung,
// Ziegeldächer mit Überstand und Kamin, Kirche mit Chor und Spitzhelm, Dorfstraße und Gartenbäume.
// Alles instanziert (je Haustyp eine Handvoll Draw Calls). Abends gehen die Fenster Haus für Haus an.

const PX = 100; // Texturauflösung: Pixel pro Meter
export const VILLAGE_ROAD = (x) => -283 + 9 * Math.sin(x / 70) + 4 * Math.sin(x / 23 + 1);

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function tex(c, { repeat = true, clampY = true, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = clampY ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function speckle(g, w, h, rnd, base, amt = 18, n = 2600) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const l = (rnd() - 0.5) * amt;
    g.fillStyle = `rgba(${l > 0 ? 255 : 0},${l > 0 ? 255 : 0},${l > 0 ? 255 : 0},${Math.abs(l) / 255})`;
    g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3);
  }
}

// ---------- Fassaden ----------
// Ein Modul = 2,5 m breit, 5,6 m hoch (zwei Geschosse). y wächst im Canvas nach unten.
const MOD_W = 2.5, MOD_H = 5.6;
function facade(kind, seed) {
  const W = MOD_W * PX, H = MOD_H * PX;
  const rnd = seeded(seed);
  const [c, g] = canvas(W, H);
  const [m, gm] = canvas(W, H); // Leuchtmaske für die Fenster
  gm.fillStyle = '#000'; gm.fillRect(0, 0, W, H);
  const Y = (y) => H - y * PX; // Meter über Boden → Canvas-y
  if (kind === 'barn') {
    // senkrechte Bretter, Steinsockel
    g.fillStyle = '#6e5038'; g.fillRect(0, 0, W, H);
    for (let x = 0; x < W; x += 18) {
      const l = (rnd() - 0.5) * 30;
      g.fillStyle = `rgb(${110 + l | 0},${80 + l * 0.8 | 0},${56 + l * 0.6 | 0})`;
      g.fillRect(x + 1, 0, 16, H);
      g.fillStyle = 'rgba(30,20,12,0.6)'; g.fillRect(x, 0, 2, H);
    }
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(20,12,6,${rnd() * 0.25})`; g.fillRect(rnd() * W, rnd() * H, 1, 4 + rnd() * 20); }
    // Lüftungsluke oben
    g.fillStyle = '#2a1e14'; g.fillRect(W / 2 - 22, Y(4.6), 44, 30);
  } else {
    speckle(g, W, H, rnd, kind === 'fachwerk' ? '#efe6d2' : '#f1ece2');
    // leichte Verwitterung unten
    const grd = g.createLinearGradient(0, Y(1.4), 0, H);
    grd.addColorStop(0, 'rgba(120,110,90,0)'); grd.addColorStop(1, 'rgba(120,110,90,0.25)');
    g.fillStyle = grd; g.fillRect(0, Y(1.4), W, 1.4 * PX);
  }
  // Steinsockel
  const plinth = kind === 'barn' ? 0.6 : 0.45;
  g.fillStyle = '#a19c90'; g.fillRect(0, Y(plinth), W, plinth * PX);
  for (let y = 0; y < plinth; y += 0.2) for (let x = (y * 10) % 0.4; x < MOD_W; x += 0.4) {
    g.strokeStyle = 'rgba(60,58,52,0.5)'; g.lineWidth = 1.5; g.strokeRect(x * PX, Y(y + 0.2), 0.4 * PX, 0.2 * PX);
  }

  if (kind !== 'barn') {
    const shutter = kind === 'fachwerk' ? null : ['#3f6b48', '#5b7a52', '#7a5a38', '#4f6a7a'][seed % 4];
    const ww = kind === 'fachwerk' ? 0.85 : 1.0, wh = kind === 'fachwerk' ? 1.15 : 1.3;
    for (const sill of [0.95, 3.75]) {
      const x0 = (MOD_W - ww) / 2 * PX, y0 = Y(sill + wh), w = ww * PX, h = wh * PX;
      if (shutter) {
        for (const sx of [x0 - 0.46 * PX, x0 + w + 0.02 * PX]) {
          g.fillStyle = shutter; g.fillRect(sx, y0, 0.44 * PX, h);
          g.fillStyle = 'rgba(0,0,0,0.22)';
          for (let k = 6; k < h; k += 7) g.fillRect(sx + 3, y0 + k, 0.44 * PX - 6, 2);
        }
      }
      g.fillStyle = '#f8f6f0'; g.fillRect(x0 - 6, y0 - 6, w + 12, h + 12); // Rahmen
      const glass = g.createLinearGradient(x0, y0, x0 + w, y0 + h);
      glass.addColorStop(0, '#5d6b78'); glass.addColorStop(0.5, '#27313b'); glass.addColorStop(1, '#3a4652');
      g.fillStyle = glass; g.fillRect(x0, y0, w, h);
      // Gardinen und Sprossen
      g.fillStyle = 'rgba(235,230,220,0.35)'; g.fillRect(x0, y0, w, h * 0.22);
      g.fillStyle = '#f8f6f0'; g.fillRect(x0 + w / 2 - 3, y0, 6, h); g.fillRect(x0, y0 + h * 0.4 - 3, w, 6);
      g.fillStyle = '#cfc8b8'; g.fillRect(x0 - 10, y0 + h + 4, w + 20, 9); // Fensterbank
      // Leuchtmaske: Glasflächen, Gardine etwas heller
      gm.fillStyle = '#fff'; gm.fillRect(x0 + 2, y0 + 2, w - 4, h - 4);
      gm.fillStyle = '#000'; gm.fillRect(x0 + w / 2 - 3, y0, 6, h); gm.fillRect(x0, y0 + h * 0.4 - 3, w, 6);
    }
  }
  if (kind === 'fachwerk') {
    // dunkle Balken: Schwelle, Rähm, Ständer und Streben
    g.fillStyle = '#4a3424';
    const beam = (x1, y1, x2, y2, wdt = 16) => {
      g.save(); g.strokeStyle = '#4a3424'; g.lineWidth = wdt; g.lineCap = 'square';
      g.beginPath(); g.moveTo(x1 * PX, Y(y1)); g.lineTo(x2 * PX, Y(y2)); g.stroke(); g.restore();
    };
    for (const y of [0.55, 2.75, 2.95, 5.5]) beam(0, y, MOD_W, y, 18);
    for (const x of [0, MOD_W]) beam(x, 0.5, x, 5.6, 18);
    for (const [y0, y1] of [[0.55, 2.75], [2.95, 5.5]]) {
      beam(0.1, y0, 0.62, y1); beam(MOD_W - 0.1, y0, MOD_W - 0.62, y1);
    }
    // Riegel unter und über den Fenstern
    for (const y of [0.8, 2.25, 3.6, 5.0]) beam(0.65, y, MOD_W - 0.65, y, 12);
  }
  return { map: tex(c), emissive: kind === 'barn' ? null : tex(m, { srgb: true }) };
}

function plainTexture(kind, seed) {
  const rnd = seeded(seed);
  const [c, g] = canvas(256, 256);
  if (kind === 'barn') {
    g.fillStyle = '#6e5038'; g.fillRect(0, 0, 256, 256);
    for (let x = 0; x < 256; x += 18) {
      const l = (rnd() - 0.5) * 30;
      g.fillStyle = `rgb(${110 + l | 0},${80 + l * 0.8 | 0},${56 + l * 0.6 | 0})`; g.fillRect(x + 1, 0, 16, 256);
    }
  } else {
    speckle(g, 256, 256, rnd, kind === 'fachwerk' ? '#efe6d2' : '#f1ece2', 18, 700);
    if (kind === 'fachwerk') { g.fillStyle = '#4a3424'; g.fillRect(0, 120, 256, 14); g.fillRect(120, 0, 14, 256); }
  }
  const t = tex(c, { clampY: false });
  return t;
}

function roofTexture(seed) {
  // Biberschwanz-Ziegel: versetzte Reihen mit runden Enden, leicht fleckig
  const rnd = seeded(seed);
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#7d3a28'; g.fillRect(0, 0, 256, 256);
  const rowH = 16, tw = 18;
  for (let r = 0; r < 256 / rowH + 1; r++) {
    const off = (r % 2) * tw / 2;
    for (let x = -tw; x < 256 + tw; x += tw) {
      const l = (rnd() - 0.5) * 40 + (noise2(x / 60, r / 4) * 25);
      g.fillStyle = `rgb(${158 + l | 0},${74 + l * 0.6 | 0},${50 + l * 0.4 | 0})`;
      g.beginPath();
      const x0 = x + off + 1, y0 = r * rowH;
      g.moveTo(x0, y0); g.lineTo(x0 + tw - 2, y0); g.lineTo(x0 + tw - 2, y0 + rowH + 4);
      g.quadraticCurveTo(x0 + (tw - 2) / 2, y0 + rowH + 10, x0, y0 + rowH + 4); g.closePath(); g.fill();
      g.fillStyle = 'rgba(40,15,8,0.35)'; g.fillRect(x0, y0, tw - 2, 2);
    }
  }
  // Moos und Flechten
  for (let i = 0; i < 160; i++) { g.fillStyle = `rgba(70,80,40,${rnd() * 0.25})`; g.beginPath(); g.arc(rnd() * 256, rnd() * 256, 2 + rnd() * 6, 0, 7); g.fill(); }
  return tex(c, { clampY: false });
}

// ---------- Geometrie-Helfer ----------
function side(pos, uv, center, n, width, y0, y1, uScale, vScale) {
  // Rechteck außen sichtbar (CCW); u in Modulen, v über Höhe
  const up = new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3().crossVectors(up, n).normalize();
  const bl = center.clone().addScaledVector(t, -width / 2).setY(y0), br = center.clone().addScaledVector(t, width / 2).setY(y0);
  const tr = br.clone().setY(y1), tl = bl.clone().setY(y1);
  const u1 = width / uScale;
  for (const [p, u, v] of [[bl, 0, y0], [br, u1, y0], [tr, u1, y1], [bl, 0, y0], [tr, u1, y1], [tl, 0, y1]]) {
    pos.push(p.x, p.y, p.z); uv.push(u, v / vScale);
  }
}
function gable(pos, uv, center, n, width, yEave, yRidge) {
  const up = new THREE.Vector3(0, 1, 0);
  const t = new THREE.Vector3().crossVectors(up, n).normalize();
  const bl = center.clone().addScaledVector(t, -width / 2).setY(yEave), br = center.clone().addScaledVector(t, width / 2).setY(yEave);
  const top = center.clone().setY(yRidge);
  for (const [p, u] of [[bl, 0], [br, width / 3], [top, width / 6]]) { pos.push(p.x, p.y, p.z); uv.push(u, p.y / 3); }
}
function geo(pos, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
function colored(g, color) {
  const q = g.index ? g.toNonIndexed() : g;
  if (q.attributes.uv) q.deleteAttribute('uv');
  const c = new THREE.Color(color), n = q.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  q.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return q;
}

// Haus mit Satteldach. First entlang x. Liefert Wände, Giebel, Dach (zwei Platten) und Details.
function houseParts({ L, D, Hw, pitch, ov = 0.5, door = true, barn = false, chimney = true }) {
  const D2 = D / 2, H = D2 * Math.tan(pitch);
  const wp = [], wu = [], gp = [], gu = [];
  const sink = 2.5; // Wände reichen unter die Erde (Hanglage)
  const fit = (len) => len / Math.max(1, Math.round(len / MOD_W)); // ganze Module je Wand
  side(wp, wu, new THREE.Vector3(0, 0, D2), new THREE.Vector3(0, 0, 1), L, -sink, Hw, fit(L), MOD_H);
  side(wp, wu, new THREE.Vector3(0, 0, -D2), new THREE.Vector3(0, 0, -1), L, -sink, Hw, fit(L), MOD_H);
  side(wp, wu, new THREE.Vector3(L / 2, 0, 0), new THREE.Vector3(1, 0, 0), D, -sink, Hw, fit(D), MOD_H);
  side(wp, wu, new THREE.Vector3(-L / 2, 0, 0), new THREE.Vector3(-1, 0, 0), D, -sink, Hw, fit(D), MOD_H);
  gable(gp, gu, new THREE.Vector3(L / 2, 0, 0), new THREE.Vector3(1, 0, 0), D, Hw, Hw + H);
  gable(gp, gu, new THREE.Vector3(-L / 2, 0, 0), new THREE.Vector3(-1, 0, 0), D, Hw, Hw + H);
  // Dachplatten mit Überstand an Traufe und Ortgang
  const Sl = D2 / Math.cos(pitch) + ov, Lr = L + 2 * ov, th = 0.16;
  const roofs = [];
  for (const s of [-1, 1]) {
    const b = new THREE.BoxGeometry(Lr, th, Sl);
    b.rotateX(s * pitch);
    const c = new THREE.Vector3(0, Hw + H - Math.sin(pitch) * Sl / 2, s * Math.cos(pitch) * Sl / 2);
    c.add(new THREE.Vector3(0, Math.cos(pitch), s * Math.sin(pitch)).multiplyScalar(th / 2));
    b.translate(c.x, c.y, c.z);
    roofs.push(b);
  }
  const roof = mergeGeometries(roofs);
  // Details: Kamin, Haustür mit Stufe, Firstziegel, Dachrinne
  const det = [];
  if (chimney) {
    const cz = D2 * 0.35, yRoof = Hw + H * (1 - cz / D2);
    det.push(colored(new THREE.BoxGeometry(0.6, 1.7, 0.6).translate(L * 0.22, yRoof + 0.45, cz), '#8a4a38'));
    det.push(colored(new THREE.BoxGeometry(0.75, 0.12, 0.75).translate(L * 0.22, yRoof + 1.33, cz), '#6f6a62'));
  }
  det.push(colored(new THREE.BoxGeometry(Lr, 0.22, 0.3).translate(0, Hw + H + 0.12, 0), '#6d3426')); // First
  for (const s of [-1, 1]) {
    const ez = s * (D2 + ov * Math.cos(pitch)), ey = Hw - ov * Math.sin(pitch) - 0.05;
    det.push(colored(new THREE.CylinderGeometry(0.07, 0.07, Lr, 6).rotateZ(Math.PI / 2).translate(0, ey, ez), '#8c8f8e'));
  }
  if (door && !barn) {
    const dx = fit(L) * (Math.round(L / MOD_W / 2) - 0.5) - L / 2;
    det.push(colored(new THREE.BoxGeometry(1.25, 2.3, 0.08).translate(dx, 1.15 + 0.2, D2 + 0.03), '#e9e3d6'));
    det.push(colored(new THREE.BoxGeometry(1.05, 2.15, 0.1).translate(dx, 1.08 + 0.2, D2 + 0.05), '#5a3b26'));
    det.push(colored(new THREE.BoxGeometry(1.7, 0.2, 0.7).translate(dx, 0.1, D2 + 0.35), '#9d988c'));
    det.push(colored(new THREE.BoxGeometry(1.7, 0.2, 0.45).translate(dx, 0.3, D2 + 0.22), '#9d988c'));
  }
  if (barn) {
    // großes Scheunentor mit Andreaskreuz, kleine Tür daneben
    det.push(colored(new THREE.BoxGeometry(3.8, 3.9, 0.1).translate(0, 1.95, D2 + 0.05), '#5b3f29'));
    for (const s of [-1, 1]) {
      const b = new THREE.BoxGeometry(0.16, 5.2, 0.06); b.rotateZ(s * 0.77); b.translate(-0.95, 1.95, D2 + 0.12);
      det.push(colored(b, '#7a5a3c'));
      const b2 = b.clone(); b2.translate(1.9, 0, 0); det.push(colored(b2, '#7a5a3c'));
    }
    det.push(colored(new THREE.BoxGeometry(0.1, 3.9, 0.12).translate(0, 1.95, D2 + 0.11), '#3c2a1b'));
  }
  return { walls: geo(wp, wu), gables: geo(gp, gu), roof, details: mergeGeometries(det), roofRepeat: [Lr / 2.2, Sl / 2.2] };
}

// Leuchtende Fenster: Emission je Haus über einen Schwellwert (aThresh) und den Abendwert uNight
function litMaterial(map, emissiveMap) {
  const m = new THREE.MeshLambertMaterial({ map, emissive: emissiveMap ? new THREE.Color('#ffc477') : new THREE.Color(0), emissiveMap, emissiveIntensity: emissiveMap ? 2.4 : 0 });
  if (emissiveMap) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uNight = shared.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uNight; attribute float aThresh; varying float vLit;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = step(aThresh, uNight);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vLit;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vLit;');
    };
    m.customProgramCacheKey = () => 'village-lit';
  }
  return m;
}

const TYPES = {
  haus: { L: 10, D: 8.5, Hw: 5.6, pitch: 0.75, kind: 'putz' },
  fachwerk: { L: 9, D: 8, Hw: 5.6, pitch: 0.88, kind: 'fachwerk' },
  scheune: { L: 15, D: 10, Hw: 4.8, pitch: 0.72, kind: 'barn', barn: true, chimney: false },
};

function buildType(name, list, rnd) {
  const T = TYPES[name];
  const parts = houseParts(T);
  const f = facade(T.kind, name.length * 7 + 3);
  const plain = plainTexture(T.kind, 11);
  const roofMap = roofTexture(name.length * 13);
  roofMap.repeat.set(...parts.roofRepeat);
  const wallMat = litMaterial(f.map, f.emissive);
  const gableMat = new THREE.MeshLambertMaterial({ map: plain });
  const roofMat = new THREE.MeshLambertMaterial({ map: roofMap });
  const detMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const n = list.length;
  const thr = new Float32Array(n);
  for (let i = 0; i < n; i++) thr[i] = T.barn ? 2 : 0.2 + rnd() * 0.75;
  parts.walls.setAttribute('aThresh', new THREE.InstancedBufferAttribute(thr, 1));
  const meshes = [
    new THREE.InstancedMesh(parts.walls, wallMat, n),
    new THREE.InstancedMesh(parts.gables, gableMat, n),
    new THREE.InstancedMesh(parts.roof, roofMat, n),
    new THREE.InstancedMesh(parts.details, detMat, n),
  ];
  const wallTints = ['#ffffff', '#fff6e2', '#fbefd6', '#f6e6e0', '#eef0ea', '#fff2cf'].map((c) => new THREE.Color(c));
  const roofTints = ['#ffffff', '#e6d0c4', '#c9b3ab', '#9e958f', '#f0d8c0'].map((c) => new THREE.Color(c));
  list.forEach((h, i) => {
    for (const m of meshes) m.setMatrixAt(i, h.m);
    if (!T.barn) { const t = wallTints[Math.floor(rnd() * wallTints.length)]; meshes[0].setColorAt(i, t); meshes[1].setColorAt(i, t); }
    meshes[2].setColorAt(i, roofTints[Math.floor(rnd() * roofTints.length)]);
  });
  for (const m of meshes) { m.castShadow = false; m.receiveShadow = true; m.computeBoundingSphere(); }
  return meshes;
}

// ---------- Kirche ----------
function churchFacade() {
  const W = 3.4 * PX, H = 9 * PX;
  const rnd = seeded(41);
  const [c, g] = canvas(W, H);
  const [m, gm] = canvas(W, H);
  speckle(g, W, H, rnd, '#f6f2ea', 14, 2000);
  gm.fillStyle = '#000'; gm.fillRect(0, 0, W, H);
  g.fillStyle = '#b2ab9c'; g.fillRect(0, H - 60, W, 60);
  // hohes Rundbogenfenster
  const ww = 1.3 * PX, wh = 3.8 * PX, x0 = (W - ww) / 2, y0 = H - 3.4 * PX - wh;
  for (const [ctx, fill, pad] of [[g, '#d9d2c2', 10], [g, '#3b4654', 0], [gm, '#fff', 4]]) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x0 - pad + (pad ? 0 : 0), y0 + wh + pad);
    ctx.lineTo(x0 - pad, y0 + ww / 2);
    ctx.arc(x0 + ww / 2, y0 + ww / 2, ww / 2 + pad, Math.PI, 0);
    ctx.lineTo(x0 + ww + pad, y0 + wh + pad);
    ctx.closePath(); ctx.fill();
  }
  g.strokeStyle = 'rgba(200,190,170,0.9)'; g.lineWidth = 3;
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo(x0, y0 + ww / 2 + k * (wh - ww / 2) / 4); g.lineTo(x0 + ww, y0 + ww / 2 + k * (wh - ww / 2) / 4); g.stroke(); }
  g.beginPath(); g.moveTo(x0 + ww / 2, y0); g.lineTo(x0 + ww / 2, y0 + wh); g.stroke();
  return { map: tex(c), emissive: tex(m) };
}

function clockTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#2b3a46'; g.beginPath(); g.arc(128, 128, 124, 0, 7); g.fill();
  g.strokeStyle = '#d9b44a'; g.lineWidth = 8; g.beginPath(); g.arc(128, 128, 116, 0, 7); g.stroke();
  g.fillStyle = '#d9b44a';
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; g.fillRect(128 + Math.sin(a) * 95 - 5, 128 - Math.cos(a) * 95 - 5, 10, 10); }
  g.strokeStyle = '#d9b44a'; g.lineCap = 'round';
  g.lineWidth = 12; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + 50, 128 + 20); g.stroke();
  g.lineWidth = 8; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 - 10, 128 - 85); g.stroke();
  return tex(c, { repeat: false });
}

function createChurch(x, z, rotY) {
  const group = new THREE.Group();
  group.position.set(x, heightAt(x, z) - 0.3, z);
  group.rotation.y = rotY;
  const L = 20, D = 11, Hw = 8.5, pitch = 0.95;
  const f = churchFacade();
  const wallMat = new THREE.MeshLambertMaterial({ map: f.map, emissive: '#ffcf8a', emissiveMap: f.emissive, emissiveIntensity: 0 });
  group.userData.windowMat = wallMat;
  const wp = [], wu = [];
  const fit = (len) => len / Math.round(len / 3.4);
  side(wp, wu, new THREE.Vector3(0, 0, D / 2), new THREE.Vector3(0, 0, 1), L, -2.5, Hw, fit(L), 9);
  side(wp, wu, new THREE.Vector3(0, 0, -D / 2), new THREE.Vector3(0, 0, -1), L, -2.5, Hw, fit(L), 9);
  const plainMat = new THREE.MeshLambertMaterial({ map: plainTexture('putz', 5) });
  const gp = [], gu = [];
  side(gp, gu, new THREE.Vector3(-L / 2, 0, 0), new THREE.Vector3(-1, 0, 0), D, -2.5, Hw, 3, 3);
  side(gp, gu, new THREE.Vector3(L / 2, 0, 0), new THREE.Vector3(1, 0, 0), D, -2.5, Hw, 3, 3);
  const H = D / 2 * Math.tan(pitch);
  gable(gp, gu, new THREE.Vector3(L / 2, 0, 0), new THREE.Vector3(1, 0, 0), D, Hw, Hw + H);
  gable(gp, gu, new THREE.Vector3(-L / 2, 0, 0), new THREE.Vector3(-1, 0, 0), D, Hw, Hw + H);
  group.add(new THREE.Mesh(geo(wp, wu), wallMat), new THREE.Mesh(geo(gp, gu), plainMat));
  const parts = houseParts({ L, D, Hw, pitch, ov: 0.6, door: false, chimney: false });
  const roofMap = roofTexture(77); roofMap.repeat.set(...parts.roofRepeat);
  group.add(new THREE.Mesh(parts.roof, new THREE.MeshLambertMaterial({ map: roofMap, color: '#d9c8c0' })));
  group.add(new THREE.Mesh(parts.details, new THREE.MeshLambertMaterial({ vertexColors: true })));
  // Chor (halbrund) im Osten
  const apse = new THREE.CylinderGeometry(4.6, 4.6, Hw + 2.5, 16, 1, true, 0, Math.PI);
  apse.translate(0, (Hw - 2.5) / 2, 0); apse.rotateY(Math.PI);
  const apseMesh = new THREE.Mesh(apse, plainMat);
  apseMesh.position.x = -L / 2;
  const apseRoof = new THREE.Mesh(new THREE.ConeGeometry(5.1, 3.4, 16, 1, true, 0, Math.PI).rotateY(Math.PI), new THREE.MeshLambertMaterial({ map: roofMap, color: '#d9c8c0', side: THREE.DoubleSide }));
  apseRoof.position.set(-L / 2, Hw + 1.6, 0);
  group.add(apseMesh, apseRoof);
  // Turm im Westen mit Uhr, Schallarkaden und Spitzhelm
  const TW = 6.2, TH = 23;
  const towerMat = new THREE.MeshLambertMaterial({ map: plainTexture('putz', 9) });
  towerMat.map.repeat.set(2, 6);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(TW, TH + 2.5, TW).translate(0, (TH - 2.5) / 2, 0), towerMat);
  tower.position.x = L / 2 + TW / 2 - 0.3;
  group.add(tower);
  const trim = new THREE.MeshLambertMaterial({ color: '#bdb5a5' });
  for (const y of [9.5, 17.8, TH]) group.add(new THREE.Mesh(new THREE.BoxGeometry(TW + 0.3, 0.35, TW + 0.3).translate(tower.position.x, y, 0), trim));
  const clockMat = new THREE.MeshLambertMaterial({ map: clockTexture(), emissive: '#3a2a10', emissiveIntensity: 0.3 });
  const louverMat = new THREE.MeshLambertMaterial({ color: '#2a2622' });
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2, nx = Math.sin(a), nz = Math.cos(a);
    const clock = new THREE.Mesh(new THREE.CircleGeometry(1.25, 32), clockMat);
    clock.position.set(tower.position.x + nx * (TW / 2 + 0.03), 15.6, nz * (TW / 2 + 0.03));
    clock.rotation.y = a;
    const lou = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.4), louverMat);
    for (const o of [-1.1, 1.1]) {
      const l = lou.clone();
      l.position.set(tower.position.x + nx * (TW / 2 + 0.02) + nz * o, 20.2, nz * (TW / 2 + 0.02) - nx * o);
      l.rotation.y = a;
      group.add(l);
    }
    group.add(clock);
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(TW * 0.74, 13, 4, 1).rotateY(Math.PI / 4), new THREE.MeshLambertMaterial({ color: '#4c5856' }));
  spire.position.set(tower.position.x, TH + 6.5, 0);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), new THREE.MeshStandardMaterial({ color: '#d9b44a', metalness: 0.8, roughness: 0.3 }));
  ball.position.set(tower.position.x, TH + 13.2, 0);
  const cross = new THREE.Mesh(mergeGeometries([new THREE.BoxGeometry(0.12, 2.2, 0.12), new THREE.BoxGeometry(1.1, 0.12, 0.12).translate(0, 0.35, 0)]), ball.material);
  cross.position.set(tower.position.x, TH + 14.4, 0);
  group.add(spire, ball, cross);
  group.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; } });
  return group;
}

// ---------- Dorfstraße ----------
function createRoad() {
  const [c, g] = canvas(128, 256);
  const rnd = seeded(12);
  g.clearRect(0, 0, 128, 256);
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, 'rgba(110,105,96,0)'); grd.addColorStop(0.12, 'rgba(112,108,100,1)');
  grd.addColorStop(0.88, 'rgba(112,108,100,1)'); grd.addColorStop(1, 'rgba(110,105,96,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 1500; i++) { const l = 80 + rnd() * 80; g.fillStyle = `rgba(${l},${l},${l - 6},${rnd() * 0.4})`; g.fillRect(rnd() * 128, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2); }
  // ausgebesserte Stellen
  for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(60,58,55,0.35)'; g.fillRect(20 + rnd() * 70, rnd() * 240, 10 + rnd() * 30, 8 + rnd() * 20); }
  const t = tex(c, { clampY: false });
  const verts = [], uvs = [], idx = [];
  const W = 5.5;
  let v = 0, n = 0;
  for (let x = -480; x <= 300; x += 3) {
    const z = VILLAGE_ROAD(x), dz = VILLAGE_ROAD(x + 0.5) - VILLAGE_ROAD(x - 0.5), l = Math.hypot(1, dz);
    const px = -dz / l, pz = 1 / l;
    for (const s of [-1, 1]) {
      const vx = x + px * s * W / 2, vz = z + pz * s * W / 2;
      verts.push(vx, Math.max(heightAt(vx, vz), meshHeightAt(vx, vz)) + 0.12, vz); uvs.push(s < 0 ? 0 : 1, v);
    }
    if (n) { const b = (n - 1) * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    v += 3 / 6; n++;
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  gg.setIndex(idx); gg.computeVertexNormals();
  const mesh = new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide }));
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}

// ======================================================================
export function createVillage() {
  const rnd = seeded(555);
  const group = new THREE.Group();
  group.name = 'Dorf';
  const lots = { haus: [], fachwerk: [], scheune: [] };
  const placed = [];
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const free = (x, z, r) => placed.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
  const put = (type, x, z, rot, k = 1) => {
    const T = TYPES[type];
    const r = Math.hypot(T.L, T.D) / 2 * k;
    if (!free(x, z, r * 0.85)) return false;
    // tiefste Ecke als Basis, die Wände reichen in den Hang
    let y = Infinity;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const ox = a * T.L / 2 * k, oz = b * T.D / 2 * k;
      y = Math.min(y, heightAt(x + ox * Math.cos(rot) + oz * Math.sin(rot), z - ox * Math.sin(rot) + oz * Math.cos(rot)));
    }
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    sc.set(k, k * (0.95 + rnd() * 0.1), k);
    lots[type].push({ m: m4.compose(p.set(x, y - 0.15, z), q, sc).clone() });
    placed.push({ x, z, r });
    return true;
  };
  // Kirche in der Dorfmitte, Turm zur Straße
  const cx = -95, cz = VILLAGE_ROAD(-95) - 17;
  const church = createChurch(cx, cz, 0.08);
  group.add(church);
  placed.push({ x: cx, z: cz, r: 15 });

  // Häuserzeilen entlang der Straße: Traufseite mit Haustür zur Straße
  for (let x = -330; x < 150; x += 13 + rnd() * 5) {
    for (const s of [-1, 1]) {
      for (const row of [0, 1]) {
        const z = VILLAGE_ROAD(x) + s * (row === 0 ? 11 + rnd() * 3 : 28 + rnd() * 6);
        const mask = villageMask(x, z) * (row ? 1.1 : 1.6);
        if (rnd() > mask) continue;
        const dz = VILLAGE_ROAD(x + 1) - VILLAGE_ROAD(x - 1);
        const rot = (s > 0 ? Math.PI : 0) + Math.atan2(-dz, 2) * 0.8 + (rnd() - 0.5) * 0.12;
        const r = rnd();
        const type = row === 1 && r < 0.5 ? 'scheune' : r < 0.6 ? 'haus' : r < 0.85 ? 'fachwerk' : 'scheune';
        put(type, x + (rnd() - 0.5) * 3, z, type === 'scheune' && row === 1 ? rot + Math.PI / 2 : rot, 0.9 + rnd() * 0.2);
      }
    }
  }
  // Seitengasse nach Norden (Richtung Hang)
  for (let z = VILLAGE_ROAD(-60) + 22; z < -215; z += 14) {
    for (const s of [-1, 1]) {
      const x = -60 + s * (10 + rnd() * 3);
      if (rnd() > villageMask(x, z) * 1.4) continue;
      put(rnd() < 0.7 ? 'haus' : 'fachwerk', x, z, s > 0 ? -Math.PI / 2 : Math.PI / 2, 0.9 + rnd() * 0.2);
    }
  }
  // Aussiedlerhöfe: Wohnhaus + Scheune im Winkel
  for (let i = 0; i < 14; i++) {
    const x = (rnd() - 0.5) * 900, z = -205 - rnd() * 125, rot = rnd() * Math.PI * 2;
    if (Math.abs(x + 90) < 170 && Math.abs(z + 285) < 70) continue;
    if (put('haus', x, z, rot, 0.95)) put('scheune', x + Math.cos(rot) * 13 + Math.sin(rot) * 8, z - Math.sin(rot) * 13 + Math.cos(rot) * 8, rot + Math.PI / 2, 1);
  }

  for (const type of Object.keys(lots)) if (lots[type].length) group.add(...buildType(type, lots[type], rnd));

  // Gartenbäume zwischen den Häusern
  const trees = [];
  const tg = decidGeo(seeded(3)), tg2 = decidGeo(seeded(4));
  for (let k = 0; k < 900 && trees.length < 110; k++) {
    const x = -340 + rnd() * 480, z = -400 + rnd() * 230;
    if (rnd() > villageMask(x, z) * 1.3 + 0.03) continue;
    if (Math.abs(z - VILLAGE_ROAD(x)) < 6) continue;
    if (!free(x, z, 2.5)) continue;
    const s = 2.6 + rnd() * 1.6; // Obst- und Gartenbäume, 6–10 m hoch
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    trees.push({ m: m4.compose(p.set(x, heightAt(x, z) - 0.4, z), q, sc.set(s, s * (0.9 + rnd() * 0.3), s)).clone(), c: new THREE.Color().setHSL(0.24 + rnd() * 0.06, 0.4, 0.3 + rnd() * 0.1) });
  }
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  [tg, tg2].forEach((gg, gi) => {
    const sub = trees.filter((_, i) => i % 2 === gi);
    const im = new THREE.InstancedMesh(gg, treeMat, sub.length);
    sub.forEach((t, i) => { im.setMatrixAt(i, t.m); im.setColorAt(i, t.c); });
    im.receiveShadow = true; im.computeBoundingSphere();
    group.add(im);
  });

  group.add(createRoad());
  return {
    group,
    update(night) { church.userData.windowMat.emissiveIntensity = Math.max(0, night - 0.3) * 1.6; },
  };
}
