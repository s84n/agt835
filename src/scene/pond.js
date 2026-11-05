import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, pondE, POND, POND_PARK, BRANCH } from './terrain.js';
import { seeded, noise2, clamp, smoothstep } from './noise.js';
import { shared, windMaterial } from './vegetation.js';
import { woodTexture } from './feierabend.js';
import { leafTexture } from './textures.js';

// Der Weiher am Ende des Feldweg-Abzweigs: spiegelndes Wasser mit Wellenringen, Holzsteg mit
// Laterne, Ruderboot, Schilf und Rohrkolben, Seerosen, Trauerweide, Enten und springende Fische.
// Vom Stegende aus kann man flache Steine übers Wasser flitschen lassen.

const L = POND.level;
const MAX_RIPPLES = 24;
const JETTY = { x0: 105.5, x1: 119.2, z: POND.z, w: 1.5, y: L + 0.55 };

// ---------- Wasser ----------
const waterVert = /* glsl */`
uniform mat4 textureMatrix;
varying vec4 vUvR; varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vUvR = textureMatrix * vec4(position, 1.0);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const waterFrag = /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime, uReflect, uSunPow;
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform vec3 uSunDir, uSunColor, uDeep, uSkyH, uSkyT;
uniform vec2 uCenter, uRadii;
varying vec4 vUvR; varying vec3 vWorld;
#include <fog_pars_fragment>

vec2 waveGrad(vec2 p) {
  vec2 g = vec2(0.0);
  // feine Kräuselung durch den Wind, mehrere Richtungen
  g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 2.1 + uTime * 1.5) * 0.016;
  g += vec2(-0.5, 0.86) * cos(dot(p, vec2(-0.5, 0.86)) * 3.4 + uTime * 2.1) * 0.011;
  g += vec2(0.95, -0.31) * cos(dot(p, vec2(0.95, -0.31)) * 5.9 + uTime * 2.8) * 0.008;
  g += vec2(0.2, 0.98) * cos(dot(p, vec2(0.2, 0.98)) * 9.3 - uTime * 3.6) * 0.006;
  g += vec2(-0.9, -0.43) * cos(dot(p, vec2(-0.9, -0.43)) * 14.1 + uTime * 4.4) * 0.004;
  // Wellenringe (Steine, Fische, Enten)
  for (int i = 0; i < ${MAX_RIPPLES}; i++) {
    vec4 r = uRipples[i];
    float age = uTime - r.z;
    if (r.w <= 0.0 || age < 0.0 || age > 7.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float x = dist - age * 0.62;
    float env = exp(-x * x * 5.0) * exp(-age * 0.75) * r.w / (1.0 + dist * 0.9);
    g += d / dist * sin(x * 19.0) * env * 0.55;
  }
  return g;
}

void main() {
  vec2 g = waveGrad(vWorld.xz);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.12 + 0.88 * pow(1.0 - ndv, 3.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyH, uSkyT, pow(clamp(R.y, 0.0, 1.0), 0.6));
  vec3 refl = sky;
  if (uReflect > 0.5) {
    vec4 uv = vUvR;
    uv.xy += N.xz * 0.6 * uv.w * 0.12;
    refl = texture2DProj(tDiffuse, uv).rgb;
  }
  vec3 col = mix(uDeep, refl, fres);
  // Sonnenglitzern
  vec3 H = normalize(normalize(uSunDir) + V);
  float spec = pow(max(dot(N, H), 0.0), 420.0) * 7.0 + pow(max(dot(N, H), 0.0), 60.0) * 0.25;
  col += uSunColor * spec * uSunPow;
  // zum Ufer hin etwas trüber (Schwebstoffe im flachen Wasser)
  vec2 q = (vWorld.xz - uCenter) / uRadii;
  float shore = smoothstep(0.55, 1.0, length(q));
  col = mix(col, col * vec3(0.82, 0.8, 0.62) + vec3(0.03, 0.03, 0.01), shore * 0.35);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}`;

function createWater(quality) {
  const shader = {
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: new THREE.Matrix4() },
      uTime: { value: 0 }, uReflect: { value: 1 }, uSunPow: { value: 1 },
      uRipples: { value: Array.from({ length: MAX_RIPPLES }, () => new THREE.Vector4(0, 0, -100, 0)) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() },
      uDeep: { value: new THREE.Color('#1c2a1d') }, uSkyH: { value: new THREE.Color() }, uSkyT: { value: new THREE.Color() },
      uCenter: { value: new THREE.Vector2(POND.x, POND.z) }, uRadii: { value: new THREE.Vector2(POND.rx, POND.rz) },
    }]),
    vertexShader: waterVert, fragmentShader: waterFrag,
  };
  // Fächer, dessen Rand dem unregelmäßigen Ufer folgt (knapp im Hang, dort liegt das Gelände schon über dem Wasser)
  const N = 160, pos = [0, 0, 0], idx = [];
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2, dx = Math.cos(th), dz = -Math.sin(th);
    let r = 0;
    while (r < 80 && pondE(POND.x + dx * r, POND.z + dz * r) < 1.1) r += 0.2;
    pos.push(Math.cos(th) * r, Math.sin(th) * r, 0);
    idx.push(0, 1 + i, 1 + ((i + 1) % N));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(0).flatMap(() => [0, 0, 1]), 3));
  geo.setIndex(idx);
  // Spiegelung in halber Auflösung genügt: das Wasser verzerrt sie ohnehin leicht
  const size = quality.name === 'low' ? 512 : 1024;
  const mesh = new Reflector(geo, { textureWidth: size, textureHeight: size / 2, clipBias: 0.003, multisample: 0, shader });
  mesh.material.fog = true;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(POND.x, L, POND.z);
  mesh.renderOrder = 0;
  mesh.name = 'Weiher';
  return mesh;
}

// ---------- Steg ----------
function createJetty(rnd) {
  const g = new THREE.Group();
  const plankMat = new THREE.MeshStandardMaterial({ map: woodTexture(21, [128, 112, 90]), roughness: 0.92 });
  const postMat = new THREE.MeshStandardMaterial({ map: woodTexture(33, [92, 74, 56]), roughness: 0.95 });
  const planks = [], posts = [];
  const { x0, x1, z, w, y } = JETTY;
  for (let x = x0; x < x1; x += 0.165) {
    const b = new THREE.BoxGeometry(0.15, 0.035, w + (rnd() - 0.5) * 0.06);
    b.rotateY((rnd() - 0.5) * 0.03);
    b.rotateX((rnd() - 0.5) * 0.02);
    b.translate(x, y + (rnd() - 0.5) * 0.008, z + (rnd() - 0.5) * 0.03);
    planks.push(b);
  }
  // Längsträger unter den Planken
  for (const s of [-1, 1]) posts.push(new THREE.BoxGeometry(x1 - x0, 0.14, 0.09).translate((x0 + x1) / 2, y - 0.09, z + s * 0.55));
  // Pfähle bis zum Grund; die letzten beiden ragen als Poller über den Steg
  const pileXs = [];
  for (let x = x0 + 1.2; x <= x1 - 0.05; x += 2.3) pileXs.push(x);
  pileXs.push(x1 - 0.08);
  pileXs.forEach((x, i) => {
    for (const s of [-1, 1]) {
      const pz = z + s * (w / 2 + 0.04);
      const bottom = Math.min(heightAt(x, pz), L) - 0.4;
      const top = i === pileXs.length - 1 ? y + 0.75 : y - 0.02;
      const c = new THREE.CylinderGeometry(0.085, 0.095, top - bottom, 8);
      c.translate(x, (top + bottom) / 2, pz);
      posts.push(c);
    }
  });
  // Querriegel unter dem Steg
  for (const x of pileXs) posts.push(new THREE.BoxGeometry(0.08, 0.1, w + 0.2).translate(x, y - 0.2, z));
  const pm = new THREE.Mesh(mergeGeometries(planks), plankMat);
  const sm = new THREE.Mesh(mergeGeometries(posts.map((p) => (p.index ? p.toNonIndexed() : p)).map((p) => { p.deleteAttribute('uv'); return p; })), postMat);
  for (const m of [pm, sm]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }

  // Laterne auf dem rechten Poller, leuchtet abends
  const lx = x1 - 0.08, lz = z - (w / 2 + 0.04), ly = y + 0.75;
  const metal = new THREE.MeshStandardMaterial({ color: '#2a2a28', roughness: 0.5, metalness: 0.6 });
  const lantern = new THREE.Group();
  lantern.position.set(lx, ly, lz);
  const frame = [
    new THREE.BoxGeometry(0.16, 0.02, 0.16).translate(0, 0.01, 0),
    new THREE.ConeGeometry(0.13, 0.08, 4).rotateY(Math.PI / 4).translate(0, 0.27, 0),
    new THREE.TorusGeometry(0.035, 0.008, 6, 12).translate(0, 0.33, 0),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) frame.push(new THREE.BoxGeometry(0.015, 0.22, 0.015).translate(sx * 0.07, 0.12, sz * 0.07));
  const fm = new THREE.Mesh(mergeGeometries(frame.map((p) => { const q = p.index ? p.toNonIndexed() : p; q.deleteAttribute('uv'); return q; })), metal);
  fm.castShadow = true;
  lantern.add(fm);
  const glassMat = new THREE.MeshStandardMaterial({ color: '#f3dcae', emissive: new THREE.Color('#ffb860'), emissiveIntensity: 0, roughness: 0.2, transparent: true, opacity: 0.85 });
  const glass = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.12), glassMat);
  glass.position.y = 0.12;
  lantern.add(glass);
  const lamp = new THREE.PointLight('#ffb35c', 0, 9, 2);
  lamp.position.y = 0.13;
  lantern.add(lamp);
  g.add(lantern);

  // Ein Häufchen flacher Steine am Stegende – Munition zum Flitschen
  const stoneMat = new THREE.MeshStandardMaterial({ color: '#8d8a80', roughness: 0.75 });
  const sg = new THREE.SphereGeometry(0.05, 10, 6);
  sg.scale(1, 0.32, 0.78);
  const pile = new THREE.InstancedMesh(sg, stoneMat, 9);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < 9; i++) {
    const a = rnd() * 6.28, r = rnd() * 0.12;
    p.set(x1 - 0.55 + Math.cos(a) * r, y + 0.03 + (i > 5 ? 0.018 : 0), z + 0.48 + Math.sin(a) * r);
    q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.3, rnd() * 6.28, (rnd() - 0.5) * 0.3));
    sc.setScalar(0.8 + rnd() * 0.5);
    pile.setMatrixAt(i, m4.compose(p, q, sc));
    pile.setColorAt(i, tint.setHSL(0.1, 0.05 + rnd() * 0.05, 0.4 + rnd() * 0.2));
  }
  pile.castShadow = true;
  g.add(pile);
  return { group: g, glassMat, lamp, stoneMat, stoneGeo: sg };
}

// ---------- Ruderboot ----------
function createBoat() {
  const LEN = 3.1, B = 1.15, D = 0.48, S = 18, P = 12;
  const hw = (u) => (u > 0 ? (B / 2) * Math.pow(Math.max(0, 1 - Math.pow(u, 2.2)), 0.65) : (B / 2) * (1 - 0.32 * u * u));
  const top = (u) => D + 0.1 * u * u + 0.06 * Math.max(u, 0) ** 3;
  const bot = (u) => 0.2 * Math.max(u, 0) ** 3;
  const pos = [], idx = [];
  for (let i = 0; i <= S; i++) {
    const u = -1 + (2 * i) / S;
    for (let j = 0; j <= P; j++) {
      const s = -1 + (2 * j) / P;
      const w = hw(u);
      pos.push(Math.sign(s) * Math.pow(Math.abs(s), 0.55) * w, bot(u) + (top(u) - bot(u)) * Math.pow(Math.abs(s), 2.4), (u * LEN) / 2);
    }
  }
  for (let i = 0; i < S; i++) for (let j = 0; j < P; j++) {
    const a = i * (P + 1) + j, b = a + P + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  let geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Normalen nach außen? (Seitenmitte rechts muss nach +x zeigen)
  const mid = Math.floor(S / 2) * (P + 1) + P - 1;
  if (geo.attributes.normal.getX(mid) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: '#3d6b5a', roughness: 0.8, side: THREE.FrontSide });
  const inside = new THREE.MeshStandardMaterial({ map: woodTexture(44, [150, 118, 84]), roughness: 0.9, side: THREE.BackSide });
  const outer = new THREE.Mesh(geo, paint), inner = new THREE.Mesh(geo, inside);
  // Spiegel (Heckbrett)
  const tr = new THREE.Shape();
  for (let j = 0; j <= P; j++) {
    const s = -1 + (2 * j) / P;
    const x = Math.sign(s) * Math.pow(Math.abs(s), 0.55) * hw(-1), y2 = bot(-1) + (top(-1) - bot(-1)) * Math.pow(Math.abs(s), 2.4);
    j ? tr.lineTo(x, y2) : tr.moveTo(x, y2);
  }
  const transom = new THREE.Mesh(new THREE.ShapeGeometry(tr), new THREE.MeshStandardMaterial({ color: '#3d6b5a', roughness: 0.8, side: THREE.DoubleSide }));
  transom.position.z = -LEN / 2;
  // Ruderbänke, Dollborde, Ruder
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(45, [140, 104, 70]), roughness: 0.85 });
  const parts = [];
  for (const u of [-0.62, 0.15]) parts.push(new THREE.BoxGeometry(hw(u) * 2 - 0.06, 0.035, 0.22).translate(0, top(u) - 0.16, (u * LEN) / 2));
  const oar = (sx, rot) => {
    const o = mergeGeometries([
      new THREE.CylinderGeometry(0.02, 0.02, 1.9, 6).toNonIndexed(),
      new THREE.BoxGeometry(0.13, 0.5, 0.012).translate(0, -1.05, 0).toNonIndexed(),
    ].map((p) => { p.deleteAttribute('uv'); return p; }));
    o.rotateX(Math.PI / 2 - 0.02); o.rotateY(rot);
    o.translate(sx, 0.2, -0.05);
    return o;
  };
  const woodGeo = mergeGeometries([...parts.map((p) => { const q = p.toNonIndexed(); q.deleteAttribute('uv'); return q; }), oar(0.22, 0.06), oar(-0.18, -0.08)]);
  const woodMesh = new THREE.Mesh(woodGeo, wood);
  const rimPts = (sgn) => {
    const pts = [];
    for (let i = 0; i <= S; i++) { const u = -1 + (2 * i) / S; pts.push(new THREE.Vector3(sgn * hw(u), top(u), (u * LEN) / 2)); }
    return new THREE.CatmullRomCurve3(pts);
  };
  const rimMat = new THREE.MeshStandardMaterial({ color: '#e9e2cf', roughness: 0.7 });
  for (const sgn of [-1, 1]) g.add(new THREE.Mesh(new THREE.TubeGeometry(rimPts(sgn), 40, 0.025, 6), rimMat));
  for (const m of [outer, inner, transom, woodMesh]) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
  g.userData.bow = new THREE.Vector3(0, top(1) - 0.05, LEN / 2 - 0.05);
  return g;
}

// ---------- Schilf & Rohrkolben ----------
function reedGeometry(rnd) {
  const blades = [];
  for (let b = 0; b < 9; b++) {
    const h = 1.3 + rnd() * 0.9, w = 0.042, a = rnd() * 6.28, lean = 0.12 + rnd() * 0.25;
    const pos = [], idx = [];
    const seg = 4;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg, y = t * h, off = lean * t * t * h * 0.5, ww = w * (1 - t * 0.85);
      pos.push(-ww + off, y, 0, ww + off, y, 0);
      if (i) { const k = (i - 1) * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.rotateY(a);
    g.translate((rnd() - 0.5) * 0.25, 0, (rnd() - 0.5) * 0.25);
    blades.push(g.toNonIndexed());
  }
  const merged = mergeGeometries(blades);
  merged.computeVertexNormals();
  const n = merged.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, n.getX(i) * 0.4, 0.9, n.getZ(i) * 0.4);
  // Farbverlauf: unten dunkel, oben gelblich
  const col = new Float32Array(merged.attributes.position.count * 3);
  for (let i = 0; i < merged.attributes.position.count; i++) {
    const t = merged.attributes.position.getY(i) / 2.2;
    col[i * 3] = 0.3 + t * 0.35; col[i * 3 + 1] = 0.42 + t * 0.3; col[i * 3 + 2] = 0.16 + t * 0.08;
  }
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return merged;
}

function cattailGeometry() {
  const stalk = new THREE.CylinderGeometry(0.008, 0.012, 1.9, 5).translate(0, 0.95, 0).toNonIndexed();
  const head = new THREE.CapsuleGeometry(0.03, 0.2, 3, 8).translate(0, 1.72, 0).toNonIndexed();
  const tip = new THREE.CylinderGeometry(0.003, 0.004, 0.14, 4).translate(0, 1.92, 0).toNonIndexed();
  const paint = (g, c) => {
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < g.attributes.position.count; i++) col.set(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.deleteAttribute('uv');
    return g;
  };
  return mergeGeometries([paint(stalk, [0.42, 0.5, 0.22]), paint(head, [0.32, 0.19, 0.1]), paint(tip, [0.5, 0.5, 0.3])]);
}

function createReeds(rnd) {
  const g = new THREE.Group();
  const mat = windMaterial({ vertexColors: true, side: THREE.DoubleSide }, 0.05, 0.0);
  const spots = [];
  let tries = 0;
  while (spots.length < 280 && tries++ < 9000) {
    const a = rnd() * Math.PI * 2;
    const x = POND.x + Math.cos(a) * POND.rx * (0.8 + rnd() * 0.4), z = POND.z + Math.sin(a) * POND.rz * (0.8 + rnd() * 0.4);
    const e = pondE(x, z);
    if (e < 0.85 || e > 1.12) continue;
    // Steg, Bootsplatz und Blick nach Osten frei halten
    if (x < POND.x - 12 && Math.abs(z - POND.z) < 7) continue;
    if (noise2(x / 9, z / 9) < -0.25) continue; // in Horsten statt als Saum
    spots.push([x, z]);
  }
  const reed = reedGeometry(rnd), cat = cattailGeometry();
  const im = new THREE.InstancedMesh(reed, mat, spots.length);
  const ic = new THREE.InstancedMesh(cat, mat, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  let nc = 0;
  spots.forEach(([x, z], i) => {
    const y = Math.max(heightAt(x, z), L - 0.3);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    s.setScalar(0.75 + rnd() * 0.55);
    im.setMatrixAt(i, m4.compose(p.set(x, y - 0.05, z), q, s));
    if (rnd() < 0.55) {
      for (let k = 0; k < 2; k++) {
        if (nc >= spots.length) break;
        const ox = (rnd() - 0.5) * 0.5, oz = (rnd() - 0.5) * 0.5;
        s.setScalar(0.8 + rnd() * 0.35);
        ic.setMatrixAt(nc++, m4.compose(p.set(x + ox, y - 0.05, z + oz), q, s));
      }
    }
  });
  ic.count = nc;
  for (const m of [im, ic]) { m.castShadow = true; m.receiveShadow = true; m.computeBoundingSphere(); g.add(m); }
  return g;
}

// ---------- Seerosen ----------
function createLilies(rnd) {
  const g = new THREE.Group();
  const pad = new THREE.CircleGeometry(0.22, 18, 0.3, Math.PI * 2 - 0.45).rotateX(-Math.PI / 2);
  const padMat = new THREE.MeshLambertMaterial({ color: '#4d7a33' });
  const centers = [[POND.x + 9, POND.z + 8], [POND.x + 14, POND.z - 6], [POND.x - 4, POND.z - 9], [POND.x - 9, POND.z + 9]];
  const list = [];
  for (const [cx, cz] of centers) {
    const n = 14 + Math.floor(rnd() * 10);
    for (let i = 0; i < n; i++) {
      const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 3.2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r * 0.8;
      if (pondE(x, z) > 0.86) continue;
      list.push([x, z]);
    }
  }
  const im = new THREE.InstancedMesh(pad, padMat, list.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  list.forEach(([x, z], i) => {
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
    s.setScalar(0.6 + rnd() * 0.8);
    im.setMatrixAt(i, m4.compose(p.set(x, L + 0.012, z), q, s));
    im.setColorAt(i, c.setHSL(0.24 + rnd() * 0.05, 0.45, 0.28 + rnd() * 0.12));
  });
  im.receiveShadow = true;
  g.add(im);
  // Blüten: zwei Kränze aus Blütenblättern, weiß bis zartrosa, gelbe Mitte
  const petals = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let k = 0; k < 9; k++) {
      const pg = new THREE.PlaneGeometry(0.035, 0.075).translate(0, 0.0375, 0);
      pg.rotateX(-(ring ? 0.55 : 1.05));
      pg.rotateY((k / 9) * Math.PI * 2 + ring * 0.35);
      petals.push(pg.toNonIndexed());
    }
  }
  const flower = mergeGeometries(petals.map((pg) => { pg.deleteAttribute('uv'); return pg; }));
  const flowerMat = new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide, emissive: '#3a2a30', emissiveIntensity: 0.25 });
  const nF = 11;
  const fm = new THREE.InstancedMesh(flower, flowerMat, nF);
  const core = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshLambertMaterial({ color: '#f2c531', emissive: '#4a3500' }), nF);
  for (let i = 0; i < nF; i++) {
    const [x, z] = list[Math.floor(rnd() * list.length)];
    const k = 0.9 + rnd() * 0.5;
    m4.compose(p.set(x + 0.05, L + 0.02, z + 0.05), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), s.setScalar(k));
    fm.setMatrixAt(i, m4);
    fm.setColorAt(i, c.set(rnd() < 0.4 ? '#f7c9d6' : '#fbf6f0'));
    core.setMatrixAt(i, m4);
  }
  g.add(fm, core);
  return g;
}

// ---------- Trauerweide ----------
function createWillow(x, z, rnd) {
  const g = new THREE.Group();
  const y0 = heightAt(x, z) - 0.15;
  g.position.set(x, y0, z);
  const barkMat = windMaterial({ color: '#6a5a48' }, 0.004, 2.5, { bark: true });
  // Stamm neigt sich zum Wasser (nach Süden/Osten)
  const lean = new THREE.Vector3(0.45, 0, -0.75).normalize();
  const trunkPts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    trunkPts.push(new THREE.Vector3(lean.x * t * t * 2.2, t * 4.6, lean.z * t * t * 2.2));
  }
  const trunkCurve = new THREE.CatmullRomCurve3(trunkPts);
  const trunk = new THREE.TubeGeometry(trunkCurve, 16, 0.32, 10);
  // nach oben dünner
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const t = clamp(tp.getY(i) / 4.6, 0, 1);
    const c = trunkCurve.getPoint(t);
    const k = 1 - t * 0.45 + Math.max(0, 0.15 - t) * 1.5;
    tp.setX(i, c.x + (tp.getX(i) - c.x) * k);
    tp.setZ(i, c.z + (tp.getZ(i) - c.z) * k);
  }
  trunk.computeVertexNormals();
  const woods = [trunk];
  const top = trunkCurve.getPoint(1);
  // Hauptäste: wölben sich nach oben und außen
  const tips = [];
  const NB = 14;
  for (let b = 0; b < NB; b++) {
    const a = (b / NB) * Math.PI * 2 + rnd() * 0.4;
    const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).add(lean.clone().multiplyScalar(0.5)).normalize();
    const len = 2.6 + rnd() * 1.6;
    const p0 = top.clone().add(new THREE.Vector3(0, -0.4 - rnd() * 0.8, 0));
    const p1 = p0.clone().addScaledVector(dir, len * 0.45).add(new THREE.Vector3(0, 1.4 + rnd() * 0.8, 0));
    const p2 = p0.clone().addScaledVector(dir, len).add(new THREE.Vector3(0, -0.1 + rnd() * 0.5, 0)); // Astenden hängen
    const curve = new THREE.QuadraticBezierCurve3(p0, p1, p2);
    woods.push(new THREE.TubeGeometry(curve, 8, 0.075, 5));
    for (let k = 0; k < 24; k++) tips.push(curve.getPoint(0.15 + rnd() * 0.85).add(new THREE.Vector3((rnd() - 0.5) * 1.1, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 1.1)));
    // kurze Büschel direkt auf dem Bogen, damit der Ast im Laub verschwindet
    for (let k = 0; k < 12; k++) { const pt = curve.getPoint(k / 11).add(new THREE.Vector3((rnd() - 0.5) * 0.5, 0.25, (rnd() - 0.5) * 0.5)); pt.short = true; tips.push(pt); }
  }
  const wood = new THREE.Mesh(mergeGeometries(woods.map((w) => { w.deleteAttribute('uv'); return w.toNonIndexed(); })), barkMat);
  wood.castShadow = true; wood.receiveShadow = true;
  g.add(wood);

  // Hängende Zweige: schmale Blattbänder, die bis knapp übers Wasser fallen
  const pos = [], uv = [], hang = [], col = [];
  const cA = new THREE.Color('#b3c466'), cB = new THREE.Color('#7f9a40'), cc = new THREE.Color();
  for (const tp0 of tips) {
    const yWorld = y0 + tp0.y;
    const floor = Math.max(L + 0.25, heightAt(x + tp0.x, z + tp0.z) + 0.3);
    const len = Math.min(tp0.y - (floor - y0), tp0.short ? 0.9 + rnd() * 0.8 : 3 + rnd() * 4);
    if (len < 0.8) continue;
    const w = 0.55 + rnd() * 0.4, seg = 7, a = rnd() * 6.28;
    const ax = Math.cos(a) * w / 2, az = Math.sin(a) * w / 2;
    const out = new THREE.Vector3(tp0.x, 0, tp0.z).normalize().multiplyScalar(0.4);
    // Ansatz leicht nach oben, damit der Ast unter den Blättern verschwindet
    tp0.y += 0.35;
    cc.copy(cA).lerp(cB, rnd());
    for (let i = 0; i < seg; i++) {
      const t0 = i / seg, t1 = (i + 1) / seg;
      const P = (t, s) => [tp0.x + out.x * t * t + s * ax * (1 - t * 0.5), tp0.y - t * len, tp0.z + out.z * t * t + s * az * (1 - t * 0.5)];
      const q = [P(t0, -1), P(t0, 1), P(t1, -1), P(t0, 1), P(t1, 1), P(t1, -1)];
      const qt = [t0, t0, t1, t0, t1, t1], qu = [0, 1, 0, 1, 1, 0];
      for (let k = 0; k < 6; k++) {
        pos.push(...q[k]);
        uv.push(qu[k] * 0.5, qt[k] * len * 0.45);
        hang.push(qt[k] * len);
        col.push(cc.r, cc.g, cc.b);
      }
    }
    void yWorld;
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  lg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  lg.setAttribute('aHang', new THREE.Float32BufferAttribute(hang, 1));
  lg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < nrm.length; i += 3) nrm[i + 1] = 1;
  lg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const map = leafTexture();
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const leafMat = new THREE.MeshLambertMaterial({ map, vertexColors: true, alphaTest: 0.42, side: THREE.DoubleSide });
  leafMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; attribute float aHang;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Zweige pendeln im Wind, unten am stärksten
        float k = aHang * aHang * 0.025;
        float ph = position.x * 0.7 + position.z * 0.5;
        transformed.x += (sin(uTime * 0.9 + ph) * 0.8 + sin(uTime * 2.1 + ph * 2.0) * 0.25) * k;
        transformed.z += cos(uTime * 0.7 + ph) * 0.6 * k;`);
  };
  const leaves = new THREE.Mesh(lg, leafMat);
  leaves.castShadow = true; leaves.receiveShadow = true;
  g.add(leaves);
  return { group: g, obstacle: { x, z, r: 0.55 } };
}

// ---------- Enten ----------
function createDuck(drake) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), new THREE.MeshStandardMaterial({ color: drake ? '#8f8a80' : '#8a6a48', roughness: 0.85 }));
  body.scale.set(0.85, 0.6, 1.45);
  body.position.y = 0.04;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshStandardMaterial({ color: drake ? '#6a3e2a' : '#7d5f40', roughness: 0.85 }));
  chest.position.set(0, 0.07, 0.12);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 8), body.material);
  tail.rotation.x = -2.0; tail.position.set(0, 0.1, -0.2);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 8), new THREE.MeshStandardMaterial({ color: drake ? '#1e5230' : '#7d5f40', roughness: 0.5, metalness: drake ? 0.2 : 0 }));
  neck.position.set(0, 0.16, 0.15); neck.rotation.x = 0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), neck.material);
  head.scale.set(0.85, 0.9, 1.15);
  head.position.set(0, 0.25, 0.18);
  const beak = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.018, 0.07), new THREE.MeshStandardMaterial({ color: drake ? '#d9b230' : '#c47a2a', roughness: 0.6 }));
  beak.position.set(0, 0.235, 0.255);
  const ring = drake ? new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.007, 6, 14), new THREE.MeshStandardMaterial({ color: '#f2f0e8' })) : null;
  if (ring) { ring.rotation.x = Math.PI / 2 - 0.25; ring.position.set(0, 0.11, 0.135); }
  for (const m of [body, chest, tail, neck, head, beak, ring]) if (m) { m.castShadow = true; g.add(m); }
  return g;
}

// ---------- Wegweiser am Abzweig ----------
function signTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f2ead8'; g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#2e5a35'; g.lineWidth = 10; g.strokeRect(8, 8, 496, 112);
  g.fillStyle = '#2e5a35';
  g.font = '700 58px Georgia, serif';
  g.textBaseline = 'middle';
  g.fillText('Weiher', 40, 66);
  g.font = '500 34px Georgia, serif';
  g.fillText('0,1 km', 300, 68);
  g.beginPath(); g.moveTo(430, 40); g.lineTo(480, 64); g.lineTo(430, 88); g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function createSign() {
  const P = BRANCH.pts;
  const [ax, az] = P[4], [bx, bz] = P[9];
  const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
  // links vom Abzweig, Schild zeigt die Abzweigrichtung
  const nx = -dz / l, nz = dx / l;
  const x = ax + nx * 2.8, z = az + nz * 2.8;
  const g = new THREE.Group();
  g.position.set(x, heightAt(x, z), z);
  const postMat = new THREE.MeshStandardMaterial({ map: woodTexture(61, [110, 86, 60]), roughness: 0.9 });
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.1, 0.1).translate(0, 1.05, 0), postMat);
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.27, 0.035), [postMat, postMat, postMat, postMat, new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.8 }), new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.8 })]);
  board.position.set(0.5, 1.8, 0);
  const arm = new THREE.Group();
  arm.add(board);
  // Schild in Abzweigrichtung drehen (lokales +x zeigt den Weg entlang)
  arm.rotation.y = Math.atan2(-dz, dx);
  g.add(post, arm);
  for (const m of [post, board]) { m.castShadow = true; m.receiveShadow = true; }
  return { group: g, obstacle: { x, z, r: 0.35 } };
}

// ---------- Spritzer ----------
class Splashes {
  constructor(max = 160) {
    this.max = max; this.i = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3); this.life = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.alpha = new Float32Array(max);
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: 'attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = 60.0 / -mv.z; gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5 || vA < 0.01) discard; gl_FragColor = vec4(vec3(0.92, 0.95, 0.97), vA * smoothstep(0.5, 0.2, d)); }',
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }
  burst(x, z, n, power) {
    for (let k = 0; k < n; k++) {
      const i = this.i; this.i = (this.i + 1) % this.max;
      const a = Math.random() * 6.28, h = Math.random() * 0.8 * power;
      this.pos.set([x, L + 0.02, z], i * 3);
      this.vel.set([Math.cos(a) * h, (1.2 + Math.random() * 1.8) * power, Math.sin(a) * h], i * 3);
      this.life[i] = 0.5 + Math.random() * 0.4;
    }
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.81 * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      if (this.pos[i * 3 + 1] < L) this.life[i] = 0;
      this.alpha[i] = Math.min(1, this.life[i] * 3) * 0.85;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true; a.aAlpha.needsUpdate = true;
  }
}

// ======================================================================
export function createPond(quality, audio) {
  const rnd = seeded(2718);
  const group = new THREE.Group();
  group.name = 'Weiher';
  const obstacles = [];

  const water = createWater(quality);
  group.add(water);
  const U = water.material.uniforms;
  U.uTime = shared.uTime;

  const jetty = createJetty(rnd);
  group.add(jetty.group);
  const boat = createBoat();
  const boatBase = new THREE.Vector3(JETTY.x1 - 2.6, L - 0.14, JETTY.z - JETTY.w / 2 - 0.75);
  boat.position.copy(boatBase);
  boat.rotation.y = Math.PI / 2 + 0.06; // Bug zeigt aufs Wasser hinaus
  group.add(boat);
  // Leine vom Bug zum Poller
  const bowW = boat.localToWorld(boat.userData.bow.clone());
  const post = new THREE.Vector3(JETTY.x1 - 0.08, JETTY.y + 0.55, JETTY.z - JETTY.w / 2 - 0.04);
  const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(bowW, bowW.clone().lerp(post, 0.5).add(new THREE.Vector3(0, -0.35, 0)), post), 16, 0.012, 5), new THREE.MeshStandardMaterial({ color: '#b9a57e', roughness: 1 }));
  group.add(rope);

  group.add(createReeds(rnd));
  group.add(createLilies(rnd));
  const willow = createWillow(122.5, 89.5, rnd);
  group.add(willow.group);
  obstacles.push(willow.obstacle);
  const willow2 = createWillow(153, 54, seeded(91));
  willow2.group.rotation.y = Math.PI * 0.9;
  willow2.group.scale.setScalar(0.85);
  group.add(willow2.group);
  obstacles.push(willow2.obstacle);
  const sign = createSign();
  group.add(sign.group);
  obstacles.push(sign.obstacle);
  // Steg ist für den Traktor tabu
  for (let x = JETTY.x0 + 0.5; x < JETTY.x1; x += 1.2) obstacles.push({ x, z: JETTY.z, r: 0.75 });

  // Enten
  const ducks = [true, false, false].map((drake, i) => {
    const d = createDuck(drake);
    group.add(d);
    return { mesh: d, s: i * 2.1 + 0.4, speed: 0.05 + i * 0.012, flee: 0, fleeDir: new THREE.Vector2(), off: new THREE.Vector2(), lastRipple: 0 };
  });
  const duckPath = (d, t) => {
    const a = t * d.speed + d.s;
    return new THREE.Vector2(POND.x + 3 + Math.cos(a) * POND.rx * 0.5 + Math.sin(a * 2.3) * 2.5, POND.z + 2 + Math.sin(a) * POND.rz * 0.42 + Math.cos(a * 1.7) * 1.5);
  };

  // Fisch, der ab und zu springt
  const fish = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 6), new THREE.MeshStandardMaterial({ color: '#9aa3a0', roughness: 0.3, metalness: 0.5 }));
  fish.scale.set(0.5, 0.8, 2.6);
  fish.visible = false;
  group.add(fish);
  const fishState = { next: 5 + Math.random() * 6, t: -1, a: new THREE.Vector3(), b: new THREE.Vector3() };

  const splashes = new Splashes();
  group.add(splashes.points);

  // Wellenringe als Ringpuffer
  let rip = 0;
  const ripple = (x, z, amp) => {
    U.uRipples.value[rip].set(x, z, shared.uTime.value, amp);
    rip = (rip + 1) % MAX_RIPPLES;
  };

  // ---------- Steine flitschen ----------
  const stones = [];
  const stoneMesh = () => {
    const m = new THREE.Mesh(jetty.stoneGeo, jetty.stoneMat);
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const hand = stoneMesh();
  hand.visible = false;
  let onResult = () => {};
  const camDist = (x, z, cam) => Math.hypot(cam.position.x - x, cam.position.z - z);
  let lastCam = null;

  function throwStone(origin, dir, power) {
    const speed = 7 + 12 * power;
    const d = dir.clone().normalize();
    const v = d.clone().multiplyScalar(speed);
    v.y += 0.6; // leichter Bogen aus dem Handgelenk
    // Wer nicht zum Horizont zielt, kippt den Stein: steil nach unten oder oben springt er schlechter
    const pitch = THREE.MathUtils.radToDeg(Math.asin(d.y));
    const tilt = Math.max(0, Math.abs(pitch + 1) - 4) * 0.02;
    stones.push({ m: stoneMesh(), p: origin.clone(), v, skips: 0, lim: Math.max(0.05, 0.36 - tilt), spin: 25 + power * 25, done: false, t: 0 });
    audio?.whoosh?.(power);
  }

  function finish(s, skips) {
    s.done = true;
    onResult(skips);
  }

  function updateStones(dt, cam) {
    for (const s of stones) {
      if (s.done) { s.t += dt; if (s.t > 1.5) { group.remove(s.m); s.dead = true; } continue; }
      s.v.y -= 9.81 * dt;
      s.p.addScaledVector(s.v, dt);
      s.m.position.copy(s.p);
      s.m.rotation.y += s.spin * dt;
      const ground = heightAt(s.p.x, s.p.z);
      if (s.p.y <= ground + 0.02 && ground > L - 0.02) { // am Ufer gelandet
        s.p.y = ground + 0.02; s.m.position.copy(s.p);
        audio?.clunk?.(0.12);
        finish(s, s.skips);
        continue;
      }
      if (s.p.y <= L && s.v.y < 0) {
        const vh = Math.hypot(s.v.x, s.v.z);
        const angle = Math.atan2(-s.v.y, vh);
        const gain = clamp(1 - camDist(s.p.x, s.p.z, cam) / 70, 0.15, 1);
        if (angle < s.lim * (0.75 + 0.5 * Math.random()) && vh > 3.2) {
          s.skips++;
          s.v.y = -s.v.y * (0.5 + Math.random() * 0.2);
          const loss = 0.66 + Math.random() * 0.16;
          s.v.x *= loss; s.v.z *= loss;
          s.p.y = L + 0.001;
          ripple(s.p.x, s.p.z, 0.45);
          splashes.burst(s.p.x, s.p.z, 5, 0.6);
          audio?.waterSkip?.(gain);
          // Enten in der Nähe flattern davon
          for (const d of ducks) {
            const dd = Math.hypot(d.mesh.position.x - s.p.x, d.mesh.position.z - s.p.z);
            if (dd < 2.2 && d.flee <= 0) {
              d.flee = 3.5;
              d.fleeDir.set(d.mesh.position.x - s.p.x, d.mesh.position.z - s.p.z).normalize();
              audio?.quack?.(gain);
            }
          }
        } else {
          ripple(s.p.x, s.p.z, 1);
          splashes.burst(s.p.x, s.p.z, 16, 1);
          audio?.plop?.(gain);
          s.m.visible = false;
          finish(s, s.skips);
        }
      }
    }
    for (let i = stones.length - 1; i >= 0; i--) if (stones[i].dead) stones.splice(i, 1);
  }

  // Sitzplatz am Stegende: Beine baumeln überm Wasser, Blick nach Osten über den Weiher
  const seatWorld = new THREE.Vector3(JETTY.x1 - 0.35, JETTY.y + 0.82, JETTY.z + 0.15);
  const lookWorld = new THREE.Vector3(JETTY.x1 + 20, L + 0.6, JETTY.z - 1.5);
  const parkWorld = new THREE.Vector3(POND_PARK.x, heightAt(POND_PARK.x, POND_PARK.z), POND_PARK.z);

  // Spiegelung: nur in der Nähe in voller Rate rendern, Gras & Spuren dabei weglassen
  const hide = [];
  let frame = 0;
  const baseBefore = water.onBeforeRender;
  water.onBeforeRender = function (renderer, scene, camera) {
    frame++;
    const d = camDist(POND.x, POND.z, camera);
    if (d > 420) return;
    if (d > 130 && frame % 3 !== 0) return;
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    baseBefore.call(this, renderer, scene, camera);
    hide.forEach((o, i) => (o.visible = vis[i]));
  };

  function update(dt, t, camera, atm) {
    lastCam = camera;
    // Licht & Himmel aus der Atmosphäre übernehmen
    if (atm) {
      const st = atm.state;
      U.uSunDir.value.copy(atm.sunVec);
      U.uSunColor.value.copy(st.sunColor);
      U.uSunPow.value = Math.min(st.sunIntensity / 3, 1.2) * smoothstep(-1, 4, st.sunEl);
      U.uSkyH.value.copy(st.horizon).multiplyScalar(1.1);
      U.uSkyT.value.copy(st.top);
      U.uDeep.value.copy(st.hemiGround).multiplyScalar(0.32).lerp(new THREE.Color('#14201a'), 0.5);
      const night = shared.uNight.value;
      jetty.glassMat.emissiveIntensity = smoothstep(0.3, 0.9, night) * 3.2;
      jetty.lamp.intensity = smoothstep(0.3, 0.9, night) * 2.2;
    }
    // Boot schaukelt
    boat.position.y = boatBase.y + Math.sin(t * 0.9) * 0.018;
    boat.rotation.z = Math.sin(t * 0.7 + 1) * 0.025;
    boat.rotation.x = Math.sin(t * 0.55) * 0.012;

    // Enten
    for (const d of ducks) {
      const p = duckPath(d, t);
      if (d.flee > 0) { d.flee -= dt; d.off.addScaledVector(d.fleeDir, dt * 1.4 * Math.min(d.flee, 1)); }
      else d.off.multiplyScalar(1 - dt * 0.05);
      p.add(d.off);
      // nicht ans Ufer schwimmen
      if (pondE(p.x, p.y) > 0.78) d.off.multiplyScalar(1 - dt * 0.8);
      const ahead = duckPath(d, t + 0.5).add(d.off);
      d.mesh.position.set(p.x, L - 0.01 + Math.sin(t * 2 + d.s) * 0.006, p.y);
      d.mesh.rotation.y = Math.atan2(ahead.x - p.x, ahead.y - p.y);
      d.mesh.rotation.z = Math.sin(t * 1.6 + d.s) * 0.04;
      if (t - d.lastRipple > 1.3) { d.lastRipple = t; ripple(p.x, p.y, 0.12); }
    }

    // Fisch
    fishState.next -= dt;
    if (fishState.t < 0 && fishState.next < 0) {
      let x, z;
      do { x = POND.x + (Math.random() - 0.5) * POND.rx * 1.3; z = POND.z + (Math.random() - 0.5) * POND.rz * 1.3; } while (pondE(x, z) > 0.7);
      const a = Math.random() * 6.28;
      fishState.a.set(x, L, z);
      fishState.b.set(x + Math.cos(a) * 0.9, L, z + Math.sin(a) * 0.9);
      fishState.t = 0;
      ripple(x, z, 0.5);
      splashes.burst(x, z, 6, 0.5);
      if (camera) audio?.plop?.(clamp(1 - camDist(x, z, camera) / 60, 0, 0.6), true);
    }
    if (fishState.t >= 0) {
      fishState.t += dt / 0.65;
      const k = fishState.t;
      fish.visible = k < 1;
      fish.position.lerpVectors(fishState.a, fishState.b, k);
      fish.position.y = L + Math.sin(k * Math.PI) * 0.5;
      fish.lookAt(fishState.b.x, L + Math.cos(k * Math.PI) * 0.6, fishState.b.z);
      if (k >= 1) {
        fishState.t = -1;
        fishState.next = 6 + Math.random() * 10;
        ripple(fishState.b.x, fishState.b.z, 0.7);
        splashes.burst(fishState.b.x, fishState.b.z, 10, 0.7);
        if (camera) audio?.plop?.(clamp(1 - camDist(fishState.b.x, fishState.b.z, camera) / 60, 0, 0.7), true);
      }
    }

    if (camera) updateStones(dt, camera);
    splashes.update(dt);
  }

  // Stein in der Hand (rechts unten im Bild), solange man zielt
  function showHand(camera, charge) {
    if (charge === null) { hand.visible = false; return; }
    hand.visible = true;
    const off = new THREE.Vector3(0.2, -0.17 - charge * 0.04, -0.45 + charge * 0.12).applyQuaternion(camera.quaternion);
    hand.position.copy(camera.position).add(off);
    hand.quaternion.copy(camera.quaternion);
    hand.rotateX(-0.25);
  }

  return {
    group, obstacles, seatWorld, lookWorld, parkWorld, hide, ripple,
    update, throwStone, showHand,
    set onResult(fn) { onResult = fn; },
    get busy() { return stones.some((s) => !s.done); },
    get lastCam() { return lastCam; },
  };
}
