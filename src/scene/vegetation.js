import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, forestMask, villageMask, pathDist } from './terrain.js';
import { seeded, fbm, noise2, smoothstep } from './noise.js';
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

function windMaterial(opts, strength = 0.05, pivot = 1.6, { bark = false, leaves = false } = {}) {
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

export function createOrchard(quality) {
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
  const entries = spots.map(([x, z], i) => {
    const k = 0.85 + rnd() * 0.5;
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

function decidGeo(rnd) {
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

// ---------- Dorf im Tal ----------
function houseGeometry() {
  const walls = colorize(new THREE.BoxGeometry(1, 0.62, 1).translate(0, 0.31, 0), '#efe8da');
  const shape = new THREE.Shape();
  shape.moveTo(-0.56, 0); shape.lineTo(0.56, 0); shape.lineTo(0, 0.42); shape.closePath();
  const roof = new THREE.ExtrudeGeometry(shape, { depth: 1.1, bevelEnabled: false });
  roof.translate(0, 0.62, -0.55);
  const r = colorize(roof, '#a2452e');
  return mergeGeometries([walls, r]);
}

export function createVillage() {
  const rnd = seeded(555);
  const geo = houseGeometry();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const list = [];
  const cell = 15;
  for (let x = -330; x < 160; x += cell) {
    for (let z = -400; z < -170; z += cell) {
      const jx = x + (rnd() - 0.5) * 8, jz = z + (rnd() - 0.5) * 8;
      if (rnd() < villageMask(jx, jz) * 1.4) list.push([jx, jz]);
    }
  }
  // Aussiedlerhöfe
  for (let i = 0; i < 14; i++) list.push([(rnd() - 0.5) * 900, -200 - rnd() * 130]);
  const im = new THREE.InstancedMesh(geo, mat, list.length + 1);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const roofTints = ['#ffffff', '#e8d4cc', '#c9b6b0', '#f2e2c8', '#d0d0d0'].map((c) => new THREE.Color(c));
  list.forEach(([x, z], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.round(rnd() * 3) * Math.PI) / 2 + (rnd() - 0.5) * 0.3 + 0.35);
    s.set(8 + rnd() * 5, 9 + rnd() * 4, 10 + rnd() * 6);
    p.set(x, heightAt(x, z) - 0.5, z);
    im.setMatrixAt(i, m4.compose(p, q, s));
    im.setColorAt(i, roofTints[Math.floor(rnd() * roofTints.length)]);
  });
  // Kirchturm
  const cx = -95, cz = -282;
  q.identity(); s.set(6, 34, 6); p.set(cx, heightAt(cx, cz) - 0.5, cz);
  im.setMatrixAt(list.length, m4.compose(p, q, s));
  im.setColorAt(list.length, new THREE.Color('#ffffff'));
  im.computeBoundingSphere();

  // Fenster: gehen abends Haus für Haus an (Schwelle je Haus, gesteuert über uNight)
  const wins = [];
  for (const [x, z] of [[-0.25, 0.506], [0.05, 0.506], [0.28, 0.506], [-0.2, -0.506], [0.22, -0.506]]) {
    wins.push(new THREE.PlaneGeometry(0.1, 0.12).translate(x, 0.3, z));
  }
  for (const z of [-0.22, 0.2]) wins.push(new THREE.PlaneGeometry(0.1, 0.12).rotateY(Math.PI / 2).translate(0.506, 0.3, z));
  for (const z of [0.0]) wins.push(new THREE.PlaneGeometry(0.1, 0.12).rotateY(Math.PI / 2).translate(-0.506, 0.3, z));
  const winGeo = mergeGeometries(wins);
  const thr = new Float32Array(list.length);
  for (let i = 0; i < list.length; i++) thr[i] = 0.2 + rnd() * 0.75;
  winGeo.setAttribute('aThresh', new THREE.InstancedBufferAttribute(thr, 1));
  const winMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ffc477').multiplyScalar(2.6), side: THREE.DoubleSide });
  winMat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = shared.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; attribute float aThresh;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= step(aThresh, uNight);');
  };
  const windows = new THREE.InstancedMesh(winGeo, winMat, list.length);
  for (let i = 0; i < list.length; i++) { im.getMatrixAt(i, m4); windows.setMatrixAt(i, m4); }
  windows.computeBoundingSphere();
  const group = new THREE.Group();
  group.add(im, windows);
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
        float trail = texture2D(uTrail, aOffset.xz / 240.0 + 0.5).r;
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

export class Grass {
  constructor(quality) {
    this.group = new THREE.Group();
    const rnd = seeded(42);
    const tile = 16, R = quality.grassRadius;
    const perTile = quality.grassPerTile;
    const clumps = [bladeClump(rnd, 7), bladeClump(rnd, 6), bladeClump(rnd, 8)];
    const flower = flowerClump(rnd);
    const mat = grassMaterial(R * 0.55, R * 0.95, 0.09);
    const fmat = grassMaterial(R * 0.45, R * 0.8, 0.06);
    this.tiles = [];
    const green = new THREE.Color('#79a23a'), dry = new THREE.Color('#b4ab60'), dark = new THREE.Color('#5d8a2e');
    const c = new THREE.Color();
    let ti = 0;
    for (let tx = -R; tx < R; tx += tile) {
      for (let tz = -R; tz < R; tz += tile) {
        const cx = tx + tile / 2, cz = tz + tile / 2;
        if (Math.hypot(cx, cz) > R + tile) continue;
        const geoBase = clumps[ti++ % clumps.length];
        const offs = [], tints = [], foffs = [], ftints = [];
        for (let i = 0; i < perTile; i++) {
          const x = tx + rnd() * tile, z = tz + rnd() * tile;
          const pd = pathDist(x, z);
          if (pd < 1.45 && pd > 0.35) continue;      // Fahrspuren frei
          const dens = fbm(x / 25, z / 25, 2);
          if (dens < -0.35 && rnd() < 0.6) continue;
          const y = heightAt(x, z);
          let scale = (0.5 + rnd() * 0.35) * (1 + 0.3 * smoothstep(-0.2, 0.6, dens));
          if (pd <= 0.35) scale *= 0.55;
          const dryness = smoothstep(0.0, 0.9, fbm(x / 60 + 3, z / 60, 2) * 0.5 + 0.5 + (rnd() - 0.5) * 0.35);
          c.copy(green).lerp(dry, dryness * 0.6).lerp(dark, rnd() * 0.35);
          offs.push(x, y - 0.02, z, Math.floor(scale * 100) + rnd() * 0.999);
          tints.push(c.r * 1.12, c.g * 1.12, c.b * 1.12);
          // Wiesenblumen in Nestern
          if (noise2(x / 9, z / 9) > 0.45 && rnd() < 0.18) {
            foffs.push(x + 0.2, y - 0.02, z + 0.1, Math.floor((0.8 + rnd() * 0.5) * 100) + rnd() * 0.999);
            ftints.push(1, 1, rnd() < 0.15 ? 0.6 : 1);
          }
        }
        this.tiles.push(this.makeTile(geoBase, mat, offs, tints, cx, cz, tile));
        if (foffs.length) this.tiles.push(this.makeTile(flower, fmat, foffs, ftints, cx, cz, tile, true));
      }
    }
  }

  makeTile(base, mat, offs, tints, cx, cz, tile, isFlower = false) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    for (const k in base.attributes) g.setAttribute(k, base.attributes[k]);
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(offs), 4));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(tints), 3));
    const n = offs.length / 4;
    g.instanceCount = n;
    const y = heightAt(cx, cz);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, y, cz), tile * 0.75 + 3);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(cx - tile, y - 10, cz - tile), new THREE.Vector3(cx + tile, y + 10, cz + tile));
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.userData = { cx, cz, n, isFlower };
    this.group.add(mesh);
    return mesh;
  }

  update(camera) {
    // LOD: entfernte Kacheln zeichnen weniger Halme (Instanzen sind zufällig verteilt)
    for (const m of this.tiles) {
      const d = Math.hypot(camera.position.x - m.userData.cx, camera.position.z - m.userData.cz);
      const f = d < 22 ? 1 : Math.max(0.12, 1 - (d - 22) / 70);
      m.geometry.instanceCount = Math.floor(m.userData.n * f);
    }
  }
}
