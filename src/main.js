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
import { createOrchard, createForest, createVillage, createWoodpile, Grass, shared } from './scene/vegetation.js';
import { createTractor } from './tractor/model.js';
import { TractorController } from './tractor/controller.js';
import { grimeShared } from './tractor/grime.js';
import { EngineAudio } from './audio/engine.js';
import { HotspotLayer } from './ui/hotspots.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const BASE = import.meta.env.BASE_URL;
if (params.has('fast')) gsap.ticker.lagSmoothing(0); // nur für Tests bei sehr niedriger Framerate

// ---------- Qualitätsstufe ----------
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const Q = isMobile || params.get('q') === 'low'
  ? { name: 'low', dpr: 1.5, shadowMap: 1024, terrainSeg: 220, grassRadius: 48, grassPerTile: 420, samples: 2, forest: 7000 }
  : { name: 'high', dpr: 2, shadowMap: 2048, terrainSeg: 340, forest: 17000, grassRadius: 72, grassPerTile: 1250, samples: 4 };

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
controls.autoRotateSpeed = 0.35;
controls.rotateSpeed = 0.6;

// ---------- Welt aufbauen (mit Fortschrittsanzeige) ----------
const audio = new EngineAudio();
const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
const progress = (p) => ($('#progress-bar').style.width = `${Math.round(p * 100)}%`);

let atm, grass, parts, ctrl, hotspots, obstacles = [];
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
  const orchard = createOrchard(Q);
  scene.add(orchard.group);
  obstacles.push(...orchard.obstacles);
  const wood = createWoodpile(-11, -9, 0.9);
  scene.add(wood.group);
  obstacles.push(wood.obstacle);
  progress(0.5); await tick();
  scene.add(createForest(Q));
  scene.add(createVillage());
  progress(0.65); await tick();
  grass = new Grass(Q);
  scene.add(grass.group);
  progress(0.8); await tick();

  parts = createTractor();
  scene.add(parts.root);
  ctrl = new TractorController(parts, {
    obstacles,
    onBump: (s) => { audio.clunk(Math.min(s / 4, 1)); shake(0.12 + s * 0.03); toast('Autsch! Der Baum stand zuerst da.'); },
    onShift: () => { audio.clunk(0.15); },
    onBoundary: () => toast('Hier endet die Wiese, bitte umdrehen.'),
  });
  ctrl.reset(0, 0, STAGE_HEADING);
  scene.add(ctrl.particles.points);
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
      controls.autoRotate = true;
      mode = 'showroom';
      showShowroomUI(true);
      if (!ctrl.engineOn) setTimeout(() => !ctrl.engineOn && toast('Tipp: Lass den Motor an – unten rechts.'), 900);
    },
  });
  gsap.delayedCall(params.has('fast') ? 0.1 : 3.4, () => loader.classList.add('hidden'));
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
    updateEngineButton(); res();
  }, t * 1000));
}
function stopEngine() {
  if (!ctrl.engineOn || engineBusy) return;
  ctrl.engineOn = false;
  ctrl.revBoost = 0; ctrl.ptoSpin = 0;
  setTimeout(() => audio.clunk(0.35), 900); // Motor läuft aus und schüttelt sich ab
  updateEngineButton();
}

// ---------- Hotspots ----------
let activeHotspot = null;
function focusHotspot(h) {
  if (mode !== 'showroom') return;
  activeHotspot = h;
  hotspots.setActive(h.id);
  controls.autoRotate = false;
  idleTimer = 0;
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
      gsap.to(ctrl, { revBoost: 450, duration: 0.4, yoyo: true, repeat: 1, repeatDelay: 1.4 });
      gsap.delayedCall(3.2, () => (ctrl.liftTarget = 0));
      break;
    }
    case 'lights': ctrl.setLamps(!ctrl.lampsOn); break;
  }
}

// ---------- Fahrmodus ----------
let camMode = 0; // 0 Verfolger, 1 Fahrersitz, 2 Action-Cam, 3 Kino
const camModes = ['Verfolgerkamera', 'Fahrersitz', 'Action-Cam', 'Kinokamera'];
const CAM_FOV = [42, 62, 104, 38];
const ACTION_POS = new THREE.Vector3(-0.92, 1.32, -1.42); // hinten links am Eck, fest verschraubt
const ACTION_LOOK = new THREE.Vector3(0.18, 0.82, 0.95);
const tmpUp = new THREE.Vector3();
let cinePoint = null;
const chase = { pos: new THREE.Vector3(), look: new THREE.Vector3() };

function enterDrive() {
  if (mode !== 'showroom') return;
  if (!ctrl.engineOn) startEngine();
  mode = 'transition';
  closeCard();
  $('#datasheet').classList.add('hidden');
  showShowroomUI(false);
  controls.enabled = false;
  controls.autoRotate = false;
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
      $('#drive-hud').classList.remove('hidden');
      $('#drive-help').classList.remove('fade');
      setTimeout(() => $('#drive-help').classList.add('fade'), 9000);
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
    controls.autoRotate = true;
    controls.update();
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
  const pos = j.clone().addScaledVector(fwd, -6.2 * back).add(new THREE.Vector3(0, 2.7, 0));
  pos.y = Math.max(pos.y, heightAt(pos.x, pos.z) + 1.3);
  const look = j.clone().addScaledVector(fwd, 1.8 * back).add(new THREE.Vector3(0, 1.0, 0));
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
    chase.pos.lerp(pos, 1 - Math.exp(-dt * 2.6));
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

// ---------- Eingabe ----------
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (mode === 'drive') {
    if (e.code === 'KeyH') audio.horn();
    if (e.code === 'KeyC') setCamMode((camMode + 1) % camModes.length);
    if (e.code === 'KeyL') ctrl.setLamps(!ctrl.lampsOn);
    if (e.code === 'Escape') exitDrive();
    if (e.code === 'Space') e.preventDefault();
  } else if (e.code === 'Escape') { closeCard(); $('#datasheet').classList.add('hidden'); }
});
addEventListener('keyup', (e) => keys.delete(e.code));
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
  controls.addEventListener('start', () => { controls.autoRotate = false; idleTimer = 0; });
  setupTouch();
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
  const dt = Math.min(timer.getDelta(), 0.05);
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
  }

  if (window.__freeze) { /* Debug: Kamera frei */ } else if (mode === 'showroom') {
    controls.update();
    idleTimer += dt;
    if (!activeHotspot && idleTimer > 12) controls.autoRotate = true;
    const gy = heightAt(camera.position.x, camera.position.z) + 0.35;
    if (camera.position.y < gy) camera.position.y = gy;
  } else if (mode === 'drive') {
    updateDriveCamera(dt);
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
    atm.update(t, camera, parts.root.position);
    bloom.strength = atm.state.bloom;
    if (frame % 8 === 0) grass.update(camera);
    if (mode === 'showroom') hotspots.update(camera, tmpV.copy(parts.root.position).setY(parts.root.position.y + 1), innerWidth, innerHeight);
    const dist = camera.position.distanceTo(parts.root.position);
    const listen = mode === 'drive' ? (camMode === 1 || camMode === 2 ? 1.1 : 0.95) : Math.min(1, Math.max(0.3, 6 / dist));
    const load = mode === 'drive' ? ctrl.input.throttle : Math.min(ctrl.revBoost / 1500, 1);
    audio.update(ctrl.rpm, load, listen);
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
window.__agt = { scene, camera, audio, get ctrl() { return ctrl; }, get atm() { return atm; }, controls, enterDrive, exitDrive, focusHotspot };
