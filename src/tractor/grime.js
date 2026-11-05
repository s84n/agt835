import * as THREE from 'three';

// Gebrauchsspuren per Shader: Staub/Schmutz sammelt sich unten am Traktor, Schlamm
// auf den Reifen, feine Oberflächenstruktur (Orangenhaut im Lack, Gummi, Gussteile).
// Rechnet im Traktor-Koordinatensystem, damit nichts „schwimmt“, wenn er fährt.

export const grimeShared = { uRootInv: { value: new THREE.Matrix4() } };

export const NOISE = /* glsl */`
float gHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float gNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(gHash(i), gHash(i + vec3(1,0,0)), f.x), mix(gHash(i + vec3(0,1,0)), gHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(gHash(i + vec3(0,0,1)), gHash(i + vec3(1,0,1)), f.x), mix(gHash(i + vec3(0,1,1)), gHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float gFbm(vec3 p) { return gNoise(p) * 0.5 + gNoise(p * 2.03) * 0.3 + gNoise(p * 4.1) * 0.2; }
`;

export function applyGrime(material, o) {
  const u = {
    uDirt: { value: new THREE.Color(o.color ?? '#6e5c44') },
    uAmount: { value: o.amount ?? 0.8 },
    uLow: { value: o.low ?? 0.25 },
    uHigh: { value: o.high ?? 0.85 },
    uScale: { value: o.scale ?? 6 },
    uLocal: { value: o.local ? 1 : 0 },
    uHeightMix: { value: o.heightMix ?? 1 },
    uMicro: { value: o.micro ?? 0.03 },
    uMicroScale: { value: o.microScale ?? 120 },
    uRust: { value: o.rust ?? 0 },
    uDust: { value: o.dust ?? 0.5 },
  };
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, grimeShared);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform mat4 uRootInv; varying vec3 vTPos; varying vec3 vLPos; varying float vUp;
        #ifdef GRIME_BAKED
          attribute vec3 grimePos;
        #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        #ifdef GRIME_BAKED
          vTPos = grimePos; // Ruhelage im Traktor-Raum: Flecken kleben am Blech, auch wenn es vibriert
        #else
          vTPos = (uRootInv * modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        vLPos = position;
        vUp = normalize(mat3(uRootInv * modelMatrix) * objectNormal).y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uDirt; uniform float uAmount, uLow, uHigh, uScale, uLocal, uHeightMix, uMicro, uMicroScale, uRust, uDust;
        varying vec3 vTPos; varying vec3 vLPos; varying float vUp;
        float grimeD = 0.0;
        ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 P = uLocal > 0.5 ? vLPos : vTPos;
          // grobe Maske (wo überhaupt Dreck ist) × feines Korn (wie er aussieht)
          float mask = gFbm(P * uScale * 0.9);
          float n = gFbm(P * uScale * 4.0 + 5.0);
          float h = mix(1.0, 1.0 - smoothstep(uLow, uHigh, vTPos.y), uHeightMix);
          float d = smoothstep(0.62, 0.78, n * 0.55 + mask * 0.25 + h * 0.45 * uAmount) * uAmount;
          // feine Spritzer
          float sp = smoothstep(0.84, 0.92, gNoise(P * uScale * 16.0)) * h * uAmount;
          grimeD = clamp(max(d, sp * 0.7), 0.0, 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, uDirt * (0.8 + n * 0.4), grimeD);

          // Rost: einzelne Flecken mit ausgefranstem Rand + nach unten laufende Rostfahnen
          if (uRust > 0.0) {
            float rn = gFbm(P * 26.0 + 3.1);
            float spot = smoothstep(0.7 - uRust * 0.08, 0.75 - uRust * 0.08, rn) * smoothstep(0.45, 0.6, gFbm(P * 5.0 + 1.7));
            float streak = smoothstep(0.7, 0.85, gNoise(vec3(P.x * 70.0, P.y * 5.0, P.z * 70.0))) * smoothstep(0.6, 0.72, gFbm(P * 6.0 + 7.0));
            float rust = clamp(max(spot, streak * 0.5) * uRust * 1.3, 0.0, 0.85);
            vec3 rustCol = mix(vec3(0.24, 0.1, 0.04), vec3(0.5, 0.22, 0.08), gNoise(P * 60.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, rustCol, rust);
            grimeD = max(grimeD, rust);
          }
          // Staub sammelt sich auf waagerechten Flächen (Haube, Kotflügel, Trittflächen)
          float dust = smoothstep(0.6, 0.95, vUp) * uDust * smoothstep(0.4, 0.75, gFbm(P * 14.0 + 11.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.55, 0.43), dust * 0.4);
          grimeD = max(grimeD, dust * 0.6);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.95, grimeD);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 P = (uLocal > 0.5 ? vLPos : vTPos) * uMicroScale;
          vec3 g = vec3(gNoise(P), gNoise(P + 17.3), gNoise(P + 41.7)) - 0.5;
          normal = normalize(normal + g * uMicro * (1.0 + grimeD * 2.0));
        }`);
    // Klarlack wird unter Schmutz matt
    sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      #ifdef USE_CLEARCOAT
        material.clearcoat *= (1.0 - grimeD);
      #endif`);
  };
  material.customProgramCacheKey = () => 'grime';
  material.needsUpdate = true;
}

// Wendet die in material.userData.grime hinterlegten Parameter auf alle Materialien an.
// Zusätzlich wird die Ruhelage jedes Vertex im Traktor-Raum als Attribut eingebacken:
// Bewegte Teile (Motorvibration, Rütteln, Hebel) tragen ihre Rost- und Schmutzflecken
// dadurch mit, statt durch ein feststehendes Muster zu gleiten.
export function applyGrimeToObject(root) {
  const done = new Set();
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const mtx = new THREE.Matrix4();
  const used = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const grimeMats = mats.filter((m) => m.userData.grime && !m.userData.grime.local);
    if (grimeMats.length && !o.isInstancedMesh && o.geometry.attributes.position) {
      // geteilte Geometrie klonen, damit jede Instanz ihre eigene Lage bekommt
      if (used.has(o.geometry)) o.geometry = o.geometry.clone();
      used.add(o.geometry);
      const pos = o.geometry.attributes.position;
      mtx.multiplyMatrices(rootInv, o.matrixWorld);
      const arr = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(mtx).toArray(arr, i * 3);
      o.geometry.setAttribute('grimePos', new THREE.BufferAttribute(arr, 3));
      for (const m of grimeMats) m.userData.grimeBaked = true;
    }
  });
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (done.has(m) || !m.userData.grime) continue;
      done.add(m);
      if (m.userData.grimeBaked) m.defines = { ...(m.defines || {}), GRIME_BAKED: '' };
      applyGrime(m, m.userData.grime);
    }
  });
}
