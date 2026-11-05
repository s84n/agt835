import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, forestMask, pathDist, pondE } from './terrain.js';
import { TRACK_MAP_WORLD } from './tracks.js';
import { seeded, fbm, noise2, smoothstep, hash2 } from './noise.js';
import { leafTexture, logEndTexture, barkTexture } from './textures.js';
import { NOISE } from '../tractor/grime.js';

export const shared = {
  uTime: { value: 0 },
  uPush: { value: new THREE.Vector4(0, 0, 0, 0) },   // xyz = Traktormitte, w = Stärke
  uPush2: { value: new THREE.Vector4(0, 0, 0, 0) },  // zweiter Achspunkt
  uTrail: { value: null },                            // Spurkarte (gefahrene Bahnen)
  uNight: { value: 0 },                               // 0 = Tag, 1 = Abend (Dorflichter, Glühwürmchen)
};

function colorize(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function jitter(geo, amt, rnd) {
  const p = geo.attributes.position;
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!map.has(key)) map.set(key, [(rnd() - 0.5) * amt, (rnd() - 0.5) * amt, (rnd() - 0.5) * amt]);
    const o = map.get(key);
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

const WIND_GLSL = (strength, pivot, flutter) => `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  #else
    vec3 ip = vec3(0.0);
  #endif
  float hw = max(position.y - ${pivot.toFixed(2)}, 0.0);
  float sway = sin(uTime * 1.1 + ip.x * 0.21 + ip.z * 0.17) * 0.6 + sin(uTime * 2.3 + ip.x * 0.5) * 0.25;
  transformed.x += sway * ${strength.toFixed(3)} * hw;
  transformed.z += cos(uTime * 0.9 + ip.z * 0.3) * ${(strength * 0.6).toFixed(3)} * hw;
  ${flutter ? `transformed += normal * sin(uTime * 5.0 + position.x * 4.0 + position.z * 3.0 + ip.x) * 0.025 * min(hw, 1.0);` : ''}
`;

export function windMaterial(opts, strength = 0.05, pivot = 1.6, { bark = false, leaves = false } = {}) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.vertexShader = 'uniform float uTime;\nvarying vec3 vLPos;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', WIND_GLSL(strength, pivot, leaves) + '\nvLPos = position;');
    sh.fragmentShader = 'varying vec3 vLPos;\n' + sh.fragmentShader;
    if (bark) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            // Rinde: längliche Furchen, Risse und etwas Moos
            float furrow = gNoise(vec3(vLPos.x * 22.0, vLPos.y * 2.2, vLPos.z * 22.0));
            float crack = smoothstep(0.62, 0.8, gNoise(vec3(vLPos.x * 45.0, vLPos.y * 5.0, vLPos.z * 45.0)));
            diffuseColor.rgb *= 0.62 + 0.62 * furrow - crack * 0.4;
            float moss = smoothstep(0.55, 0.8, gNoise(vLPos * 5.0)) * smoothstep(2.6, 0.3, vLPos.y);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.22, 0.07), moss * 0.6);
          }`);
    }
    if (leaves) {
      // Blattkarten: Normale nicht umdrehen, damit Rückseiten nicht schwarz werden
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
        THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    }
  };
  m.customProgramCacheKey = () => `wind-${strength}-${pivot}-${bark}-${leaves}`;
  return m;
}

// ---------- Performance-Helfer ----------
// Teilt Instanzen in räumliche Kacheln auf: So kann three.js ganze Kacheln per Frustum
// Culling aussortieren – im Kamerabild und vor allem im Schattenpass (der nur ~44 m abdeckt).
function chunked(entries, cell, make) {
  const cells = new Map();
  for (const e of entries) {
    const key = `${Math.floor(e.x / cell)},${Math.floor(e.z / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(e);
  }
  const out = [];
  for (const list of cells.values()) {
    const cx = list.reduce((a, e) => a + e.x, 0) / list.length;
    const cz = list.reduce((a, e) => a + e.z, 0) / list.length;
    out.push({ cx, cz, meshes: make(list) });
  }
  return out;
}

function fillInstanced(geo, mat, list, { shadow = false, color = false } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, list.length);
  list.forEach((e, i) => { m.setMatrixAt(i, e.m); if (color && e.c) m.setColorAt(i, e.c); });
  m.castShadow = shadow;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}

// Fernstufe für Blattkronen: nur jedes dritte Blattbüschel, dafür größer
function reduceLeaves(geo, keepEvery = 3, grow = 1.55) {
  const src = geo.attributes;
  const quads = src.position.count / 6;
  const out = { position: [], normal: [], uv: [], color: [] };
  const c = new THREE.Vector3(), v = new THREE.Vector3();
  for (let q = 0; q < quads; q += keepEvery) {
    c.set(0, 0, 0);
    for (let k = 0; k < 6; k++) c.add(v.fromBufferAttribute(src.position, q * 6 + k));
    c.multiplyScalar(1 / 6);
    for (let k = 0; k < 6; k++) {
      const i = q * 6 + k;
      v.fromBufferAttribute(src.position, i).sub(c).multiplyScalar(grow).add(c);
      out.position.push(v.x, v.y, v.z);
      out.normal.push(src.normal.getX(i), src.normal.getY(i), src.normal.getZ(i));
      out.uv.push(src.uv.getX(i), src.uv.getY(i));
      out.color.push(src.color.getX(i), src.color.getY(i), src.color.getZ(i));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.normal, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(out.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.color, 3));
  return g;
}

// ---------- Streuobstbäume ----------
function setColor(geo, fn) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(c, p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 0);
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function makeOrchardTree(seed) {
  const rnd = seeded(seed);
  const wood = [], crown = [], leaves = [];
  const bark = new THREE.Color('#5a4a3a');
  const trunkH = 1.5 + rnd() * 0.7;
  const lean = (rnd() - 0.5) * 0.2;
  // Stamm mit Wurzelanlauf
  const trunk = new THREE.CylinderGeometry(0.13, 0.2, trunkH, 10, 6);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + trunkH / 2;
    const flare = 1 + Math.max(0, 0.35 - y) * 1.6;
    const wob = 1 + (noise2(tp.getX(i) * 9 + seed, y * 3) * 0.12);
    tp.setXYZ(i, tp.getX(i) * flare * wob, tp.getY(i), tp.getZ(i) * flare * wob);
  }
  trunk.translate(0, trunkH / 2, 0);
  trunk.rotateZ(lean);
  trunk.computeVertexNormals();
  wood.push(trunk);
  const top = new THREE.Vector3(-Math.sin(lean) * trunkH, trunkH, 0);

  const crownCenters = [];
  const branch = (from, dir, len, r0, depth) => {
    const b = new THREE.CylinderGeometry(r0 * 0.55, r0, len, 7, 2);
    b.translate(0, len / 2, 0);
    b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    b.translate(from.x, from.y, from.z);
    wood.push(b);
    const end = from.clone().addScaledVector(dir, len);
    if (depth > 0) {
      for (let k = 0; k < 2; k++) {
        const d2 = dir.clone().add(new THREE.Vector3((rnd() - 0.5) * 1.1, 0.25 + rnd() * 0.4, (rnd() - 0.5) * 1.1)).normalize();
        branch(end, d2, len * (0.5 + rnd() * 0.25), r0 * 0.55, depth - 1);
      }
    } else crownCenters.push(end);
  };
  const branches = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rnd() * 0.8;
    const tilt = 0.55 + rnd() * 0.45;
    const dir = new THREE.Vector3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    branch(top.clone().add(new THREE.Vector3(0, -0.1, 0)), dir, 1.1 + rnd() * 0.7, 0.11, 1);
  }
  crownCenters.push(top.clone().add(new THREE.Vector3(0, 1.5, 0)));

  // Kronen-Volumen (dunkler Kern) + Blattkarten an der Oberfläche
  const leafCols = ['#7aa646', '#8cb550', '#6c9a3c', '#99bd5a', '#82ad48'].map((c) => new THREE.Color(c));
  const blobs = [];
  const nBlobs = 8 + Math.floor(rnd() * 5);
  for (let i = 0; i < nBlobs; i++) {
    const base = crownCenters[i % crownCenters.length];
    const r = 0.75 + rnd() * 0.65;
    const c = new THREE.Vector3(base.x + (rnd() - 0.5) * 1.0, base.y + (rnd() - 0.1) * 0.8, base.z + (rnd() - 0.5) * 1.0);
    blobs.push({ c, r });
    const g = new THREE.IcosahedronGeometry(r * 0.4, 1); // nur noch kleiner Schattenkern
    jitter(g, 0.25, rnd);
    g.scale(1, 0.82, 1);
    g.translate(c.x, c.y, c.z);
    g.deleteAttribute('uv');
    crown.push(setColor(g.index ? g.toNonIndexed() : g, (col, x, y, z, ny) => col.set('#3e6322').multiplyScalar(0.6 + Math.max(ny, 0) * 0.35)));
  }
  const crownMid = blobs.reduce((v, b) => v.add(b.c), new THREE.Vector3()).multiplyScalar(1 / blobs.length);
  const pos = [], nrm = [], uv = [], col = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler();
  const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  for (const { c, r } of blobs) {
    const n = Math.round(62 * r * r + 22);
    for (let k = 0; k < n; k++) {
      const d = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.45), rnd() - 0.5).normalize();
      const p = c.clone().addScaledVector(d, r * (0.3 + Math.sqrt(rnd()) * 0.75));
      const sz = 0.6 + rnd() * 0.5;
      q.setFromEuler(e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI));
      // Normale: weich nach außen, wie eine Kugel um die gesamte Krone
      const outward = p.clone().sub(crownMid).normalize().lerp(d, 0.5).normalize();
      const cc = leafCols[Math.floor(rnd() * leafCols.length)].clone();
      const ao = 0.65 + 0.35 * Math.max(0, outward.y * 0.5 + 0.5);
      cc.multiplyScalar(ao);
      for (const [u, v] of corners) {
        const vtx = new THREE.Vector3(u * sz, v * sz, 0).applyQuaternion(q).add(p);
        pos.push(vtx.x, vtx.y, vtx.z);
        nrm.push(outward.x, outward.y, outward.z);
        uv.push(u + 0.5, v + 0.5);
        col.push(cc.r, cc.g, cc.b);
      }
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  lg.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  lg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  leaves.push(lg);

  const woodGeo = mergeGeometries(wood.map((g) => { g.deleteAttribute('uv'); return setColor(g.index ? g.toNonIndexed() : g, (c) => c.copy(bark)); }));
  return { wood: woodGeo, crown: mergeGeometries(crown), leaves: lg };
}

export function createOrchard(quality, { extras = [], clear = [] } = {}) {
  const group = new THREE.Group();
  const obstacles = [];
  const rnd = seeded(1234);
  const variants = [11, 23, 37, 51, 68].map(makeOrchardTree);
  const spots = [];
  const sp = 15;
  for (let gx = -270; gx <= 270; gx += sp) {
    for (let gz = -150; gz <= 250; gz += sp * 0.9) {
      const x = gx + (rnd() - 0.5) * 9 + (Math.floor(gz / sp) % 2) * sp * 0.5;
      const z = gz + (rnd() - 0.5) * 8;
      const r = Math.hypot(x, z);
      if (r < 17) continue;                         // Bühne frei lassen
      if (pathDist(x, z) < 4.5) continue;           // Feldweg frei
      if (pondE(x, z) < 1.9) continue;              // Weiher und Platz am Steg frei
      if (clear.some((c) => Math.hypot(x - c.x, z - c.z) < c.r)) continue; // Aussicht frei
      if (forestMask(x, z) > 0.3) continue;
      if (fbm(x / 90, z / 90, 2) > 0.35) continue;  // offene Wiesenflächen
      if (rnd() < 0.18) continue;
      spots.push([x, z]);
    }
  }
  // Ein paar markante Bäume nahe der Bühne (wie auf den Fotos)
  // markante Bäume nahe der Bühne; einer steht hinter der Feierabend-Bank
  const ba = 1.2 + 0.62, br = 9.4;
  spots.push([-13, -9], [Math.sin(ba) * br, Math.cos(ba) * br], [-19, 15], [21, -16], [12, 14]);

  const leafMap = leafTexture();
  const woodMat = windMaterial({ vertexColors: true }, 0.035, 1.8, { bark: true });
  const leafMat = windMaterial({ vertexColors: true, map: leafMap, alphaTest: 0.45, side: THREE.DoubleSide }, 0.035, 1.8, { leaves: true });
  const leafLow = variants.map((v) => reduceLeaves(v.leaves));
  const q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  for (const e of extras) spots.push([e.x, e.z, e.k]);
  const entries = spots.map(([x, z, big], i) => {
    const k = big || 0.85 + rnd() * 0.5;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
    sc.set(k, k * (0.9 + rnd() * 0.25), k);
    p.set(x, heightAt(x, z) - 0.1, z);
    obstacles.push({ x, z, r: 0.45 * k });
    return { x, z, v: i % variants.length, m: new THREE.Matrix4().compose(p, q, sc) };
  });
  const chunks = chunked(entries, 60, (list) => {
    const res = { wood: [], high: [], low: [] };
    variants.forEach((v, vi) => {
      const sub = list.filter((e) => e.v === vi);
      if (!sub.length) return;
      res.wood.push(fillInstanced(v.wood, woodMat, sub, { shadow: true }));
      res.high.push(fillInstanced(v.leaves, leafMat, sub, { shadow: true }));
      const lo = fillInstanced(leafLow[vi], leafMat, sub);
      lo.visible = false;
      res.low.push(lo);
    });
    [...res.wood, ...res.high, ...res.low].forEach((m) => group.add(m));
    return res;
  });
  // Detailstufe je Kachel nach Kameraabstand (mit Hysterese gegen Flackern)
  const lod = {
    near: true,
    update(camera) {
      for (const c of chunks) {
        const d = Math.hypot(camera.position.x - c.cx, camera.position.z - c.cz);
        const near = c.near ?? true;
        const nowNear = near ? d < 95 : d < 80;
        if (nowNear === c.near) continue;
        c.near = nowNear;
        c.meshes.high.forEach((m) => (m.visible = nowNear));
        c.meshes.low.forEach((m) => (m.visible = !nowNear));
      }
    },
  };
  return { group, obstacles, lod };
}

// ---------- Wald an den Hängen ----------
// Geometrie für ferne Waldbäume: Vertex-Farbe = Licht/Schatten-Verlauf (wird mit instanceColor multipliziert)
function shadeByHeight(geo, y0, y1, base = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  return setColor(g, (c, x, y) => {
    const t = Math.min(Math.max((y - y0) / (y1 - y0), 0), 1);
    c.setScalar(base * (0.5 + 0.62 * t));
  });
}

export function decidGeo(rnd) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.07, 0.12, 0.9, 5).translate(0, 0.45, 0);
  { const t = trunk.toNonIndexed(); t.deleteAttribute('uv'); parts.push(setColor(t, (c) => c.setRGB(0.55, 0.42, 0.3))); }
  const blobs = [[0, 1.45, 0, 0.85], [0.5, 1.2, 0.25, 0.6], [-0.45, 1.25, -0.2, 0.62], [0.15, 1.95, -0.1, 0.55], [-0.2, 1.7, 0.45, 0.5]];
  for (const [x, y, z, r] of blobs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    jitter(g, r * 0.35, rnd);
    g.translate(x, y, z);
    parts.push(shadeByHeight(g, 0.7, 2.4));
  }
  return mergeGeometries(parts);
}

function coniferGeo(rnd) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.05, 0.09, 0.8, 5).translate(0, 0.4, 0);
  { const t = trunk.toNonIndexed(); t.deleteAttribute('uv'); parts.push(setColor(t, (c) => c.setRGB(0.5, 0.4, 0.3))); }
  const tiers = [[0.62, 1.1, 0.95], [0.48, 0.95, 1.55], [0.34, 0.85, 2.1], [0.18, 0.6, 2.55]];
  for (const [r, h, y] of tiers) {
    const g = new THREE.ConeGeometry(r, h, 7, 1);
    jitter(g, r * 0.12, rnd);
    g.translate(0, y, 0);
    parts.push(shadeByHeight(g, 0.5, 2.9));
  }
  return mergeGeometries(parts);
}

// ---------- Wald an den Hängen (Mischwald: Laubbäume + Fichten) ----------
export function createForest(quality) {
  const rnd = seeded(99);
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const N = quality.forest;
  const nC = Math.round(N * 0.38), nD = N - nC;
  const dGeos = [decidGeo(rnd), decidGeo(rnd)];
  const cGeo = coniferGeo(rnd);
  const lists = [[], [], []]; // Laub A, Laub B, Fichte
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const dCols = ['#4a6e2c', '#557a32', '#5f8436', '#46682a', '#6a8a38', '#7a8c3a', '#52752e'].map((c) => new THREE.Color(c));
  const cCols = ['#2a4a2c', '#2f5232', '#26442a', '#355a36'].map((c) => new THREE.Color(c));
  let tries = 0, total = 0;
  while (total < N && tries < N * 30) {
    tries++;
    const x = (rnd() - 0.5) * 2400, z = (rnd() - 0.5) * 2400;
    if (Math.hypot(x, z) < 160) continue;
    const f = forestMask(x, z);
    if (rnd() > f) continue;
    const y = heightAt(x, z);
    // Fichten häufiger in höheren Lagen
    const conifer = rnd() < 0.25 + Math.min(Math.max((y - 40) / 120, 0), 1) * 0.35;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    if (conifer && lists[2].length < nC) {
      const k = 5.0 + rnd() * 3.0;
      s.set(k, k * (1.1 + rnd() * 0.35), k);
      p.set(x, y - 0.6, z);
      lists[2].push({ x, z, m: m4.compose(p, q, s).clone(), c: cCols[Math.floor(rnd() * cCols.length)] });
    } else {
      const i = rnd() < 0.5 ? 0 : 1;
      if (lists[0].length + lists[1].length >= nD) continue;
      const k = 5.5 + rnd() * 3.5;
      s.set(k * (0.9 + rnd() * 0.3), k * (0.85 + rnd() * 0.35), k * (0.9 + rnd() * 0.3));
      p.set(x, y - 0.6, z);
      const c = dCols[Math.floor(rnd() * dCols.length)].clone();
      if (rnd() < 0.03) c.set('#8a7f38'); // vereinzelt herbstliche Tupfer
      lists[i].push({ x, z, m: m4.compose(p, q, s).clone(), c });
    }
    total++;
  }
  const geos = [dGeos[0], dGeos[1], cGeo];
  lists.forEach((list, i) => {
    chunked(list, 400, (sub) => {
      const m = fillInstanced(geos[i], mat, sub, { color: true });
      group.add(m);
      return m;
    });
  });
  return group;
}

// ---------- Holzstapel (Foto 5) ----------
export function createWoodpile(x, z, rotY = 0) {
  const rnd = seeded(5);
  const g = new THREE.Group();
  const logGeo = new THREE.CylinderGeometry(0.11, 0.12, 1.0, 7);
  logGeo.rotateX(Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ map: barkTexture() });
  const endMat = new THREE.MeshLambertMaterial({ map: logEndTexture() });
  const rows = 9, cols = 22;
  const im = new THREE.InstancedMesh(logGeo, [mat, endMat, endMat], rows * cols);
  const m4 = new THREE.Matrix4();
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hgt = rows - Math.abs(c - cols / 2) * 0.35;
      if (r > hgt) continue;
      const k = 0.85 + rnd() * 0.35;
      m4.makeScale(k, k, 0.9 + rnd() * 0.2);
      m4.setPosition(c * 0.22 - cols * 0.11 + (r % 2) * 0.1, 0.12 + r * 0.2, (rnd() - 0.5) * 0.12);
      im.setMatrixAt(i++, m4);
    }
  }
  im.count = i;
  im.castShadow = true; im.receiveShadow = true;
  g.add(im);
  g.position.set(x, heightAt(x, z), z);
  g.rotation.y = rotY;
  return { group: g, obstacle: { x, z, r: 2.4 } };
}

// ---------- Gras ----------
function bladeClump(rnd, blades = 5) {
  const parts = [];
  for (let b = 0; b < blades; b++) {
    const h = 0.22 + rnd() * 0.26, w = 0.03 + rnd() * 0.02, segs = 3;
    const pos = [], col = [], idx = [];
    const bend = 0.15 + rnd() * 0.25;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const ww = w * (1 - t * 0.92);
      const y = t * h, zOff = bend * t * t;
      pos.push(-ww, y, zOff, ww, y, zOff);
      const shade = 0.72 + t * 0.4;
      col.push(shade, shade, shade, shade, shade, shade);
      if (i < segs) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.rotateY(rnd() * Math.PI * 2);
    g.translate((rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25);
    parts.push(g);
  }
  const m = mergeGeometries(parts);
  const n = m.attributes.position.count;
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1; // weiche Beleuchtung wie der Boden
  m.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return m;
}

function flowerClump(rnd) {
  const parts = [];
  for (let b = 0; b < 3; b++) {
    const h = 0.3 + rnd() * 0.25;
    const stem = new THREE.CylinderGeometry(0.008, 0.01, h, 3).translate(0, h / 2, 0);
    const stemC = colorize(stem, '#5b7a2c');
    const head = new THREE.IcosahedronGeometry(0.05 + rnd() * 0.03, 0).scale(1, 0.45, 1).translate(0, h, 0);
    const headC = colorize(head, '#ffffff');
    const g = mergeGeometries([stemC, headC]);
    g.translate((rnd() - 0.5) * 0.4, 0, (rnd() - 0.5) * 0.4);
    parts.push(g);
  }
  const m = mergeGeometries(parts);
  const n = m.attributes.position.count;
  const nrm = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1;
  m.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return m;
}

function grassMaterial(fadeStart, fadeEnd, swayAmt) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uPush = shared.uPush;
    sh.uniforms.uPush2 = shared.uPush2;
    sh.uniforms.uTrail = shared.uTrail;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime; uniform vec4 uPush; uniform vec4 uPush2; uniform sampler2D uTrail;
        attribute vec4 aOffset; attribute vec3 aTint;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb *= aTint;`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = position;
        float rot = fract(aOffset.w) * 6.2831;
        float sc = floor(aOffset.w) / 100.0;
        float dist = distance(cameraPosition.xz, aOffset.xz);
        sc *= 1.0 - smoothstep(${fadeStart.toFixed(1)}, ${fadeEnd.toFixed(1)}, dist);
        float hgt = transformed.y;
        transformed *= sc;
        float cr = cos(rot), sr = sin(rot);
        transformed.xz = mat2(cr, -sr, sr, cr) * transformed.xz;
        float k = hgt * hgt;
        // Wind
        float w = sin(uTime * 1.8 + aOffset.x * 0.35 + aOffset.z * 0.22) + 0.5 * sin(uTime * 3.1 + aOffset.x * 1.3);
        float gust = smoothstep(0.2, 1.0, sin(uTime * 0.45 + aOffset.x * 0.04 - aOffset.z * 0.03));
        transformed.x += (w * 0.5 + gust * 0.9) * ${swayAmt.toFixed(3)} * k;
        transformed.z += (w * 0.3) * ${swayAmt.toFixed(3)} * k;
        // Traktor drückt das Gras weg
        for (int j = 0; j < 2; j++) {
          vec4 P = j == 0 ? uPush : uPush2;
          vec2 d = aOffset.xz - P.xz;
          float f = (1.0 - smoothstep(0.4, 1.35, length(d))) * P.w;
          transformed.y *= 1.0 - f * 0.85;
          transformed.xz += normalize(d + 0.0001) * f * 0.35 * hgt;
        }
        // gefahrene Bahnen bleiben niedergedrückt
        float trail = texture2D(uTrail, aOffset.xz / ${TRACK_MAP_WORLD.toFixed(1)} + 0.5).r;
        transformed.y *= 1.0 - trail * 0.78;
        transformed += aOffset.xyz;
      `)
      .replace('#include <project_vertex>', `
        vec4 mvPosition = viewMatrix * vec4(transformed, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      `)
      .replace('#include <worldpos_vertex>', `vec4 worldPosition = vec4(transformed, 1.0);`);
  };
  return m;
}

// Gras als Kachel-Pool, der mit der Kamera mitwandert: so wächst überall Gras, wo man hinfährt,
// ohne dass mehr Halme gezeichnet werden. Jede Kachel wird deterministisch aus ihrer Zellnummer
// befüllt (gleiche Stelle = gleiches Gras), pro Aufruf nur wenige Kacheln, damit nichts ruckelt.
export class Grass {
  constructor(quality) {
    this.group = new THREE.Group();
    const rnd = seeded(42);
    this.tile = 16;
    this.R = quality.grassRadius;
    this.perTile = quality.grassPerTile;
    this.flowerCap = Math.ceil(this.perTile * 0.2);
    this.clumps = [bladeClump(rnd, 7), bladeClump(rnd, 6), bladeClump(rnd, 8)];
    this.flower = flowerClump(rnd);
    this.mat = grassMaterial(this.R * 0.55, this.R * 0.95, 0.09);
    this.fmat = grassMaterial(this.R * 0.45, this.R * 0.8, 0.06);
    this.reach = this.R + this.tile * 0.75;
    const span = Math.ceil(this.reach / this.tile) + 1;
    // so viele Plätze, wie Zellen höchstens gleichzeitig im Radius liegen
    let count = 0;
    for (let i = -span; i <= span; i++) for (let j = -span; j <= span; j++) {
      if (Math.hypot(Math.max(0, Math.abs(i) - 1) * this.tile, Math.max(0, Math.abs(j) - 1) * this.tile) <= this.reach) count++;
    }
    this.span = span;
    this.slots = [];
    for (let k = 0; k < count; k++) this.slots.push(this.makeSlot(k));
    this.cells = new Map();
    this.last = null;
    this.update({ position: new THREE.Vector3(0, 0, 0) }, Infinity);
  }

  makeSlot(k) {
    const mk = (base, mat, cap) => {
      const g = new THREE.InstancedBufferGeometry();
      g.index = base.index;
      for (const key in base.attributes) g.setAttribute(key, base.attributes[key]);
      g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.instanceCount = 0;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.tile * 0.75 + 3);
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    return { key: null, cx: 0, cz: 0, n: 0, fn: 0,
      grass: mk(this.clumps[k % this.clumps.length], this.mat, this.perTile),
      flowers: mk(this.flower, this.fmat, this.flowerCap) };
  }

  fill(slot, ix, iz) {
    const { tile, perTile } = this;
    const tx = ix * tile, tz = iz * tile;
    const rnd = seeded((Math.floor(hash2(ix * 1.37 + 0.11, iz * 2.71 + 0.53) * 2147483647) ^ 0x5bd1e995) | 0);
    const go = slot.grass.geometry.attributes.aOffset.array, gt = slot.grass.geometry.attributes.aTint.array;
    const fo = slot.flowers.geometry.attributes.aOffset.array, ft = slot.flowers.geometry.attributes.aTint.array;
    const green = _green, dry = _dry, dark = _dark, c = _c;
    let n = 0, fn = 0;
    for (let i = 0; i < perTile; i++) {
      const x = tx + rnd() * tile, z = tz + rnd() * tile;
      const r1 = rnd(), r2 = rnd(), r3 = rnd(), r4 = rnd(), r5 = rnd(), r6 = rnd(), r7 = rnd();
      const pd = pathDist(x, z);
      if (pd < 1.45 && pd > 0.35) continue;      // Fahrspuren frei
      const pe = pondE(x, z);
      if (pe < 1.06) continue;                    // kein Gras im Wasser
      const dens = fbm(x / 25, z / 25, 2);
      if (dens < -0.35 && r1 < 0.6) continue;
      const y = heightAt(x, z);
      let scale = (0.5 + r2 * 0.35) * (1 + 0.3 * smoothstep(-0.2, 0.6, dens));
      if (pd <= 0.35) scale *= 0.55;
      if (pe < 1.5) scale *= 1.1 + (1.5 - pe) * 0.6; // am Ufer üppiger
      const dryness = smoothstep(0.0, 0.9, fbm(x / 60 + 3, z / 60, 2) * 0.5 + 0.5 + (r3 - 0.5) * 0.35);
      c.copy(green).lerp(dry, dryness * 0.6 * (pe < 1.6 ? 0.3 : 1)).lerp(dark, r4 * 0.35);
      go[n * 4] = x; go[n * 4 + 1] = y - 0.02; go[n * 4 + 2] = z; go[n * 4 + 3] = Math.floor(scale * 100) + r5 * 0.999;
      gt[n * 3] = c.r * 1.12; gt[n * 3 + 1] = c.g * 1.12; gt[n * 3 + 2] = c.b * 1.12;
      n++;
      // Wiesenblumen in Nestern
      if (fn < this.flowerCap && noise2(x / 9, z / 9) > 0.45 && r6 < 0.18) {
        fo[fn * 4] = x + 0.2; fo[fn * 4 + 1] = y - 0.02; fo[fn * 4 + 2] = z + 0.1; fo[fn * 4 + 3] = Math.floor((0.8 + r7 * 0.5) * 100) + r5 * 0.999;
        ft[fn * 3] = 1; ft[fn * 3 + 1] = 1; ft[fn * 3 + 2] = r7 < 0.15 ? 0.6 : 1;
        fn++;
      }
    }
    slot.cx = tx + tile / 2; slot.cz = tz + tile / 2; slot.n = n; slot.fn = fn;
    const y = heightAt(slot.cx, slot.cz);
    for (const [m, cnt] of [[slot.grass, n], [slot.flowers, fn]]) {
      const g = m.geometry;
      g.attributes.aOffset.needsUpdate = true; g.attributes.aTint.needsUpdate = true;
      g.attributes.aOffset.clearUpdateRanges?.(); g.attributes.aTint.clearUpdateRanges?.();
      g.instanceCount = cnt;
      g.boundingSphere.center.set(slot.cx, y, slot.cz);
      m.visible = cnt > 0;
    }
  }

  update(camera, budget = 3) {
    const { tile, span, reach } = this;
    const px = camera.position.x, pz = camera.position.z;
    // nach einem Sprung (z. B. zurück in den Showroom) alles auf einmal nachziehen
    if (this.last && Math.hypot(px - this.last.x, pz - this.last.z) > this.R) budget = Infinity;
    this.last = { x: px, z: pz };
    const ix0 = Math.floor(px / tile), iz0 = Math.floor(pz / tile);
    const want = new Map();
    for (let i = ix0 - span; i <= ix0 + span; i++) for (let j = iz0 - span; j <= iz0 + span; j++) {
      const d = Math.hypot((i + 0.5) * tile - px, (j + 0.5) * tile - pz);
      if (d <= reach) want.set(i + ',' + j, { i, j, d });
    }
    const free = this.slots.filter((s2) => !s2.key || !want.has(s2.key));
    const missing = [...want.entries()].filter(([k]) => !this.cells.has(k)).sort((a2, b2) => a2[1].d - b2[1].d);
    for (const [key, w] of missing) {
      if (budget <= 0 || !free.length) break;
      // eine nicht mehr benötigte Kachel wiederverwenden
      const slot = free.pop();
      if (slot.key) this.cells.delete(slot.key);
      this.fill(slot, w.i, w.j);
      slot.key = key;
      this.cells.set(key, slot);
      budget--;
    }
    // LOD: entfernte Kacheln zeichnen weniger Halme (Instanzen sind zufällig verteilt)
    for (const s2 of this.slots) {
      if (!s2.key) continue;
      const d = Math.hypot(px - s2.cx, pz - s2.cz);
      const f = d < 22 ? 1 : Math.max(0.12, 1 - (d - 22) / 70);
      s2.grass.geometry.instanceCount = Math.floor(s2.n * f);
      s2.flowers.geometry.instanceCount = Math.floor(s2.fn * f);
    }
  }
}
const _green = new THREE.Color('#79a23a'), _dry = new THREE.Color('#b4ab60'), _dark = new THREE.Color('#5d8a2e'), _c = new THREE.Color();
