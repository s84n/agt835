import * as THREE from 'three';
import { heightAt } from './terrain.js';
import { seeded } from './noise.js';
import { shared } from './vegetation.js';

// Schmetterlinge (tagsüber) und Glühwürmchen (abends). Bewegung komplett im Shader:
// keine CPU-Arbeit pro Frame, je ein Draw Call.

const FOG_PARS_V = THREE.ShaderChunk.fog_pars_vertex, FOG_V = THREE.ShaderChunk.fog_vertex;
const FOG_PARS_F = THREE.ShaderChunk.fog_pars_fragment, FOG_F = THREE.ShaderChunk.fog_fragment;

// ---------- Glühwürmchen ----------
export function createFireflies(count = 140, radius = 26) {
  const rnd = seeded(404);
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2, r = 3 + Math.sqrt(rnd()) * radius;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    pos[i * 3] = x; pos[i * 3 + 1] = heightAt(x, z) + 0.3 + rnd() * 1.6; pos[i * 3 + 2] = z;
    seed[i] = rnd() * 100;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uNight: { value: 0 } }]),
    vertexShader: `
      uniform float uTime, uNight; attribute float aSeed; varying float vGlow;
      ${FOG_PARS_V}
      void main() {
        vec3 p = position;
        float t = uTime * 0.35 + aSeed;
        p += vec3(sin(t * 1.3) * 1.4 + sin(t * 0.4) * 2.0, sin(t * 0.9) * 0.45, cos(t * 1.1) * 1.4 + cos(t * 0.3) * 2.0);
        // Blinken: langes Glimmen, kurze Pausen, jedes Tier im eigenen Takt
        float blink = smoothstep(0.15, 0.6, sin(uTime * (0.7 + fract(aSeed) * 0.9) + aSeed * 7.0) * 0.5 + 0.5);
        vGlow = blink * smoothstep(0.35, 0.9, uNight);
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (vGlow > 0.01 ? 150.0 : 0.0) / -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
        ${FOG_V}
      }`,
    fragmentShader: `
      varying float vGlow;
      ${FOG_PARS_F}
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float core = smoothstep(0.12, 0.0, d), halo = smoothstep(0.5, 0.0, d) * 0.35;
        gl_FragColor = vec4(vec3(0.85, 1.0, 0.35) * 3.0 * (core + halo), (core + halo) * vGlow);
        if (gl_FragColor.a < 0.01) discard;
        ${FOG_F}
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  });
  mat.uniforms.uTime = shared.uTime;
  mat.uniforms.uNight = shared.uNight;
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 6;
  return pts;
}

// ---------- Schmetterlinge ----------
function wingTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  // Vorder- und Hinterflügel (rechte Hälfte, wird gespiegelt)
  g.beginPath(); g.ellipse(36, 22, 26, 18, -0.35, 0, 7); g.fill();
  g.beginPath(); g.ellipse(30, 46, 17, 14, 0.4, 0, 7); g.fill();
  // dunkle Flügelspitze / Punkt
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(40,30,20,0.85)';
  g.beginPath(); g.ellipse(56, 12, 10, 8, -0.35, 0, 7); g.fill();
  g.beginPath(); g.arc(38, 26, 4, 0, 7); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createButterflies(count = 26, radius = 22) {
  const rnd = seeded(808);
  // Ein Flügelpaar: zwei Quads, an der Körperachse (x = 0) angelenkt
  const W = 0.07;
  const posArr = [], uvArr = [], side = [];
  for (const s of [-1, 1]) {
    const quad = [[0, -W], [s * W * 1.3, -W], [s * W * 1.3, W], [0, -W], [s * W * 1.3, W], [0, W]];
    for (const [x, z] of quad) {
      posArr.push(x, 0, z);
      uvArr.push(Math.abs(x) / (W * 1.3), (z + W) / (2 * W));
      side.push(s);
    }
  }
  const base = new THREE.InstancedBufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  base.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
  base.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  const home = new Float32Array(count * 4), col = new Float32Array(count * 3);
  const palette = [[1, 1, 0.96], [1, 1, 0.96], [1, 0.92, 0.35], [0.95, 0.55, 0.2], [0.75, 0.85, 1]];
  for (let i = 0; i < count; i++) {
    const a = rnd() * Math.PI * 2, r = 2 + Math.sqrt(rnd()) * radius;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    home[i * 4] = x; home[i * 4 + 1] = heightAt(x, z); home[i * 4 + 2] = z; home[i * 4 + 3] = rnd() * 100;
    const c = palette[Math.floor(rnd() * palette.length)];
    col.set(c, i * 3);
  }
  base.setAttribute('aHome', new THREE.InstancedBufferAttribute(home, 4));
  base.setAttribute('aColor', new THREE.InstancedBufferAttribute(col, 3));
  base.instanceCount = count;

  const mat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uNight: { value: 0 }, map: { value: wingTexture() } }]),
    vertexShader: `
      uniform float uTime, uNight; attribute float aSide; attribute vec4 aHome; attribute vec3 aColor;
      varying vec2 vUv; varying vec3 vColor; varying float vVis;
      ${FOG_PARS_V}
      vec3 path(float t, float s) {
        return vec3(sin(t * 0.37 + s) * 2.6 + sin(t * 0.91 + s * 2.0) * 1.1,
                    0.55 + sin(t * 0.73 + s * 3.0) * 0.3 + sin(t * 2.1 + s) * 0.08,
                    cos(t * 0.29 + s) * 2.6 + cos(t * 0.83 + s * 1.7) * 1.1);
      }
      void main() {
        vUv = uv; vColor = aColor;
        vVis = 1.0 - smoothstep(0.2, 0.6, uNight);
        float s = aHome.w, t = uTime + s * 10.0;
        vec3 c = aHome.xyz + path(t, s);
        vec3 ahead = aHome.xyz + path(t + 0.1, s);
        vec3 dir = normalize(ahead - c + vec3(0.0001));
        float yaw = atan(dir.x, dir.z);
        // Flügelschlag: schnell, mit kurzen Gleitphasen
        float glide = smoothstep(0.6, 0.9, sin(t * 0.8 + s));
        float flap = mix(sin(t * 22.0 + s) * 1.05, 0.25, glide);
        vec3 p = position;
        float ang = flap * aSide;
        p = vec3(p.x * cos(ang), abs(p.x) * sin(abs(ang)) * sign(flap + 0.0001), p.z);
        float cy = cos(yaw), sy = sin(yaw);
        p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
        vec4 mvPosition = viewMatrix * vec4(c + p * vVis, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        ${FOG_V}
      }`,
    fragmentShader: `
      uniform sampler2D map; varying vec2 vUv; varying vec3 vColor; varying float vVis;
      ${FOG_PARS_F}
      void main() {
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.5 || vVis < 0.01) discard;
        vec3 c = mix(vec3(0.12, 0.09, 0.06), vColor, t.r);
        gl_FragColor = vec4(c, 1.0);
        ${FOG_F}
      }`,
    side: THREE.DoubleSide, fog: true,
  });
  mat.uniforms.uTime = shared.uTime;
  mat.uniforms.uNight = shared.uNight;
  const mesh = new THREE.Mesh(base, mat);
  mesh.frustumCulled = false;
  return mesh;
}
