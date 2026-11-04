import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// Lichtstrahlen durch Baumkronen (Screen-Space, halbe Auflösung):
// 1) helle HDR-Bereiche (Himmel/Sonne zwischen den Blättern) herausfiltern und radial
//    Richtung Sonne verwischen  2) additiv aufs Bild legen.
// Ist die Sonne nicht im Bild, wird der Pass komplett übersprungen.

const blurFrag = /* glsl */`
uniform sampler2D tDiffuse; uniform vec2 uSun; uniform float uThreshold; uniform float uAspect;
varying vec2 vUv;
const int N = 36;
void main() {
  vec2 d = (vUv - uSun) / float(N) * 0.9;
  vec2 uv = vUv;
  float decay = 1.0, sum = 0.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    vec3 c = texture2D(tDiffuse, uv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    acc += c * smoothstep(uThreshold, uThreshold * 1.8, l) * decay;
    sum += decay;
    decay *= 0.955;
    uv -= d;
  }
  // nahe der Sonne stärker, zum Rand hin ausblenden
  vec2 rel = (vUv - uSun) * vec2(uAspect, 1.0);
  float fall = 1.0 - smoothstep(0.0, 0.85, length(rel));
  gl_FragColor = vec4(acc / sum * fall, 1.0);
}`;

const compFrag = /* glsl */`
uniform sampler2D tDiffuse; uniform sampler2D tRays; uniform float uStrength; uniform vec3 uTint;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  c.rgb += texture2D(tRays, vUv).rgb * uTint * uStrength;
  gl_FragColor = c;
}`;

const vert = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

export class GodRaysPass extends Pass {
  constructor() {
    super();
    this.rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uThreshold: { value: 1.1 }, uAspect: { value: 1 } },
      vertexShader: vert, fragmentShader: blurFrag, depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tRays: { value: this.rt.texture }, uStrength: { value: 0 }, uTint: { value: new THREE.Color(1, 0.85, 0.6) } },
      vertexShader: vert, fragmentShader: compFrag, depthTest: false, depthWrite: false,
    });
    this.quadBlur = new FullScreenQuad(this.blur);
    this.quadComp = new FullScreenQuad(this.comp);
    this.strength = 0;
    this.needsSwap = true;
  }

  setSize(w, h) {
    this.rt.setSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    this.blur.uniforms.uAspect.value = w / Math.max(h, 1);
  }

  // pro Frame aus main.js: Sonnenrichtung + Kamera → Bildschirmposition und Stärke
  updateSun(camera, sunDir, baseStrength, tint) {
    const p = camera.position.clone().addScaledVector(sunDir, 1000).project(camera);
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const facing = camDir.dot(sunDir);
    this.blur.uniforms.uSun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    // nur wenn die Sonne vor der Kamera und nahe am / im Bild ist
    const onScreen = Math.max(Math.abs(p.x), Math.abs(p.y));
    const vis = facing > 0 ? THREE.MathUtils.smoothstep(1.6, 0.9, onScreen) : 0;
    this.strength = baseStrength * vis;
    this.comp.uniforms.uStrength.value = this.strength;
    if (tint) this.comp.uniforms.uTint.value.copy(tint);
  }

  render(renderer, writeBuffer, readBuffer) {
    if (this.strength < 0.005) {
      // Pass überspringen: Bild unverändert weiterreichen
      this.comp.uniforms.tDiffuse.value = readBuffer.texture;
      this.comp.uniforms.uStrength.value = 0;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      this.quadComp.render(renderer);
      return;
    }
    this.blur.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.rt);
    this.quadBlur.render(renderer);
    this.comp.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quadComp.render(renderer);
  }
}
