import * as THREE from 'three';
import { DIM } from './model.js';
import { heightAt, pathDist } from '../scene/terrain.js';
import { clamp, lerp } from '../scene/noise.js';

// Fahrphysik für einen knickgelenkten Allradtraktor + Animation aller beweglichen Teile.

const GEAR_TOP = [3, 5, 7.5, 10.5, 14, 18.5, 24, 30].map((k) => k / 3.6); // m/s bei Nenndrehzahl
const REV_TOP = 12 / 3.6;
const RPM_IDLE = 900, RPM_MAX = 3000;
const MAX_PHI = 0.68; // ~39° Knickwinkel
const DRIVE_RADIUS = 115;

export class TractorController {
  constructor(parts, { obstacles = [], onBump, onShift, onBoundary } = {}) {
    this.p = parts;
    this.obstacles = obstacles;
    this.onBump = onBump || (() => {});
    this.onShift = onShift || (() => {});
    this.onBoundary = onBoundary || (() => {});
    this.reset(0, 0, 0);
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this.driving = false;
    this.engineOn = false;
    this.rpm = 0;
    this.rpmTarget = 0;
    this.gear = 1;
    this.ptoSpin = 0;
    this.liftTarget = 0; this.lift = 0;
    this.revBoost = 0;
    this.time = 0;
    this.shiftTimer = 0;
    this.lampsOn = false;
    this.particles = new Particles();
  }

  reset(x, z, heading) {
    this.rearAxle = new THREE.Vector3(x, 0, z).addScaledVector(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)), -DIM.axleR);
    this.heading = heading;
    this.phi = 0;
    this.phiTarget = null; // für Showroom-Animation
    this.v = 0;
    this.wheelAngle = 0;
    this.pitch = 0; this.roll = 0; this.y = 0;
    this.place(1);
  }

  get joint() {
    return this.rearAxle.clone().addScaledVector(new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading)), DIM.axleR);
  }
  get speedKmh() { return Math.abs(this.v) * 3.6; }

  setLamps(on) {
    this.lampsOn = on;
    const M = this.p.materials;
    this.p.headlights.forEach((l) => (l.intensity = on ? 18 : 0));
    M.headGlass.emissiveIntensity = on ? 2.5 : 0;
    M.tail.emissiveIntensity = on ? 1.6 : 0;
  }

  update(dt) {
    this.time += dt;
    const inp = this.input;
    const dir = Math.sign(this.v);

    if (this.driving) {
      // Lenkung (Knickwinkel)
      // Sanftere Lenkung: langsames Einlenken, Knickwinkel nimmt mit dem Tempo ab,
      // beim Loslassen zentriert der Traktor zügiger zurück.
      const spd = Math.min(Math.abs(this.v) / 8, 1);
      const maxPhi = MAX_PHI * (1 - 0.55 * spd);
      const target = -inp.steer * maxPhi;
      const centering = Math.abs(target) < Math.abs(this.phi) - 1e-3;
      const steerRate = (centering ? 1.0 : 0.6) * (1 - 0.35 * spd);
      this.phi += clamp(target - this.phi, -steerRate * dt, steerRate * dt);

      // Antrieb
      let acc = 0;
      const gTop = GEAR_TOP[this.gear - 1];
      if (inp.throttle > 0) {
        if (this.v < -0.3) acc = 7; // erst bremsen
        else acc = inp.throttle * (2.6 - this.gear * 0.17) * (this.v < gTop ? 1 : 0.1);
      }
      if (inp.brake > 0) {
        if (this.v > 0.3) acc = -7 * inp.brake;
        else acc = -inp.brake * 1.8 * (this.v > -REV_TOP ? 1 : 0);
      }
      if (inp.handbrake) acc = -Math.sign(this.v) * Math.min(9, Math.abs(this.v) / dt);
      // Hangabtrieb, Rollwiderstand
      acc += -9.81 * Math.sin(-this.pitch) * 0.6;
      if (inp.throttle === 0 && inp.brake === 0) acc -= Math.sign(this.v) * Math.min(Math.abs(this.v) / dt, 0.9 + Math.abs(this.v) * 0.08);
      this.v += acc * dt;
      if (this.shiftTimer > 0) { this.shiftTimer -= dt; this.v *= 1 - 0.3 * dt; }
      this.v = clamp(this.v, -REV_TOP, GEAR_TOP[7] * 1.02);

      // Automatische Gangwahl
      const vf = Math.max(this.v, 0);
      if (this.v >= -0.1) {
        if (vf > GEAR_TOP[this.gear - 1] * 0.92 && this.gear < 8 && inp.throttle > 0) { this.gear++; this.shiftTimer = 0.25; this.onShift(this.gear); }
        else if (this.gear > 1 && vf < GEAR_TOP[this.gear - 2] * 0.55) { this.gear--; this.onShift(this.gear); }
      }
      const ratio = this.v < -0.1 ? Math.abs(this.v) / REV_TOP : vf / GEAR_TOP[this.gear - 1];
      this.rpmTarget = clamp(RPM_IDLE + ratio * (RPM_MAX - RPM_IDLE) * 1.05, RPM_IDLE, RPM_MAX) + inp.throttle * 250 * (Math.abs(this.v) < 0.3 ? 1.5 : 0.4);
      if (this.shiftTimer > 0) this.rpmTarget -= 500;

      // Kinematik
      const Lf = DIM.axleF, Lr = DIM.axleR;
      const prevPhi = this.prevPhi ?? this.phi;
      const phiDot = (this.phi - prevPhi) / Math.max(dt, 1e-4);
      this.prevPhi = this.phi;
      const yawRate = (this.v * Math.sin(this.phi) + Lf * phiDot) / (Lf * Math.cos(this.phi) + Lr);
      const old = this.rearAxle.clone(), oldH = this.heading;
      this.heading += yawRate * dt;
      this.rearAxle.x += Math.sin(this.heading) * this.v * dt;
      this.rearAxle.z += Math.cos(this.heading) * this.v * dt;
      this.collide(old, oldH, dir);
    } else {
      // Showroom: Lenkung auf Zielwinkel animieren
      const t = this.phiTarget ?? 0;
      this.phi = lerp(this.phi, t, 1 - Math.exp(-dt * 3));
      this.v = 0;
      this.rpmTarget = this.engineOn ? RPM_IDLE + this.revBoost : 0;
    }

    // Motor
    if (this.engineOn) this.rpm = lerp(this.rpm, this.rpmTarget, 1 - Math.exp(-dt * (this.rpmTarget > this.rpm ? 4 : 2.5)));
    else this.rpm = lerp(this.rpm, 0, 1 - Math.exp(-dt * 3));

    this.place(dt);
    this.animate(dt);
  }

  collide(old, oldH, dir) {
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const j = this.rearAxle.clone().addScaledVector(fwd, DIM.axleR);
    const fh = this.heading + this.phi;
    const front = j.clone().add(new THREE.Vector3(Math.sin(fh), 0, Math.cos(fh)).multiplyScalar(DIM.axleF + 0.75));
    const back = this.rearAxle.clone().addScaledVector(fwd, -0.55);
    const pts = [front, j, back, this.rearAxle];
    for (const o of this.obstacles) {
      for (const p of pts) {
        const d = Math.hypot(p.x - o.x, p.z - o.z);
        if (d < o.r + 0.62) {
          this.rearAxle.copy(old); this.heading = oldH;
          const impact = Math.abs(this.v);
          this.v = -this.v * 0.25;
          if (impact > 0.6) this.onBump(impact);
          return;
        }
      }
    }
    const r = Math.hypot(j.x, j.z);
    if (r > DRIVE_RADIUS) {
      const n = new THREE.Vector3(j.x, 0, j.z).normalize();
      this.rearAxle.addScaledVector(n, -(r - DRIVE_RADIUS) - 0.05);
      this.v *= 0.6;
      this.onBoundary();
    }
  }

  place(dt) {
    const { p } = this;
    const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const joint = this.rearAxle.clone().addScaledVector(fwd, DIM.axleR);
    const fh = this.heading + this.phi;
    const ffwd = new THREE.Vector3(Math.sin(fh), 0, Math.cos(fh));
    const fright = new THREE.Vector3(ffwd.z, 0, -ffwd.x);
    const fa = joint.clone().addScaledVector(ffwd, DIM.axleF);
    const T = DIM.track;
    const hRL = heightAt(this.rearAxle.x + right.x * T, this.rearAxle.z + right.z * T);
    const hRR = heightAt(this.rearAxle.x - right.x * T, this.rearAxle.z - right.z * T);
    const hFL = heightAt(fa.x + fright.x * T, fa.z + fright.z * T);
    const hFR = heightAt(fa.x - fright.x * T, fa.z - fright.z * T);
    const hR = (hRL + hRR) / 2, hF = (hFL + hFR) / 2;
    const targetY = (hR + hF) / 2;
    const targetPitch = -Math.atan2(hF - hR, DIM.axleF + DIM.axleR);
    const targetRoll = Math.atan2(((hRL + hFL) - (hRR + hFR)) / 2, 2 * T);
    const k = 1 - Math.exp(-dt * 14);
    this.y = lerp(this.y, targetY, dt >= 1 ? 1 : k);
    this.pitch = lerp(this.pitch, targetPitch, dt >= 1 ? 1 : k);
    this.roll = lerp(this.roll, targetRoll, dt >= 1 ? 1 : k);

    p.root.position.set(joint.x, this.y, joint.z);
    p.root.rotation.order = 'YXZ';
    p.root.rotation.set(this.pitch, this.heading, this.roll);
    p.front.rotation.y = this.phi;
  }

  animate(dt) {
    const { p } = this;
    this.wheelAngle += (this.v / DIM.wheelR) * dt;
    p.wheels.forEach((w) => (w.rotation.x = this.wheelAngle));
    p.steeringWheel.rotation.y = -this.phi * 5;

    // Motorvibration, abhängig von Drehzahl
    const amp = this.rpm > 100 ? 0.0022 + (this.rpm / RPM_MAX) * 0.0014 : 0;
    const f = this.time * (this.rpm / 60) * 1.5 * Math.PI * 2;
    p.engineShake.position.set(Math.sin(f * 0.5) * amp * 0.6, Math.sin(f) * amp, 0);
    p.engineShake.rotation.z = Math.sin(f * 0.5 + 1) * amp * 0.8;
    // Gelände-Rütteln
    const bump = Math.min(Math.abs(this.v), 6) * 0.0025;
    p.body.position.y = (Math.sin(this.time * 17) * 0.5 + Math.sin(this.time * 29) * 0.5) * bump;

    // Zapfwelle & Kraftheber
    p.pto.rotation.z += this.ptoSpin * dt;
    this.lift = lerp(this.lift, this.liftTarget, 1 - Math.exp(-dt * 2.2));
    p.lowerLinks.forEach((l, i) => (l.rotation.x = this.lift * (i % 2 === 0 ? 0.55 : 0.45)));
    p.topLink.rotation.x = this.lift * 0.35;

    // Partikel: Dieselrauch und Staub
    const load = clamp((this.rpm - RPM_IDLE) / (RPM_MAX - RPM_IDLE), 0, 1);
    const ex = p.exhaust.getWorldPosition(new THREE.Vector3());
    if (this.rpm > 300) {
      const rate = 3 + load * 25 + (this.input.throttle > 0 && Math.abs(this.v) < 2 ? 12 : 0) + this.revBoost / 80;
      this.particles.emit(dt * rate, ex, new THREE.Vector3(0.5, -0.1, 0), 0.22 + load * 0.2, load > 0.5 ? 0.24 : 0.5, 0.28 + load * 0.3, 1.6);
    }
    const speed = Math.abs(this.v);
    if (speed > 1.5) {
      const onPath = pathDist(this.rearAxle.x, this.rearAxle.z) < 2;
      const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      for (const s of [-1, 1]) {
        const w = this.rearAxle.clone().addScaledVector(right, s * DIM.track).addScaledVector(fwd, -Math.sign(this.v) * 0.3);
        w.y = heightAt(w.x, w.z) + 0.1;
        this.particles.emit(dt * speed * (onPath ? 5 : 1.4), w, fwd.clone().multiplyScalar(-Math.sign(this.v) * 0.6).add(new THREE.Vector3(0, 0.6, 0)), 0.35, 0.72, onPath ? 0.35 : 0.14, 2.2, true);
      }
    }
    this.particles.update(dt);
  }
}

// ---------- einfache Partikel (Rauch/Staub) ----------
const pVert = /* glsl */`
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
varying float vAlpha; varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vAlpha = aAlpha; vColor = aColor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (420.0 / -mvPosition.z);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const pFrag = /* glsl */`
varying float vAlpha; varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vColor, a);
  #include <fog_fragment>
}`;

class Particles {
  constructor(max = 500) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.size0 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.dust = new Uint8Array(max);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.color = new Float32Array(max * 3);
    this.cursor = 0;
    this.acc = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      vertexShader: pVert, fragmentShader: pFrag, transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(count, origin, vel, size, brightness, alpha, life, dust = false) {
    this.acc += count;
    while (this.acc >= 1) {
      this.acc -= 1;
      const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
      this.pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.15;
      this.pos[i * 3 + 1] = origin.y + (Math.random() - 0.5) * 0.05;
      this.pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.15;
      this.vel[i * 3] = vel.x + (Math.random() - 0.5) * 0.4;
      this.vel[i * 3 + 1] = vel.y + 0.25 + Math.random() * 0.3;
      this.vel[i * 3 + 2] = vel.z + (Math.random() - 0.5) * 0.4;
      this.life[i] = life * (0.7 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.size0[i] = size; this.alpha0[i] = alpha; this.dust[i] = dust ? 1 : 0;
      const b = brightness;
      if (dust) { this.color[i * 3] = 0.62 * b + 0.25; this.color[i * 3 + 1] = 0.55 * b + 0.2; this.color[i * 3 + 2] = 0.4 * b + 0.12; }
      else { this.color[i * 3] = b; this.color[i * 3 + 1] = b; this.color[i * 3 + 2] = b * 1.02; }
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.vel[i * 3 + 1] += (this.dust[i] ? -0.6 : 0.35) * dt;
      this.vel[i * 3] += 0.25 * dt; // leichter Wind
      for (let k = 0; k < 3; k++) { this.vel[i * 3 + k] *= 1 - 1.2 * dt; this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt; }
      this.size[i] = this.size0[i] * (1 + t * 4);
      this.alpha[i] = this.alpha0[i] * Math.sin(Math.min(t * 3, 1) * Math.PI * 0.5) * (1 - t);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.aSize.needsUpdate = a.aAlpha.needsUpdate = a.aColor.needsUpdate = true;
  }
}
