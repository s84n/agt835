import * as THREE from 'three';
import { fbm, noise2, smoothstep, lerp, clamp, hash2, seeded } from './noise.js';
import { groundTextures } from './textures.js';

// Landschaft nach den Fotos: Streuobstwiese am Hang (um den Ursprung), das Tal mit Dorf
// Richtung -Z und gegenüber der bewaldete Albtrauf mit Kegelberg und Felsnase.

// Weiher am Osthang der Obstwiese (Ziel des abzweigenden Feldwegs)
export const POND = { x: 135, z: 72, rx: 24, rz: 16, level: 2.55 };
// normierter Abstand zum Ufer: < 1 Wasser, 1 Uferlinie (mit unregelmäßiger Kante)
export function pondE(x, z) {
  const dx = (x - POND.x) / POND.rx, dz = (z - POND.z) / POND.rz;
  return Math.hypot(dx, dz) * (1 + 0.1 * noise2(x / 14 + 5.1, z / 14 - 2.3) + 0.04 * noise2(x / 5, z / 5));
}

// Aussichtsbank am Hang über dem Dorf (kleine ebene Terrasse für Bank und Traktor)
export const VIEW = { x: -64, z: -145, park: { x: -53, z: -137 } };

const VIEW_H = baseHeight(VIEW.x, VIEW.z);
const H0 = rawHeight(0, 0);

function rawHeight(x, z) {
  // kleines ebenes Plätzchen nur unter der Bank: davor fällt der Hang frei ab, der Blick bleibt offen
  const vd = Math.hypot(x - VIEW.x, z - VIEW.z);
  const h = baseHeight(x, z);
  return vd < 6 ? lerp(h, VIEW_H, smoothstep(6, 2.5, vd)) : h;
}

function baseHeight(x, z) {
  // Wiese: sanft ansteigend nach +Z, weiche Mulden
  let h = 0.045 * z + 1.7 * fbm(x / 75, z / 75, 3) + 0.35 * noise2(x / 17, z / 17);
  // Tal
  h -= 52 * smoothstep(-95, -290, z);
  // Albtrauf gegenüber
  const ridge = smoothstep(-330, -560, z);
  h += ridge * (128 + 38 * fbm(x / 280, 3.7, 3));
  h += 20 * fbm(x / 95, z / 95, 4) * smoothstep(-300, -460, z);
  // Kegelberg (rechts, wie auf Foto 3) und Nebenkuppe
  const d1 = Math.hypot(x - 260, z + 470);
  h += 120 * Math.exp(-((d1 / 150) ** 2));
  const d2 = Math.hypot(x + 470, z + 430);
  h += 70 * Math.exp(-((d2 / 170) ** 2));
  // Felsnase am Trauf
  const d3 = Math.hypot(x + 130, z + 545);
  h += 26 * Math.exp(-((d3 / 45) ** 2));
  // Rücken hinter der Wiese und seitliche Rahmung
  h += 38 * smoothstep(90, 430, z) + 6 * fbm(x / 60, z / 60, 2) * smoothstep(80, 200, z);
  h += 26 * smoothstep(260, 650, Math.abs(x)) * (1 - 0.6 * smoothstep(-150, -300, z));
  // Weiher: Umgebung sanft einebnen (Parkplatz am Steg), dann die Mulde ausheben
  const e = pondE(x, z);
  if (e < 2.8) {
    const bank = POND.level + 0.28 + Math.max(0, e - 1.05) * 0.55;
    h = lerp(h, bank, smoothstep(2.8, 1.3, e));
    if (e < 1.15) h = lerp(h, POND.level - 1.7, smoothstep(1.12, 0.42, e));
  }
  return h;
}

export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const flat = 1 - smoothstep(5, 11, r); // ebene Bühne für den Showroom
  return lerp(rawHeight(x, z), H0, flat);
}

export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.5;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

// Feldweg (zweispurig) quer durch die Wiese
export const PATH_Z = [-115, 125];
export function pathX(z) { return 15 + 9 * Math.sin(z / 34) + 3 * Math.sin(z / 13 + 1.3); }

// Abzweige vom Hauptweg: Bézierkurven als Polylinien (~1 m)
export const POND_PARK = { x: 101, z: 71 };
function branch(P) {
  const pts = [];
  const N = 110;
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    pts.push([b[0] * P[0][0] + b[1] * P[1][0] + b[2] * P[2][0] + b[3] * P[3][0], b[0] * P[0][1] + b[1] * P[1][1] + b[2] * P[2][1] + b[3] * P[3][1]]);
  }
  let x0 = 1e9, x1 = -1e9, zz0 = 1e9, zz1 = -1e9;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); zz0 = Math.min(zz0, z); zz1 = Math.max(zz1, z); }
  return { pts, box: [x0 - 8, x1 + 8, zz0 - 8, zz1 + 8] };
}
export const BRANCHES = [
  branch([[pathX(50), 50], [48, 58], [74, 80], [POND_PARK.x, POND_PARK.z]]),           // zum Weiher
  branch([[pathX(-98), -98], [0, -118], [-30, -134], [VIEW.park.x - 4, VIEW.park.z]]), // zur Aussichtsbank
];
export const BRANCH = BRANCHES[0];
function branchDist(x, z) {
  let best = 1e9;
  for (const B of BRANCHES) {
    const [x0, x1, z0, z1] = B.box;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    best = Math.min(best, polyDist(B.pts, x, z));
  }
  return best > 1e8 ? 999 : best;
}
function polyDist(P, x, z) {
  let best = 1e9;
  for (let i = 0; i < P.length - 1; i++) {
    const ax = P[i][0], az = P[i][1], bx = P[i + 1][0] - ax, bz = P[i + 1][1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz)));
    const dx = x - ax - bx * t, dz = z - az - bz * t;
    const d = dx * dx + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
export function pathDist(x, z) {
  const main = z < PATH_Z[0] - 4 || z > PATH_Z[1] + 4 ? 999 : Math.abs(x - pathX(z));
  return Math.min(main, branchDist(x, z));
}
// Steht der Punkt im Wasser? (für die Fahrphysik)
export function inWater(x, z) {
  return pondE(x, z) < 1.25 && heightAt(x, z) < POND.level + 0.12;
}

// Masken für Vegetation
export function forestMask(x, z) {
  const mountain = smoothstep(-340, -420, z);
  const back = smoothstep(240, 330, z);
  const sides = smoothstep(330, 420, Math.abs(x)) * smoothstep(-60, 40, z);
  let f = Math.max(mountain, back, sides);
  // Lichtungen / Magerrasen an den Hängen (Foto 6)
  const clearing = smoothstep(0.15, 0.45, fbm(x / 160, z / 160, 3));
  f *= 1 - clearing * 0.95;
  // Kegelberg komplett bewaldet
  const d1 = Math.hypot(x - 260, z + 470);
  if (d1 < 170) f = Math.max(f, smoothstep(170, 120, d1));
  return clamp(f, 0, 1);
}

export function villageMask(x, z) {
  const d = Math.hypot((x + 90) / 1.6, z + 285);
  return smoothstep(120, 40, d) * (0.6 + 0.4 * noise2(x / 40, z / 40));
}

function gridMap(u, R, a = 0.22) { return R * (a * u + (1 - a) * u * u * u); }
function gridInv(x, R, a = 0.22) { // Newton-Verfahren, gridMap ist streng monoton
  let u = Math.max(-1, Math.min(1, x / R));
  for (let i = 0; i < 8; i++) u -= (gridMap(u, R, a) - x) / (R * (a + 3 * (1 - a) * u * u));
  return u;
}
const MESH = { R: 1300, seg: 0 };

// Höhe exakt so, wie das Geländenetz trianguliert ist (für Decals wie Reifenspuren)
export function meshHeightAt(x, z) {
  const { R, seg } = MESH;
  if (!seg) return heightAt(x, z);
  const fx = (gridInv(x, R) + 1) / 2 * seg, fz = (gridInv(z, R) + 1) / 2 * seg;
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const H = (i, j) => heightAt(gridMap(-1 + 2 * i / seg, R), gridMap(-1 + 2 * j / seg, R));
  const ha = H(ix, iz), hb = H(ix, iz + 1), hc = H(ix + 1, iz + 1), hd = H(ix + 1, iz);
  // PlaneGeometry teilt jede Zelle entlang der Diagonale b–d
  return tx + tz < 1 ? ha + (hd - ha) * tx + (hb - ha) * tz : hc + (hb - hc) * (1 - tx) + (hd - hc) * (1 - tz);
}

export function createTerrain(quality) {
  const R = MESH.R;
  const seg = quality.terrainSeg;
  MESH.seg = seg;
  const geo = new THREE.PlaneGeometry(2, 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = gridMap(pos.getX(i), R);
    const z = gridMap(pos.getZ(i), R);
    pos.setXYZ(i, x, heightAt(x, z), z);
  }
  geo.computeVertexNormals();

  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const lush = new THREE.Color('#5f8a2e');
  const fresh = new THREE.Color('#86a83f');
  const dry = new THREE.Color('#b3a75a');
  const forest = new THREE.Color('#2c4421');
  const forest2 = new THREE.Color('#3b5526');
  const rock = new THREE.Color('#c4bba5');
  const dirt = new THREE.Color('#9b8a63');
  const fieldCols = ['#93b24a', '#c9b660', '#7aa23a', '#d8c77a', '#a7bf55', '#6f9634'].map((s) => new THREE.Color(s));
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const slope = 1 - nrm.getY(i);
    // Basiswiese
    const n1 = fbm(x / 40, z / 40, 3) * 0.5 + 0.5;
    const n2 = noise2(x / 9, z / 9) * 0.5 + 0.5;
    c.copy(lush).lerp(fresh, n1);
    c.lerp(dry, smoothstep(0.55, 0.95, fbm(x / 120 + 7, z / 120, 2) * 0.5 + 0.5 + n2 * 0.2) * 0.75);

    // Felder im Tal (Flickenteppich)
    const valley = smoothstep(-140, -200, z) * (1 - smoothstep(-330, -380, z));
    if (valley > 0) {
      const cx = Math.floor((x + z * 0.35) / 48), cz = Math.floor(z / 30);
      tmp.copy(fieldCols[Math.floor(hash2(cx, cz) * fieldCols.length)]);
      c.lerp(tmp, valley * 0.85);
    }
    // Wald
    const f = forestMask(x, z);
    if (f > 0) { tmp.copy(forest).lerp(forest2, n1); c.lerp(tmp, f); }
    // Kalkfels an steilen Stellen am Trauf
    const r = smoothstep(0.42, 0.6, slope) * smoothstep(-430, -500, z) * smoothstep(60, 110, y);
    c.lerp(rock, r);
    // Feldweg
    const pd = pathDist(x, z);
    if (pd < 3) c.lerp(dirt, (1 - smoothstep(1.2, 3, pd)) * 0.55);
    // Ufer: dunkler, feuchter Boden, unter Wasser schlammig
    const pe = pondE(x, z);
    if (pe < 1.6) {
      const wet = smoothstep(1.6, 1.02, pe);
      c.lerp(tmp.set('#5d5236'), wet * 0.55);
      c.lerp(tmp.set('#3e3a2a'), smoothstep(POND.level + 0.1, POND.level - 0.5, y) * 0.9);
    }
    // Dorf: etwas verdichteter Boden
    c.lerp(tmp.set('#8f9468'), villageMask(x, z) * 0.35);

    // Ausgleich für die Detailtextur (multipliziert, im Mittel ~0.62 linear)
    c.multiplyScalar(1.45);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  // Welt-UVs: eine Texturkachel ≈ 3 m
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / 3; uv[i * 2 + 1] = pos.getZ(i) / 3; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const { map, normalMap } = groundTextures();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map, normalMap, normalScale: new THREE.Vector2(0.9, 0.9) });
  // Detail in der Ferne ausblenden, damit kein Kachelmuster entsteht
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          vec4 texelColor = texture2D(map, vMapUv);
          float camDist = length(vViewPosition);
          float detailFade = 1.0 - smoothstep(25.0, 140.0, camDist);
          texelColor.rgb = mix(vec3(0.64), texelColor.rgb, detailFade);
          diffuseColor *= texelColor;
        #endif`)
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale * (1.0 - smoothstep(20.0, 90.0, length(vViewPosition)));
          normal = normalize(tbn * mapN);
        #endif`);
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

// Zweispuriger Feldweg als Band mit Canvas-Textur
export function createPath() {
  const cvs = document.createElement('canvas');
  cvs.width = 128; cvs.height = 256;
  const g = cvs.getContext('2d');
  g.clearRect(0, 0, 128, 256);
  const rnd = seeded(77);
  for (const cx of [34, 94]) {
    const grd = g.createLinearGradient(cx - 18, 0, cx + 18, 0);
    grd.addColorStop(0, 'rgba(140,118,80,0)');
    grd.addColorStop(0.3, 'rgba(150,128,88,0.95)');
    grd.addColorStop(0.7, 'rgba(150,128,88,0.95)');
    grd.addColorStop(1, 'rgba(140,118,80,0)');
    g.fillStyle = grd; g.fillRect(cx - 18, 0, 36, 256);
  }
  for (let i = 0; i < 900; i++) { // Steinchen & Krümel
    const x = rnd() * 128, y = rnd() * 256, l = 120 + rnd() * 90;
    g.fillStyle = `rgba(${l},${l - 15},${l - 45},${0.35 * rnd()})`;
    g.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  const tex = new THREE.CanvasTexture(cvs);
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const W = 3.0;
  const verts = [], uvs = [], cols = [], idx = [];
  let n = 0;
  // Ribbon entlang einer Polylinie; fadeIn/fadeOut blenden die Enden weich aus
  const ribbon = (pts, fadeIn = 0, fadeOut = 0) => {
    let v = 0, len = 0;
    const total = pts.reduce((s2, p, i) => s2 + (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
    const start = n;
    pts.forEach(([x, z], i) => {
      const a2 = pts[Math.max(0, i - 1)], b2 = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b2[0] - a2[0], dz = b2[1] - a2[1], l = Math.hypot(dx, dz);
      const px = dz / l, pz = -dx / l; // Normale zur Laufrichtung
      if (i) { const d = Math.hypot(x - pts[i - 1][0], z - pts[i - 1][1]); len += d; v += d / 4; }
      let alpha = 1;
      if (fadeIn) alpha = Math.min(alpha, len / fadeIn);
      if (fadeOut) alpha = Math.min(alpha, (total - len) / fadeOut + 0.25);
      alpha = Math.max(0, Math.min(1, alpha));
      for (const s2 of [-1, 1]) {
        const vx = x + px * s2 * W / 2, vz = z + pz * s2 * W / 2;
        verts.push(vx, heightAt(vx, vz) + 0.05, vz);
        uvs.push(s2 < 0 ? 0 : 1, v);
        cols.push(1, 1, 1, alpha);
      }
      if (n > start) { const b3 = (n - 1) * 2; idx.push(b3, b3 + 2, b3 + 1, b3 + 1, b3 + 2, b3 + 3); }
      n++;
    });
  };
  const main = [];
  for (let z = PATH_Z[0]; z <= PATH_Z[1]; z += 1) main.push([pathX(z), z]);
  ribbon(main);
  for (const B of BRANCHES) ribbon(B.pts.slice(2), 6, 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 4));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}
