// Schriften lokal ausliefern (keine Verbindung zu Google Fonts, DSGVO)
import '@fontsource/big-shoulders-display/500';
import '@fontsource/big-shoulders-display/700';
import '@fontsource/big-shoulders-display/900';
import '@fontsource/dancing-script/700';
import '@fontsource/ibm-plex-mono/400';
import '@fontsource/ibm-plex-mono/500';
import '@fontsource/ibm-plex-sans/400';
import '@fontsource/ibm-plex-sans/500';
import '@fontsource/ibm-plex-sans/600';
import './style.css';
import * as THREE from 'three';
import gsap from 'gsap';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

import { Atmosphere } from './scene/atmosphere.js';
import { createTerrain, createPath, heightAt } from './scene/terrain.js';
import { createOrchard, createForest, createWoodpile, Grass, shared } from './scene/vegetation.js';
import { createVillage } from './scene/village.js';
import { createTractor } from './tractor/model.js';
import { TractorController } from './tractor/controller.js';
import { Mirrors } from './tractor/mirrors.js';
import { grimeShared } from './tractor/grime.js';
import { EngineAudio } from './audio/engine.js';
import { HotspotLayer } from './ui/hotspots.js';
import { TireTracks } from './scene/tracks.js';
import { createRestArea } from './scene/feierabend.js';
import { createFireflies, createButterflies } from './scene/critters.js';
import { GodRaysPass } from './scene/godrays.js';
import { pathDist, inWater } from './scene/terrain.js';
import { createPond } from './scene/pond.js';
import { createViewpoint, LINDE } from './scene/viewpoint.js';
import { VIEW } from './scene/terrain.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const BASE = import.meta.env.BASE_URL;
// 0.9.0 → „v0.9“, 0.9.1 → „v0.9.1“
$('#version').textContent = 'v' + __APP_VERSION__.replace(/\.0$/, '');
if (params.has('fast')) gsap.ticker.lagSmoothing(0); // nur für Tests bei sehr niedriger Framerate

// ---------- Qualitätsstufe ----------
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const Q = isMobile || params.get('q') === 'low'
  ? { name: 'low', dpr: 1.5, shadowMap: 1024, terrainSeg: 280, grassRadius: 48, grassPerTile: 420, samples: 2, forest: 7000 }
  : { name: 'high', dpr: 2, shadowMap: 2048, terrainSeg: 420, forest: 17000, grassRadius: 72, grassPerTile: 1250, samples: 4 };

// ---------- Renderer / Szene ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
$('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 6000);
camera.position.set(-40, 26, 70);

const rt = new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, samples: Q.samples });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
composer.addPass(new RenderPass(scene, camera));
const godrays = new GodRaysPass();
composer.addPass(godrays);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.3, 0.55, 0.88);
composer.addPass(bloom);
const finish = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.9, 0.28, length(d * vec2(1.15, 1.0)));
      c.rgb *= mix(0.62, 1.0, v);
      float n = fract(sin(dot(vUv * vec2(1931.0, 1087.0) + fract(uTime) * 91.0, vec2(12.9898, 78.233))) * 43758.5453);
      c.rgb += (n - 0.5) * 0.018;
      gl_FragColor = c;
    }`,
});
composer.addPass(finish);
composer.addPass(new OutputPass());

const controls = new OrbitControls(camera, renderer.domElement);
controls.enabled = false;
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 2.6;
controls.maxDistance = 15;
controls.minPolarAngle = 0.25;
controls.maxPolarAngle = 1.52;
controls.rotateSpeed = 0.6;

// ---------- Welt aufbauen (mit Fortschrittsanzeige) ----------
const audio = new EngineAudio();
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const progress = (p) => ($('#progress-bar').style.width = `${Math.round(p * 100)}%`);

let atm, grass, parts, ctrl, hotspots, orchardLod, tracks, rest, pond, village, viewpoint, obstacles = [];
let mirrors;
let spots = []; // Plätze zum Absteigen: Steg am Weiher, Bank über dem Dorf
const wheelPts = [0, 1, 2, 3].map(() => new THREE.Vector3());
const STAGE_HEADING = 1.2;
const G0 = heightAt(0, 0); // Bodenhöhe der Bühne
const DEFAULT_TARGET = new THREE.Vector3(0, G0 + 0.95, 0);
const DEFAULT_CAM = new THREE.Vector3(3.3, G0 + 1.75, 5.1);
// Hochformat: Kamera weiter weg, damit der ganze Traktor ins Bild passt
if (innerWidth < innerHeight) DEFAULT_CAM.sub(DEFAULT_TARGET).multiplyScalar(1.7).add(DEFAULT_TARGET);

async function build() {
  const audioLoad = audio.preload(BASE);
  progress(0.05); await tick();
  atm = new Atmosphere(scene, renderer, Q);
  progress(0.15); await tick();
  scene.add(createTerrain(Q));
  scene.add(createPath());
  progress(0.35); await tick();
  const orchard = createOrchard(Q, { extras: [LINDE], clear: [{ x: VIEW.x, z: VIEW.z, r: 16 }] });
  scene.add(orchard.group);
  orchardLod = orchard.lod;
  obstacles.push(...orchard.obstacles);
  // Feierabend-Bank unter dem Obstbaum bei (12, 14), Blick Richtung Traktor und Tal
  // Bank schräg vor dem Traktor (Dreiviertel-Frontansicht, ~4 m bis zur Front)
  { const a = STAGE_HEADING + 0.62, r = 5.6, bx = Math.sin(a) * r, bz = Math.cos(a) * r;
    rest = createRestArea(bx, bz, Math.atan2(-bx, -bz)); }
  scene.add(rest.group);
  obstacles.push(...rest.obstacles);
  scene.add(createButterflies(Q.name === 'low' ? 14 : 26), createFireflies(Q.name === 'low' ? 80 : 140));
  const wood = createWoodpile(-11, -9, 0.9);
  scene.add(wood.group);
  obstacles.push(wood.obstacle);
  progress(0.5); await tick();
  scene.add(createForest(Q));
  village = createVillage();
  scene.add(village.group);
  progress(0.65); await tick();
  tracks = new TireTracks();
  shared.uTrail.value = tracks.map;
  scene.add(tracks.mesh);
  grass = new Grass(Q);
  scene.add(grass.group);
  pond = createPond(Q, audio);
  scene.add(pond.group);
  obstacles.push(...pond.obstacles);
  pond.hide.push(grass.group, tracks.mesh);
  pond.onResult = onSkipResult;
  viewpoint = createViewpoint();
  scene.add(viewpoint.group);
  obstacles.push(...viewpoint.obstacles);
  spots = [
    { id: 'pond', label: '🪨 Am Steg sitzen', hud: '#pond-hud', throw: true, ...pond, yaw: 1.25 },
    { id: 'view', label: '🪑 Auf die Bank setzen', hud: '#view-hud', throw: false, ...viewpoint, yaw: 1.5 },
  ];
  progress(0.8); await tick();

  parts = createTractor();
  scene.add(parts.root);
  ctrl = new TractorController(parts, {
    obstacles,
    onBump: (s) => { audio.clunk(Math.min(s / 4, 1)); shake(0.12 + s * 0.03); toast('Autsch! Der Baum stand zuerst da.'); },
    onShift: () => { audio.clunk(0.15); },
    onBoundary: () => toast('Hier endet die Wiese, bitte umdrehen.'),
    blocked: inWater,
    onBlocked: (s) => { if (s > 0.8) { audio.plop(0.4); shake(0.08); } toast('Halt! Der AGT 835 ist kein Boot.'); },
  });
  ctrl.reset(0, 0, STAGE_HEADING);
  scene.add(ctrl.particles.points);
  pond.hide.push(ctrl.particles.points);
  mirrors = new Mirrors(parts.mirrorGlasses, Q);
  let lastLamps = 0;
  atm.onLamps = (l) => { const on = l > 0.5 ? 1 : 0; if (on !== lastLamps) { lastLamps = on; ctrl.setLamps(!!on); } };

  hotspots = new HotspotLayer($('#hotspots'), parts.anchors, focusHotspot);
  await audioLoad;
  progress(1);
  // Shader vorkompilieren, damit die erste Kamerafahrt ruckelfrei ist
  renderer.compile(scene, camera);
  await tick();
}

// ---------- Zustände ----------
let mode = 'loading';
let idleTimer = 0;
let shakeAmt = 0;
const shake = (a) => (shakeAmt = Math.max(shakeAmt, a));

function showShowroomUI(show) {
  for (const id of ['#topbar', '#bottombar', '#hotspots']) $(id).classList.toggle('hidden', !show);
}

async function startExperience() {
  $('#start-btn').disabled = true;
  await audio.init().catch(() => {});
  // Motor bleibt beim Start aus – der Besucher lässt ihn selbst an
  updateEngineButton();

  const loader = $('#loader');
  loader.classList.add('reveal');
  mode = 'intro';
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-46, G0 + 30, 80), new THREE.Vector3(-22, G0 + 11, 34), new THREE.Vector3(-2, G0 + 3.6, 13), DEFAULT_CAM.clone(),
  ]);
  const look0 = new THREE.Vector3(0, 0, -200), look = new THREE.Vector3();
  const prog = { t: 0 };
  gsap.to(prog, {
    t: 1, duration: params.has('fast') ? 0.1 : 6.5, ease: 'power2.inOut',
    onUpdate: () => {
      camera.position.copy(path.getPoint(prog.t));
      look.copy(look0).lerp(DEFAULT_TARGET, Math.min(prog.t * 1.25, 1) ** 1.5);
      camera.lookAt(look);
    },
    onComplete: () => {
      controls.target.copy(DEFAULT_TARGET);
      controls.enabled = true;
      mode = 'showroom';
      showShowroomUI(true);
      startAutoCam();
      if (!ctrl.engineOn) setTimeout(() => !ctrl.engineOn && toast('Tipp: Lass den Motor an – unten rechts.'), 900);
    },
  });
  gsap.delayedCall(params.has('fast') ? 0.1 : 3.4, () => loader.classList.add('hidden'));
}

// ---------- Showroom-Regie: wechselnde Einstellungen, immer auf den Traktor ----------
// a = Winkel um den Traktor (0 = von vorn), d = Abstand, h = Kamerahöhe, ty/tz = Blickpunkt am Traktor
const SHOTS = [
  { a: 0.65, d: 6.2, h: 1.7, ty: 0.95, tz: 0 },     // Dreiviertel von vorn
  { a: 0.32, d: 3.0, h: 0.55, ty: 0.65, tz: 0.7 },  // ganz nah, tief am Vorderrad
  { a: 1.57, d: 10.5, h: 1.1, ty: 0.9, tz: 0 },     // Seite, weit weg
  { a: -1.35, d: 3.3, h: 1.9, ty: 1.35, tz: -0.3 }, // nah am Fahrerplatz
  { a: 2.45, d: 6.8, h: 2.2, ty: 0.9, tz: 0 },      // Dreiviertel von hinten, leicht erhöht
  { a: 3.05, d: 3.2, h: 1.0, ty: 0.75, tz: -1.0 },  // nah an Heck und Hubwerk
  { a: -0.85, d: 10.5, h: 5.5, ty: 0.8, tz: 0 },    // Übersicht von oben
  { a: -0.12, d: 8.5, h: 1.25, ty: 0.95, tz: 0 },   // frontal, mittlere Distanz
  { a: -2.2, d: 4.2, h: 0.7, ty: 1.0, tz: -0.6 },   // tief von hinten links
];
const autoCam = { on: false, cur: null, from: null, to: null, idx: -1, t: 0, glide: 0, hold: 0 };
const wrapAngle = (x) => Math.atan2(Math.sin(x), Math.cos(x));

function camToShot() {
  // aktuelle Kamera in Traktor-Koordinaten umrechnen
  const local = parts.root.worldToLocal(camera.position.clone());
  const tLocal = parts.root.worldToLocal(controls.target.clone());
  const dx = local.x - tLocal.x, dz = local.z - tLocal.z;
  return { a: Math.atan2(dx, dz), d: Math.max(Math.hypot(dx, dz), 2.6), h: local.y, ty: tLocal.y, tz: tLocal.z };
}
function applyShot(s) {
  const tgt = parts.root.localToWorld(new THREE.Vector3(0, s.ty, s.tz));
  const pos = parts.root.localToWorld(new THREE.Vector3(Math.sin(s.a) * s.d, s.h, s.tz + Math.cos(s.a) * s.d));
  pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 0.35);
  camera.position.copy(pos);
  controls.target.copy(tgt);
  camera.lookAt(tgt);
}
function nextShot() {
  let i;
  do i = Math.floor(Math.random() * SHOTS.length); while (i === autoCam.idx);
  autoCam.idx = i;
  const to = { ...SHOTS[i] };
  const from = autoCam.cur;
  // großer Sprung um den Traktor → harter Schnitt, sonst sanfte Fahrt
  const da = Math.abs(wrapAngle(to.a - from.a));
  autoCam.glide = da > 1.3 ? 0 : 3.2;
  autoCam.from = { ...from };
  autoCam.to = to;
  autoCam.t = 0;
  autoCam.hold = 6.5 + Math.random() * 3;
}
function startAutoCam() {
  if (mode !== 'showroom' || activeHotspot) return;
  autoCam.on = true;
  autoCam.cur = camToShot();
  autoCam.idx = -1;
  nextShot();
  autoCam.glide = 3.2; // aus der Hand des Besuchers immer weich übernehmen
}
function stopAutoCam() {
  autoCam.on = false;
  idleTimer = 0;
}
function updateAutoCam(dt) {
  const A = autoCam;
  A.t += dt;
  const { from, to } = A;
  if (A.glide > 0 && A.t < A.glide) {
    const k = A.t / A.glide, e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const lerp = THREE.MathUtils.lerp;
    A.cur = {
      a: from.a + wrapAngle(to.a - from.a) * e, d: lerp(from.d, to.d, e), h: lerp(from.h, to.h, e),
      ty: lerp(from.ty, to.ty, e), tz: lerp(from.tz, to.tz, e),
    };
  } else {
    // stehende Einstellung mit ganz langsamem Heranfahren, keine Drehung
    const held = A.t - A.glide;
    A.cur = { ...to, d: to.d * (1 - 0.05 * Math.min(held / A.hold, 1)) };
    if (held > A.hold) nextShot();
  }
  applyShot(A.cur);
}

// ---------- Motor an/aus ----------
let engineBusy = false;
function updateEngineButton() {
  const b = $('#engine-btn');
  b.classList.toggle('on', ctrl.engineOn);
  b.classList.toggle('attention', !ctrl.engineOn && !engineBusy);
  b.classList.toggle('busy', engineBusy);
  b.setAttribute('aria-pressed', String(ctrl.engineOn));
  $('#engine-label').textContent = engineBusy ? 'Startet …' : ctrl.engineOn ? 'Motor aus' : 'Motor an';
}
function startEngine() {
  if (ctrl.engineOn || engineBusy) return Promise.resolve();
  engineBusy = true;
  updateEngineButton();
  const t = audio.crank();
  return new Promise((res) => setTimeout(() => {
    ctrl.engineOn = true; ctrl.rpm = 1500; engineBusy = false;
    audio.engineRunning = true;
    updateEngineButton(); res();
  }, t * 1000));
}
function stopEngine() {
  if (!ctrl.engineOn || engineBusy) return;
  ctrl.engineOn = false;
  ctrl.revBoost = 0; ctrl.ptoSpin = 0;
  setTimeout(() => audio.clunk(0.35), 900); // Motor läuft aus und schüttelt sich ab
  audio.engineRunning = false;
  audio.coolingTicks();
  updateEngineButton();
}

// ---------- Hotspots ----------
let activeHotspot = null;
function focusHotspot(h) {
  if (mode !== 'showroom') return;
  activeHotspot = h;
  hotspots.setActive(h.id);
  stopAutoCam();
  const target = parts.anchors[h.id].getWorldPosition(new THREE.Vector3());
  const camPos = parts.root.localToWorld(new THREE.Vector3(...h.cam));
  camPos.y = Math.max(camPos.y, heightAt(camPos.x, camPos.z) + 0.5);
  gsap.to(camera.position, { x: camPos.x, y: camPos.y, z: camPos.z, duration: 1.5, ease: 'power3.inOut' });
  gsap.to(controls.target, { x: target.x, y: target.y, z: target.z, duration: 1.5, ease: 'power3.inOut' });

  $('#card-eyebrow').textContent = h.eyebrow;
  $('#card-title').textContent = h.title;
  $('#card-text').textContent = h.text;
  $('#card-facts').innerHTML = h.facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('#card').classList.remove('hidden');
  $('#datasheet').classList.add('hidden');
  gsap.delayedCall(0.9, () => runAction(h.action));
}

function closeCard() {
  $('#card').classList.add('hidden');
  hotspots.setActive(null);
  activeHotspot = null;
  if (mode !== 'showroom') return;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const pos = DEFAULT_TARGET.clone().addScaledVector(dir, 6.8);
  pos.y = Math.max(pos.y, 1.4);
  gsap.to(camera.position, { x: pos.x, y: pos.y, z: pos.z, duration: 1.3, ease: 'power3.inOut' });
  gsap.to(controls.target, { x: DEFAULT_TARGET.x, y: DEFAULT_TARGET.y, z: DEFAULT_TARGET.z, duration: 1.3, ease: 'power3.inOut' });
}

function runAction(a) {
  // Für Motor-Animationen den Motor bei Bedarf erst anlassen
  if (!ctrl.engineOn && ['rev', 'pto', 'lift'].includes(a)) { startEngine().then(() => runAction(a)); return; }
  switch (a) {
    case 'rev': {
      const tl = gsap.timeline();
      tl.to(ctrl, { revBoost: 1700, duration: 0.45, ease: 'power2.out' })
        .to(ctrl, { revBoost: 0, duration: 0.9, ease: 'power2.in' })
        .to(ctrl, { revBoost: 2000, duration: 0.5, ease: 'power2.out' }, '+=0.25')
        .to(ctrl, { revBoost: 0, duration: 1.4, ease: 'power2.in' });
      break;
    }
    case 'steer': {
      const o = { v: 0 };
      gsap.timeline({ onUpdate: () => (ctrl.phiTarget = o.v) })
        .to(o, { v: 0.62, duration: 1.2, ease: 'power2.inOut' })
        .to(o, { v: -0.62, duration: 1.8, ease: 'power2.inOut' }, '+=0.5')
        .to(o, { v: 0, duration: 1.2, ease: 'power2.inOut' }, '+=0.5');
      break;
    }
    case 'shift': {
      const tl = gsap.timeline();
      parts.levers.forEach((l, i) => {
        tl.to(l.rotation, { x: -0.25, duration: 0.25, ease: 'back.out', onStart: () => audio.clunk(0.2) }, i * 0.5)
          .to(l.rotation, { x: 0.25, duration: 0.3, ease: 'back.out', onStart: () => audio.clunk(0.15) }, i * 0.5 + 0.6);
      });
      break;
    }
    case 'pto': {
      gsap.timeline()
        .to(ctrl, { ptoSpin: 28, revBoost: 700, duration: 1.0, ease: 'power2.in' })
        .to(ctrl, { ptoSpin: 0, revBoost: 0, duration: 1.6, ease: 'power2.out' }, '+=3');
      break;
    }
    case 'lift': {
      ctrl.liftTarget = 1;
      audio.hydraulic(1.4);
      gsap.delayedCall(3.2, () => audio.hydraulic(1.2));
      gsap.to(ctrl, { revBoost: 450, duration: 0.4, yoyo: true, repeat: 1, repeatDelay: 1.4 });
      gsap.delayedCall(3.2, () => (ctrl.liftTarget = 0));
      break;
    }
    case 'lights': ctrl.setLamps(!ctrl.lampsOn); break;
  }
}

// ---------- Feierabend: auf der Bank sitzen ----------
const restLook = { tx: 0, ty: 0, x: 0, y: 0 };
function enterRest() {
  if (mode !== 'showroom') return;
  mode = 'transition';
  closeCard();
  $('#datasheet').classList.add('hidden');
  showShowroomUI(false);
  controls.enabled = false; stopAutoCam();
  const from = camera.position.clone(), lookFrom = controls.target.clone();
  const p = { t: 0 };
  gsap.to(p, {
    t: 1, duration: 3.2, ease: 'power2.inOut',
    onUpdate: () => {
      // leichter Bogen nach oben, damit die Kamera nicht durch Äste fährt
      camera.position.lerpVectors(from, rest.seatWorld, p.t);
      camera.position.y += Math.sin(p.t * Math.PI) * 2.2;
      camera.lookAt(lookFrom.clone().lerp(rest.lookWorld, p.t));
    },
    onComplete: () => { mode = 'rest'; restLook.x = restLook.tx; restLook.y = restLook.ty = 0; $('#rest-hud').classList.remove('hidden'); },
  });
}
function exitRest() {
  if (mode !== 'rest') return;
  mode = 'transition';
  $('#rest-hud').classList.add('hidden');
  const from = camera.position.clone(), lookFrom = rest.lookWorld.clone();
  const p = { t: 0 };
  gsap.to(p, {
    t: 1, duration: 2.6, ease: 'power2.inOut',
    onUpdate: () => {
      camera.position.lerpVectors(from, DEFAULT_CAM, p.t);
      camera.position.y += Math.sin(p.t * Math.PI) * 2.2;
      camera.lookAt(lookFrom.clone().lerp(DEFAULT_TARGET, p.t));
    },
    onComplete: () => {
      controls.target.copy(DEFAULT_TARGET); controls.enabled = true; controls.update();
      mode = 'showroom'; showShowroomUI(true);
    },
  });
}
function updateRestCamera(dt, t) {
  // sanft umschauen mit der Maus/dem Finger, dazu ruhiges Atmen
  restLook.x += (restLook.tx - restLook.x) * (1 - Math.exp(-dt * 2));
  restLook.y += (restLook.ty - restLook.y) * (1 - Math.exp(-dt * 2));
  camera.position.copy(rest.seatWorld);
  camera.position.y += Math.sin(t * 0.9) * 0.012;
  const dir = rest.lookWorld.clone().sub(rest.seatWorld);
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -restLook.x * 0.7);
  dir.y -= restLook.y * 1.4;
  camera.lookAt(rest.seatWorld.clone().add(dir));
}

// ---------- Fahrmodus ----------
let camMode = 0; // 0 Verfolger, 1 Fahrersitz, 2 Action-Cam, 3 Kino
const camModes = ['Verfolgerkamera', 'Fahrersitz', 'Action-Cam', 'Kinokamera'];
const CAM_FOV = [55, 62, 104, 38];
const ACTION_POS = new THREE.Vector3(-0.92, 1.32, -1.42); // hinten links am Eck, fest verschraubt
const ACTION_LOOK = new THREE.Vector3(0.18, 0.82, 0.95);
const tmpUp = new THREE.Vector3();
let cinePoint = null;
const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3() };
let chaseDist = 3.4;
addEventListener('wheel', (e) => { if (mode === 'drive' && camMode === 0) chaseDist = THREE.MathUtils.clamp(chaseDist * (1 + Math.sign(e.deltaY) * 0.1), 2.4, 8); }, { passive: true });
{ // Pinch-Zoom auf dem Handy
  let pd = 0;
  addEventListener('touchmove', (e) => {
    if (mode !== 'drive' || camMode !== 0 || e.touches.length !== 2 || e.target.closest('#touch')) return;
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (pd) chaseDist = THREE.MathUtils.clamp(chaseDist * pd / d, 2.4, 8);
    pd = d;
  }, { passive: true });
  addEventListener('touchend', () => (pd = 0));
}

function enterDrive() {
  if (mode !== 'showroom') return;
  if (!ctrl.engineOn) startEngine();
  mode = 'transition';
  closeCard();
  $('#datasheet').classList.add('hidden');
  showShowroomUI(false);
  controls.enabled = false;
  stopAutoCam();
  ctrl.phiTarget = 0;
  const { pos, look } = chaseTarget();
  const lookNow = controls.target.clone();
  const p = { t: 0 };
  const from = camera.position.clone();
  gsap.to(p, {
    t: 1, duration: 1.8, ease: 'power3.inOut',
    onUpdate: () => { camera.position.lerpVectors(from, pos, p.t); camera.lookAt(lookNow.clone().lerp(look, p.t)); },
    onComplete: () => {
      chase.pos.copy(pos); chase.look.copy(look);
      mode = 'drive'; ctrl.driving = true;
      camera.fov = CAM_FOV[camMode]; camera.updateProjectionMatrix();
      $('#drive-hud').classList.remove('hidden');
      $('#drive-help').classList.remove('fade');
      setTimeout(() => $('#drive-help').classList.add('fade'), 9000);
      setTimeout(() => { if (mode === 'drive' && !pondVisited) toast('Tipp: Vom Feldweg zweigen Wege zum Weiher und zur Aussichtsbank ab.'); }, 11000);
      audio.horn();
    },
  });
}

function exitDrive() {
  if (mode !== 'drive') return;
  mode = 'transition';
  $('#drive-hud').classList.add('hidden');
  const fade = $('#fade');
  fade.classList.remove('hidden');
  setTimeout(() => {
    ctrl.driving = false;
    resetCamera();
    camMode = 0;
    ctrl.reset(0, 0, STAGE_HEADING);
    ctrl.gear = 1;
    Object.assign(ctrl.input, { throttle: 0, brake: 0, steer: 0, handbrake: false });
    camera.position.copy(DEFAULT_CAM);
    controls.target.copy(DEFAULT_TARGET);
    controls.enabled = true;
    controls.update();
    startAutoCam();
    fade.classList.add('hidden');
    mode = 'showroom';
    showShowroomUI(true);
  }, 650);
}

function chaseTarget() {
  const j = parts.root.position;
  const h = ctrl.heading + ctrl.phi * 0.5;
  const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
  const back = ctrl.v < -0.5 ? -1 : 1;
  // nah dran (Standard 3,4 m), per Mausrad/Pinch zwischen 2,4 und 8 m
  const d = chaseDist;
  const pos = j.clone().addScaledVector(fwd, -d * back).add(new THREE.Vector3(0, 1.15 + d * 0.22, 0));
  pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 1.1);
  const look = j.clone().addScaledVector(fwd, (0.9 + d * 0.15) * back).add(new THREE.Vector3(0, 1.05, 0));
  return { pos, look };
}

function setCamMode(m) {
  camMode = m;
  cinePoint = null;
  camera.fov = CAM_FOV[m];
  camera.updateProjectionMatrix();
  toast(camModes[m]);
}

function resetCamera() {
  camera.up.set(0, 1, 0);
  if (camera.fov !== 42) { camera.fov = 42; camera.updateProjectionMatrix(); }
}

function updateDriveCamera(dt) {
  if (camMode !== 2) camera.up.set(0, 1, 0);
  if (camMode === 0) {
    const { pos, look } = chaseTarget();
    chase.pos.lerp(pos, 1 - Math.exp(-dt * 3.4));
    chase.look.lerp(look, 1 - Math.exp(-dt * 6));
    camera.position.copy(chase.pos);
    camera.lookAt(chase.look);
  } else if (camMode === 1) {
    camera.position.copy(parts.rear.localToWorld(new THREE.Vector3(0, 1.72, -0.5)));
    camera.lookAt(parts.front.localToWorld(new THREE.Vector3(0, 1.1, 4)));
  } else if (camMode === 2) {
    // Action-Cam: starr am Hinterwagen montiert, rollt und nickt mit dem Fahrzeug
    camera.position.copy(parts.rear.localToWorld(tmpV.copy(ACTION_POS)));
    camera.up.copy(tmpUp.set(0, 1, 0).transformDirection(parts.rear.matrixWorld));
    camera.lookAt(parts.rear.localToWorld(tmpV.copy(ACTION_LOOK)));
  } else {
    const j = parts.root.position;
    if (!cinePoint || cinePoint.distanceTo(j) > 32) {
      const fwd = new THREE.Vector3(Math.sin(ctrl.heading), 0, Math.cos(ctrl.heading));
      const side = new THREE.Vector3(fwd.z, 0, -fwd.x).multiplyScalar(Math.random() < 0.5 ? -1 : 1);
      cinePoint = j.clone().addScaledVector(fwd, 16 * Math.sign(ctrl.v || 1)).addScaledVector(side, 6 + Math.random() * 5);
      cinePoint.y = heightAt(cinePoint.x, cinePoint.z) + 0.9 + Math.random() * 2.5;
    }
    camera.position.copy(cinePoint);
    camera.lookAt(j.x, j.y + 1, j.z);
  }
}

// ---------- Am Weiher: auf dem Steg sitzen und Steine flitschen ----------
let charge = null; // Zeitpunkt, seit dem der Wurf aufgeladen wird
let skipRecord = +(localStorage.getItem('agt-flitsch-record') || 0);
let pondVisited = false;
let spot = null;     // aktueller Sitzplatz
let nearSpot = null; // Platz, an dem der Traktor gerade steht
let bellRung = false;
const sitCam = { fwd: new THREE.Vector3(), right: new THREE.Vector3() };

function findNearSpot() {
  if (!parts || ctrl.speedKmh >= 8) return null;
  const j = parts.root.position;
  return spots.find((s) => Math.hypot(j.x - s.parkWorld.x, j.z - s.parkWorld.z) < 11) || null;
}

function enterSpot() {
  const s = mode === 'drive' && findNearSpot();
  if (!s) return;
  spot = s;
  mode = 'transition';
  if (s.id === 'pond') pondVisited = true;
  Object.assign(ctrl.input, { throttle: 0, brake: 0, steer: 0, handbrake: true });
  $('#drive-hud').classList.add('hidden');
  $('#spot-btn').classList.add('hidden');
  stopEngine(); // Motor aus, ab hier hört man nur noch die Natur
  camera.up.set(0, 1, 0);
  const from = camera.position.clone();
  const lookFrom = chase.look.clone();
  const fov0 = camera.fov;
  const p = { t: 0 };
  gsap.to(p, {
    t: 1, duration: 3.6, ease: 'power2.inOut',
    onUpdate: () => {
      camera.position.lerpVectors(from, s.seatWorld, p.t);
      camera.position.y += Math.sin(p.t * Math.PI) * 3;
      camera.lookAt(lookFrom.clone().lerp(s.lookWorld, p.t));
      camera.fov = THREE.MathUtils.lerp(fov0, 52, p.t); camera.updateProjectionMatrix();
    },
    onComplete: () => {
      mode = 'sit';
      restLook.x = restLook.tx; restLook.y = restLook.ty;
      $(s.hud).classList.remove('hidden');
      if (s.throw) { updateSkipLabel(); toast('Halte die Maustaste (oder Leertaste) und lass im richtigen Moment los.'); }
      else {
        toast('Schau dich mit der Maus um.');
        // einmal läutet die Kirchturmuhr herüber
        if (!bellRung) { bellRung = true; setTimeout(() => mode === 'sit' && audio.bell(3), 2500); }
      }
    },
  });
}

function exitSpot() {
  if (mode !== 'sit') return;
  mode = 'transition';
  charge = null; pond.showHand(camera, null);
  $(spot.hud).classList.add('hidden');
  startEngine();
  const from = camera.position.clone();
  const lookFrom = camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(10));
  const fov0 = camera.fov;
  const p = { t: 0 };
  gsap.to(p, {
    t: 1, duration: 3, ease: 'power2.inOut',
    onUpdate: () => {
      const { pos, look } = chaseTarget();
      camera.position.lerpVectors(from, pos, p.t);
      camera.position.y += Math.sin(p.t * Math.PI) * 3;
      camera.lookAt(lookFrom.clone().lerp(look, p.t));
      camera.fov = THREE.MathUtils.lerp(fov0, CAM_FOV[camMode], p.t); camera.updateProjectionMatrix();
    },
    onComplete: () => {
      const { pos, look } = chaseTarget();
      chase.pos.copy(pos); chase.look.copy(look);
      ctrl.input.handbrake = false;
      mode = 'drive';
      spot = null;
      $('#drive-hud').classList.remove('hidden');
    },
  });
}

function updateSitCamera(dt, t) {
  restLook.x += (restLook.tx - restLook.x) * (1 - Math.exp(-dt * 2.5));
  restLook.y += (restLook.ty - restLook.y) * (1 - Math.exp(-dt * 2.5));
  camera.position.copy(spot.seatWorld);
  camera.position.y += Math.sin(t * 0.9) * 0.01;
  const f = sitCam.fwd.copy(spot.lookWorld).sub(spot.seatWorld).normalize();
  f.applyAxisAngle(new THREE.Vector3(0, 1, 0), -restLook.x * spot.yaw);
  const r = sitCam.right.set(f.z, 0, -f.x).normalize();
  f.applyAxisAngle(r, restLook.y * 0.42);
  camera.lookAt(tmpV.copy(camera.position).add(f));
  if (!spot.throw) return;
  // Wurfkraft pendelt hin und her: im richtigen Moment loslassen
  if (charge !== null) {
    const k = chargePower();
    $('#power-fill').style.width = `${Math.round(k * 100)}%`;
  }
  pond.showHand(camera, charge === null ? null : chargePower());
}

function chargePower() {
  const e = (performance.now() - charge) / 1000;
  const ph = (e / 1.1) % 2;
  return ph < 1 ? ph : 2 - ph;
}
function startCharge() {
  if (mode !== 'sit' || !spot?.throw || charge !== null) return;
  charge = performance.now();
  $('#power').classList.add('on');
}
function releaseCharge() {
  if (charge === null) return;
  const power = chargePower();
  charge = null;
  $('#power').classList.remove('on');
  $('#power-fill').style.width = '0%';
  pond.showHand(camera, null);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const origin = camera.position.clone()
    .addScaledVector(sitCam.right, -0.25).add(new THREE.Vector3(0, -0.25, 0)).addScaledVector(dir, 0.3);
  pond.throwStone(origin, dir, power);
}
function updateSkipLabel(last) {
  $('#skip-last').textContent = last === undefined ? '–' : last;
  $('#skip-record').textContent = skipRecord;
}
function onSkipResult(n) {
  const isRecord = n > skipRecord;
  if (isRecord) { skipRecord = n; localStorage.setItem('agt-flitsch-record', String(n)); }
  updateSkipLabel(n);
  if (n === 0) toast('Plumps. Flacher werfen, Blick zum Horizont!');
  else if (isRecord) toast(`Neuer Rekord: ${n}× gesprungen!`);
  else toast(n === 1 ? 'Einmal gehüpft.' : `${n}× gesprungen!`);
}

// ---------- Eingabe ----------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (mode === 'drive') {
    if (e.code === 'KeyH') audio.horn();
    if (e.code === 'KeyC') setCamMode((camMode + 1) % camModes.length);
    if (e.code === 'KeyL') ctrl.setLamps(!ctrl.lampsOn);
    if (e.code === 'KeyE') enterSpot();
    if (e.code === 'Escape') exitDrive();
  } else if (mode === 'sit') {
    if (e.code === 'Escape') exitSpot();
    if (e.code === 'Space') { e.preventDefault(); startCharge(); }
  } else if (mode === 'rest') {
    if (e.code === 'Escape') exitRest();
    if (e.code === 'Space') e.preventDefault();
  } else if (e.code === 'Escape') { closeCard(); $('#datasheet').classList.add('hidden'); }
});
addEventListener('keyup', (e) => { keys.delete(e.code); if (e.code === 'Space') releaseCharge(); });
addEventListener('blur', () => keys.clear());

const touch = { steer: 0, gas: false, brake: false };
function setupTouch() {
  const stick = $('#stick'), knob = $('#stick-knob');
  let id = null, cx = 0;
  stick.addEventListener('pointerdown', (e) => { id = e.pointerId; stick.setPointerCapture(id); const r = stick.getBoundingClientRect(); cx = r.left + r.width / 2; move(e); });
  const move = (e) => {
    if (e.pointerId !== id) return;
    const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 50));
    touch.steer = dx;
    knob.style.transform = `translateX(${dx * 38}px)`;
  };
  stick.addEventListener('pointermove', move);
  const up = (e) => { if (e.pointerId !== id) return; id = null; touch.steer = 0; knob.style.transform = ''; };
  stick.addEventListener('pointerup', up); stick.addEventListener('pointercancel', up);
  for (const [sel, key] of [['#t-gas', 'gas'], ['#t-brake', 'brake']]) {
    const el = $(sel);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); touch[key] = true; el.classList.add('on'); });
    const off = () => { touch[key] = false; el.classList.remove('on'); };
    el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
  }
}

function readInput() {
  const k = (...c) => c.some((x) => keys.has(x));
  const inp = ctrl.input;
  inp.throttle = k('KeyW', 'ArrowUp') || touch.gas ? 1 : 0;
  inp.brake = k('KeyS', 'ArrowDown') || touch.brake ? 1 : 0;
  const s = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
  inp.steer = s !== 0 ? s : touch.steer;
  inp.handbrake = k('Space');
}

// ---------- UI-Verdrahtung ----------
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  if (t.textContent === msg && !t.classList.contains('hidden')) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

function wireUI() {
  $('#start-btn').addEventListener('click', startExperience);
  $('#drive-btn').addEventListener('click', enterDrive);
  $('#back-btn').addEventListener('click', exitDrive);
  $('#rest-btn').addEventListener('click', enterRest);
  $('#rest-back').addEventListener('click', exitRest);
  $('#spot-btn').addEventListener('click', enterSpot);
  $('#pond-back').addEventListener('click', exitSpot);
  $('#view-back').addEventListener('click', exitSpot);
  renderer.domElement.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0) startCharge(); });
  addEventListener('pointerup', (e) => { if (e.pointerType === 'mouse') releaseCharge(); });
  const tb = $('#throw-btn');
  tb.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startCharge(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tb.addEventListener(ev, releaseCharge);
  addEventListener('pointermove', (e) => { restLook.tx = (e.clientX / innerWidth - 0.5) * 2; restLook.ty = (e.clientY / innerHeight - 0.5) * 2; });
  $('#engine-btn').addEventListener('click', () => (ctrl.engineOn ? stopEngine() : startEngine()));
  $('#datasheet-btn').addEventListener('click', () => { closeCard(); $('#datasheet').classList.toggle('hidden'); });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.close;
    if (id === 'card') closeCard();
    else $(`#${id}`).classList.add('hidden');
  }));
  $('#preset-switch').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#preset-switch button').forEach((x) => x.classList.toggle('active', x === b));
    atm.setPreset(b.dataset.preset);
    audio.setMood(b.dataset.preset);
  });
  $('#sound-btn').addEventListener('click', () => {
    audio.setMuted(!audio.muted);
    $('#sound-btn').textContent = audio.muted ? '🔇' : '🔊';
  });
  controls.addEventListener('start', stopAutoCam);
  setupTouch();
}

// ---------- Adaptive Auflösung ----------
// Misst die Bildzeit und passt die Renderauflösung an, damit schwächere Geräte flüssig bleiben.
const MAX_DPR = Math.min(devicePixelRatio, Q.dpr);
const MIN_DPR = Math.min(0.75, MAX_DPR);
let curDpr = MAX_DPR, ftSum = 0, ftN = 0, ftCool = 0;
function setDpr(d) {
  curDpr = d;
  renderer.setPixelRatio(d);
  composer.setPixelRatio(d);
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
}
function adaptResolution(rawDt) {
  if (document.hidden || mode === 'loading' || mode === 'ready' || params.has('fast')) return;
  ftSum += rawDt; ftN++;
  ftCool -= rawDt;
  if (ftN < 60 || ftCool > 0) return;
  const avg = ftSum / ftN; ftSum = 0; ftN = 0;
  if (avg > 1 / 45 && curDpr > MIN_DPR) { setDpr(Math.max(MIN_DPR, +(curDpr - 0.25).toFixed(2))); ftCool = 1.5; }
  else if (avg < 1 / 75 && curDpr < MAX_DPR) { setDpr(Math.min(MAX_DPR, +(curDpr + 0.25).toFixed(2))); ftCool = 4; }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------- Loop ----------
const timer = new THREE.Timer();
timer.connect(document);
let frame = 0;
const tmpV = new THREE.Vector3();

function loop(ts) {
  timer.update(ts);
  const rawDt = timer.getDelta();
  const dt = Math.min(rawDt, 0.05);
  if (rawDt > 0 && rawDt < 0.5) adaptResolution(rawDt);
  const t = timer.getElapsed();
  frame++;
  shared.uTime.value = t;
  finish.uniforms.uTime.value = t;

  if (ctrl) {
    if (mode === 'drive') readInput();
    ctrl.update(dt);
    parts.root.updateMatrixWorld();
    grimeShared.uRootInv.value.copy(parts.root.matrixWorld).invert();
    // Gras unter den Rädern wegdrücken
    const fa = parts.front.localToWorld(tmpV.set(0, 0, 0.66));
    shared.uPush.value.set(fa.x, fa.y, fa.z, 1);
    const ra = parts.rear.localToWorld(tmpV.set(0, 0, -0.66));
    shared.uPush2.value.set(ra.x, ra.y, ra.z, 1);
    // Reifenspuren: Aufstandspunkte der vier Räder
    parts.front.localToWorld(wheelPts[0].set(0.56, 0, 0.66));
    parts.front.localToWorld(wheelPts[1].set(-0.56, 0, 0.66));
    parts.rear.localToWorld(wheelPts[2].set(0.56, 0, -0.66));
    parts.rear.localToWorld(wheelPts[3].set(-0.56, 0, -0.66));
    tracks.update(dt, t, wheelPts, Math.abs(ctrl.v) > 0.15);
  }

  if (window.__freeze) { /* Debug: Kamera frei */ } else if (mode === 'showroom') {
    idleTimer += dt;
    if (!autoCam.on && !activeHotspot && idleTimer > 12) startAutoCam();
    if (autoCam.on) updateAutoCam(dt);
    else controls.update();
    const gy = heightAt(camera.position.x, camera.position.z) + 0.35;
    if (camera.position.y < gy) camera.position.y = gy;
  } else if (mode === 'rest') {
    updateRestCamera(dt, t);
  } else if (mode === 'sit') {
    updateSitCamera(dt, t);
  } else if (mode === 'drive') {
    updateDriveCamera(dt);
    const near = findNearSpot();
    if (near !== nearSpot) {
      nearSpot = near;
      $('#spot-btn').classList.toggle('hidden', !near);
      if (near) $('#spot-label').textContent = near.label;
    }
    $('#speed').textContent = Math.round(ctrl.speedKmh);
    $('#gear').textContent = ctrl.v < -0.1 ? 'R' : ctrl.gear;
    $('#rpm').textContent = Math.round(ctrl.rpm / 10) * 10;
    $('#rpm-fill').style.width = `${Math.min(ctrl.rpm / 3000, 1) * 100}%`;
  }

  if (shakeAmt > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shakeAmt;
    camera.position.y += (Math.random() - 0.5) * shakeAmt;
    shakeAmt *= Math.exp(-dt * 8);
  }

  if (atm && parts) {
    atm.update(t, camera, mode === 'sit' ? tmpV.copy(spot.seatWorld).setY(spot.seatWorld.y - 1).addScaledVector(sitCam.fwd, 5) : parts.root.position);
    pond.update(dt, t, camera, atm);
    if (frame % 10 === 0) audio.setPond(THREE.MathUtils.clamp(1 - Math.hypot(camera.position.x - pond.seatWorld.x, camera.position.z - pond.seatWorld.z) / 70, 0, 1) * 0.9);
    bloom.strength = atm.state.bloom;
    // Abend-Wert langsam nachziehen: Dorflichter gehen nach und nach an, Glühwürmchen erwachen
    shared.uNight.value += (atm.state.lamps - shared.uNight.value) * (1 - Math.exp(-dt / 5));
    village.update(shared.uNight.value);
    // Lichtstrahlen: je tiefer die Sonne, desto stärker
    const el = atm.state.sunEl;
    godrays.updateSun(camera, atm.sunVec, 0.15 + 0.6 * (1 - THREE.MathUtils.smoothstep(el, 6, 45)), atm.state.sunColor);
    godrays.enabled = godrays.strength > 0.005;
    if (frame % 8 === 0) { grass.update(camera); orchardLod.update(camera); }
    if (mode === 'showroom') hotspots.update(camera, tmpV.copy(parts.root.position).setY(parts.root.position.y + 1), innerWidth, innerHeight);
    const dist = camera.position.distanceTo(parts.root.position);
    const listen = mode === 'drive' ? (camMode === 1 || camMode === 2 ? 1.1 : 0.95) : Math.min(1, Math.max(0.3, 6 / dist));
    const load = mode === 'drive' ? ctrl.input.throttle : Math.min(ctrl.revBoost / 1500, 1);
    audio.update(ctrl.rpm, load, listen);
    audio.updateDrive({
      speed: Math.abs(ctrl.v), gear: ctrl.gear, reverse: ctrl.v < -0.1,
      onPath: pathDist(ctrl.rearAxle.x, ctrl.rearAxle.z) < 1.8, listen: Math.min(listen, 1),
    });
  }

  // Rückspiegel: Gras und Rauch weglassen, das Wasser nur in der Nähe des Weihers
  if (mirrors && mode !== 'loading' && mode !== 'ready') {
    const nearPondCam = Math.hypot(camera.position.x - pond.seatWorld.x, camera.position.z - pond.seatWorld.z) < 60;
    mirrors.update(renderer, scene, camera, nearPondCam ? [grass.group, ctrl.particles.points] : [grass.group, ctrl.particles.points, pond.water]);
  }
  composer.render();
  requestAnimationFrame(loop);
}

// ---------- Start ----------
(async () => {
  wireUI();
  requestAnimationFrame(loop);
  try {
    await build();
  } catch (e) {
    console.error(e);
    $('#start-label').textContent = 'Fehler beim Laden';
    return;
  }
  mode = 'ready';
  camera.lookAt(0, 0, -200);
  $('#start-btn').disabled = false;
  $('#start-label').textContent = 'Einsteigen';
  if (params.has('autostart')) startExperience();
})();

// Für Debugging in der Konsole
window.__agt = { scene, camera, audio, renderer, composer, shared, get pond() { return pond; }, get spots() { return spots; }, enterSpot, exitSpot, get mode() { return mode; }, get ctrl() { return ctrl; }, get tracks() { return tracks; }, get parts() { return parts; }, wheelPts, get atm() { return atm; }, controls, enterDrive, exitDrive, focusHotspot };
