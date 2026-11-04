import * as THREE from 'three';
import gsap from 'gsap';

// Himmel (Shader-Kuppel mit Sonne + Wolken), Licht, Nebel und Environment-Map.
// Drei Stimmungen, angelehnt an die Fotos: Tag, Goldene Stunde, lila Abend.

const sunDir = (azDeg, elDeg) => {
  const az = THREE.MathUtils.degToRad(azDeg), el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
};

export const PRESETS = {
  day: {
    top: '#2a68c8', horizon: '#b9d4ea', ground: '#9fb3b8',
    sunAz: 140, sunEl: 52, sunColor: '#fff3df', sunIntensity: 3.2,
    hemiSky: '#c4dcff', hemiGround: '#5d6b3a', hemiIntensity: 1.25,
    fog: '#c5d7e2', fogDensity: 0.0008, exposure: 1.0,
    cloudCover: 0.42, cloudLight: '#ffffff', cloudShade: '#aab8c8', bloom: 0.18, lamps: 0,
  },
  golden: {
    top: '#4f74b0', horizon: '#f5c690', ground: '#b49270',
    sunAz: 58, sunEl: 8, sunColor: '#ffb469', sunIntensity: 3.4,
    hemiSky: '#ffdcb0', hemiGround: '#4a5527', hemiIntensity: 0.95,
    fog: '#e2c4a2', fogDensity: 0.00105, exposure: 1.06,
    cloudCover: 0.36, cloudLight: '#ffd7a8', cloudShade: '#8f7b8c', bloom: 0.32, lamps: 0,
  },
  dusk: {
    top: '#4c4f86', horizon: '#e6a3b3', ground: '#8c7896',
    sunAz: 75, sunEl: 1.2, sunColor: '#ff9d86', sunIntensity: 1.05,
    hemiSky: '#b4a3d8', hemiGround: '#363b2a', hemiIntensity: 1.0,
    fog: '#c6a2bd', fogDensity: 0.0014, exposure: 1.08,
    cloudCover: 0.62, cloudLight: '#f4c0cf', cloudShade: '#6f6a95', bloom: 0.55, lamps: 1,
  },
};

const skyVert = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const skyFrag = /* glsl */`
uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor, uCloudLight, uCloudShade;
uniform float uCloudCover, uTime;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  // Horizont-Dunst in Sonnenrichtung
  col += uSunColor * pow(sd, 6.0) * 0.28 * (1.0 - smoothstep(0.0, 0.5, h));
  // Wolken
  if (h > 0.0) {
    vec2 p = d.xz / (h + 0.12) * 0.75 + vec2(uTime * 0.006, uTime * 0.002);
    float n = fbm(p);
    float c = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.3, n);
    float lit = fbm(p + normalize(uSunDir).xz * 0.08);
    vec3 cc = mix(uCloudShade, uCloudLight, clamp(0.35 + (n - lit) * 3.0 + pow(sd, 4.0) * 0.6, 0.0, 1.0));
    col = mix(col, cc, c * smoothstep(0.0, 0.18, h) * 0.92);
  }
  // Sonnenscheibe + Glow
  col += uSunColor * (pow(sd, 1400.0) * 14.0 + pow(sd, 90.0) * 0.6 + pow(sd, 14.0) * 0.18);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Atmosphere {
  constructor(scene, renderer, quality) {
    this.scene = scene;
    this.renderer = renderer;
    this.state = {};
    this.name = 'golden';
    this.copyPreset(PRESETS.golden, this.state);

    this.uniforms = {
      uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
      uCloudLight: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
      uCloudCover: { value: 0.4 }, uTime: { value: 0 },
    };
    const skyMat = new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 48, 24), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(quality.shadowMap, quality.shadowMap);
    s.camera.near = 1; s.camera.far = 140;
    s.camera.left = -22; s.camera.right = 22; s.camera.top = 22; s.camera.bottom = -22;
    s.bias = -0.0004; s.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x445522, 1);
    scene.add(this.hemi);

    scene.fog = new THREE.FogExp2(0xffffff, 0.0015);

    // Environment-Map aus dem Himmel für Lackreflexionen
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat);
    this.envScene.add(this.envSky);
    // Boden-Halbkugel, damit der Lack unten grünlich spiegelt
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(90, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x55682e }));
    this.envGround.position.y = -8;
    this.envScene.add(this.envGround);

    this.onLamps = () => {};
    this.apply();
    this.bakeEnv();
  }

  copyPreset(src, dst) {
    for (const k in src) dst[k] = typeof src[k] === 'string' ? new THREE.Color(src[k]) : src[k];
    return dst;
  }

  apply() {
    const st = this.state, u = this.uniforms;
    u.uTop.value.copy(st.top).multiplyScalar(1.15);
    u.uHorizon.value.copy(st.horizon).multiplyScalar(1.2);
    u.uGround.value.copy(st.ground);
    u.uSunColor.value.copy(st.sunColor);
    u.uCloudLight.value.copy(st.cloudLight).multiplyScalar(1.15);
    u.uCloudShade.value.copy(st.cloudShade);
    u.uCloudCover.value = st.cloudCover;
    this.sunVec = sunDir(st.sunAz, st.sunEl);
    u.uSunDir.value.copy(this.sunVec);
    this.sun.color.copy(st.sunColor);
    this.sun.intensity = st.sunIntensity;
    this.hemi.color.copy(st.hemiSky);
    this.hemi.groundColor.copy(st.hemiGround);
    this.hemi.intensity = st.hemiIntensity;
    this.scene.fog.color.copy(st.fog);
    this.scene.fog.density = st.fogDensity;
    this.renderer.toneMappingExposure = st.exposure;
    this.envGround.material.color.copy(st.hemiGround).multiplyScalar(0.8);
    this.onLamps(st.lamps);
  }

  bakeEnv() {
    const old = this.scene.environment;
    const rt = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = rt.texture;
    if (this.envRT) this.envRT.dispose();
    this.envRT = rt;
    void old;
  }

  setPreset(name, duration = 2.2) {
    if (!PRESETS[name]) return;
    this.name = name;
    const target = this.copyPreset(PRESETS[name], {});
    const from = {};
    for (const k in this.state) from[k] = this.state[k] instanceof THREE.Color ? this.state[k].clone() : this.state[k];
    const p = { t: 0 };
    gsap.killTweensOf(this.tweenObj || {});
    this.tweenObj = p;
    gsap.to(p, {
      t: 1, duration, ease: 'power2.inOut',
      onUpdate: () => {
        for (const k in target) {
          if (target[k] instanceof THREE.Color) this.state[k].copy(from[k]).lerp(target[k], p.t);
          else this.state[k] = THREE.MathUtils.lerp(from[k], target[k], p.t);
        }
        this.apply();
      },
      onComplete: () => this.bakeEnv(),
    });
    // Zwischendurch einmal neu backen, damit der Lack mitzieht
    gsap.delayedCall(duration * 0.5, () => this.bakeEnv());
  }

  update(time, camera, focus) {
    this.uniforms.uTime.value = time;
    this.sky.position.copy(camera.position);
    // Schattenkamera folgt dem Traktor
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunVec, 80);
  }
}
