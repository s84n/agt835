import * as THREE from 'three';
import { meshHeightAt, pathDist } from './terrain.js';

// Reifenspuren, performanceschonend:
//  - alle Spuren liegen in EINEM Mesh mit Ringpuffer; pro neuem Stück werden nur
//    6 Vertices hochgeladen, das Verblassen rechnet der Shader (keine CPU pro Frame)
//  - eine kleine Spurkarte (256×256 für 240×240 m) drückt das Gras auf gefahrenen
//    Bahnen dauerhaft nieder und verblasst langsam wieder

const SEG = 0.32;      // Länge eines Spurstücks in m
const WIDTH = 0.3;     // Reifenbreite
const LIFE = 150;      // Sekunden bis eine Spur verschwunden ist
const MAP_SIZE = 256, MAP_WORLD = 240;

function treadTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  // weicher Grundabdruck
  const grd = g.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.2, 'rgba(150,150,150,1)');
  grd.addColorStop(0.8, 'rgba(150,150,150,1)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 128);
  g.fillStyle = grd; g.fillRect(0, 0, 64, 128);
  // Stollenabdrücke als Chevron (wie die AS-Bereifung)
  g.fillStyle = 'rgba(255,255,255,1)';
  for (let y = -16; y < 144; y += 32) {
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(32, y + 12);
      g.lineTo(32 + s * 28, y);
      g.lineTo(32 + s * 28, y + 9);
      g.lineTo(32, y + 21);
      g.closePath(); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

export class TireTracks {
  constructor(maxQuads = 3000) {
    this.max = maxQuads;
    this.cursor = 0;
    const n = maxQuads * 6;
    this.pos = new Float32Array(n * 3);
    this.uv = new Float32Array(n * 2);
    this.birth = new Float32Array(n).fill(-1e6);
    this.strength = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage);
    this.aBirth = new THREE.BufferAttribute(this.birth, 1).setUsage(THREE.DynamicDrawUsage);
    this.aStr = new THREE.BufferAttribute(this.strength, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('uv', this.aUv);
    g.setAttribute('aBirth', this.aBirth);
    g.setAttribute('aStrength', this.aStr);
    const nrm = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));

    this.uTime = { value: 0 };
    const mat = new THREE.MeshLambertMaterial({
      color: '#4a3721', alphaMap: treadTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; attribute float aBirth; attribute float aStrength; varying float vFade;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float age = uTime - aBirth;
          vFade = aStrength * (1.0 - smoothstep(${(LIFE * 0.35).toFixed(1)}, ${LIFE.toFixed(1)}, age)) * smoothstep(0.0, 0.25, age);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <alphamap_fragment>', `#ifdef USE_ALPHAMAP
            diffuseColor.a *= texture2D(alphaMap, vAlphaMapUv).g;
          #endif
          diffuseColor.a *= vFade;`);
    };
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;

    this.wheels = [];

    // Spurkarte fürs Gras
    this.mapData = new Uint8Array(MAP_SIZE * MAP_SIZE);
    this.map = new THREE.DataTexture(this.mapData, MAP_SIZE, MAP_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    this.map.magFilter = THREE.LinearFilter;
    this.map.minFilter = THREE.LinearFilter;
    this.map.needsUpdate = true;
    this.mapDirty = false;
    this.mapTimer = 0;
    this.fadeTimer = 0;
  }

  reset() {
    this.birth.fill(-1e6);
    this.aBirth.needsUpdate = true;
    this.mapData.fill(0);
    this.map.needsUpdate = true;
    this.wheels = [];
  }

  // points: Aufstandspunkte der Räder (Weltkoordinaten)
  update(dt, time, points, moving) {
    this.uTime.value = time;
    if (moving) points.forEach((p, i) => this.track(i, p.x, p.z, time));

    // Spurkarte gedrosselt hochladen und langsam verblassen lassen
    this.mapTimer += dt; this.fadeTimer += dt;
    if (this.fadeTimer > 3) {
      this.fadeTimer = 0;
      const d = this.mapData;
      let any = false;
      for (let i = 0; i < d.length; i++) if (d[i]) { d[i] = (d[i] * 0.97) | 0; any = true; }
      if (any) this.mapDirty = true;
    }
    if (this.mapDirty && this.mapTimer > 0.2) {
      this.mapTimer = 0; this.mapDirty = false;
      this.map.needsUpdate = true;
    }
  }

  track(id, x, z, time) {
    const w = this.wheels[id];
    if (!w) { this.wheels[id] = { x, z, l: null, r: null, v: 0 }; return; }
    const dx = x - w.x, dz = z - w.z;
    const d = Math.hypot(dx, dz);
    if (d > 3) { this.wheels[id] = { x, z, l: null, r: null, v: 0 }; return; } // Sprung (z. B. Reset)
    if (d < SEG) return;
    const px = -dz / d * WIDTH / 2, pz = dx / d * WIDTH / 2;
    const l = [x + px, z + pz], r = [x - px, z - pz];
    if (w.l) this.addQuad(w.l, w.r, l, r, w.v, w.v + d / 0.9, time, pathDist(x, z) < 2 ? 0.8 : 0.5);
    w.x = x; w.z = z; w.l = l; w.r = r; w.v += d / 0.9;
    this.stamp(x, z);
  }

  addQuad(l0, r0, l1, r1, v0, v1, time, strength) {
    const q = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const verts = [[l0, 0, v0], [r0, 1, v0], [l1, 0, v1], [r0, 1, v0], [r1, 1, v1], [l1, 0, v1]];
    verts.forEach(([p, u, v], k) => {
      const i = q * 6 + k;
      this.pos[i * 3] = p[0];
      this.pos[i * 3 + 1] = meshHeightAt(p[0], p[1]) + 0.025;
      this.pos[i * 3 + 2] = p[1];
      this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
      this.birth[i] = time;
      this.strength[i] = strength;
    });
    for (const [a, size] of [[this.aPos, 3], [this.aUv, 2], [this.aBirth, 1], [this.aStr, 1]]) {
      a.addUpdateRange(q * 6 * size, 6 * size); // three.js leert die Liste nach dem Upload selbst
      a.needsUpdate = true;
    }
  }

  stamp(x, z) {
    const cx = (x / MAP_WORLD + 0.5) * MAP_SIZE, cz = (z / MAP_WORLD + 0.5) * MAP_SIZE;
    const R = 1.2;
    for (let j = Math.floor(cz - R); j <= Math.ceil(cz + R); j++) {
      for (let i = Math.floor(cx - R); i <= Math.ceil(cx + R); i++) {
        if (i < 0 || j < 0 || i >= MAP_SIZE || j >= MAP_SIZE) continue;
        const f = 1 - Math.hypot(i - cx, j - cz) / (R + 0.5);
        if (f <= 0) continue;
        const k = j * MAP_SIZE + i;
        this.mapData[k] = Math.max(this.mapData[k], Math.min(255, f * 320) | 0);
      }
    }
    this.mapDirty = true;
  }
}

export const TRACK_MAP_WORLD = MAP_WORLD;
