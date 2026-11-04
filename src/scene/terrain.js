import * as THREE from 'three';
import { fbm, noise2, smoothstep, lerp, clamp, hash2, seeded } from './noise.js';
import { groundTextures } from './textures.js';

// Landschaft nach den Fotos: Streuobstwiese am Hang (um den Ursprung), das Tal mit Dorf
// Richtung -Z und gegenüber der bewaldete Albtrauf mit Kegelberg und Felsnase.

const H0 = rawHeight(0, 0);

function rawHeight(x, z) {
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
export function pathDist(x, z) {
  if (z < PATH_Z[0] - 4 || z > PATH_Z[1] + 4) return 999;
  return Math.abs(x - pathX(z));
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

export function createTerrain(quality) {
  const R = 1300;
  const seg = quality.terrainSeg;
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

  const W = 3.0, step = 1.0;
  const verts = [], uvs = [], idx = [];
  let v = 0, n = 0;
  for (let z = PATH_Z[0]; z <= PATH_Z[1]; z += step) {
    const x = pathX(z);
    const dx = (pathX(z + 0.5) - pathX(z - 0.5));
    const len = Math.hypot(dx, 1);
    const px = 1 / len, pz = -dx / len; // Normale zur Laufrichtung
    for (const s of [-1, 1]) {
      const vx = x + px * s * W / 2, vz = z + pz * s * W / 2;
      verts.push(vx, heightAt(vx, vz) + 0.05, vz);
      uvs.push(s < 0 ? 0 : 1, v);
    }
    if (n > 0) { const b = (n - 1) * 2; idx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
    v += step / 4; n++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}
