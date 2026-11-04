import * as THREE from 'three';

export function createMaterials() {
  const paint = new THREE.MeshPhysicalMaterial({
    color: '#c91d16', roughness: 0.34, metalness: 0.0,
    clearcoat: 0.9, clearcoatRoughness: 0.12, envMapIntensity: 1.0,
  });
  const paintMatte = new THREE.MeshPhysicalMaterial({ color: '#bf1f18', roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.35 });
  const plastic = new THREE.MeshStandardMaterial({ color: '#1a1b1c', roughness: 0.62, metalness: 0.05 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: '#2b2d2f', roughness: 0.5, metalness: 0.55 });
  const steel = new THREE.MeshStandardMaterial({ color: '#8d9195', roughness: 0.35, metalness: 0.8 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#151515', roughness: 0.93, metalness: 0.0, side: THREE.DoubleSide });
  const rim = new THREE.MeshStandardMaterial({ color: '#b7bbbd', roughness: 0.42, metalness: 0.55 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#e6eaee', roughness: 0.06, metalness: 1.0 });
  const seat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.55, metalness: 0.0 });
  const headGlass = new THREE.MeshStandardMaterial({ color: '#dfe6ea', roughness: 0.1, metalness: 0.2, emissive: '#fff4d6', emissiveIntensity: 0 });
  const amber = new THREE.MeshStandardMaterial({ color: '#f08a1c', roughness: 0.25, emissive: '#ff8a10', emissiveIntensity: 0 });
  const tail = new THREE.MeshStandardMaterial({ color: '#b3120f', roughness: 0.25, emissive: '#ff1a0a', emissiveIntensity: 0 });
  const checker = new THREE.MeshStandardMaterial({ color: '#3a3c3e', roughness: 0.6, metalness: 0.6, map: checkerTex() });

  // Gebrauchsspuren (werden in grime.js als Shader angewendet)
  paint.userData.grime = { amount: 0.75, low: 0.3, high: 0.95, scale: 5, micro: 0.022, microScale: 140 };
  paintMatte.userData.grime = { amount: 0.85, low: 0.3, high: 0.9, scale: 6, micro: 0.04 };
  plastic.userData.grime = { amount: 0.7, low: 0.35, high: 1.0, scale: 6, micro: 0.09, microScale: 90 };
  darkMetal.userData.grime = { amount: 0.85, low: 0.2, high: 0.85, scale: 7, micro: 0.12, microScale: 70, color: '#5e4a35' };
  rim.userData.grime = { amount: 0.4, local: true, heightMix: 0, scale: 9, micro: 0.05, color: '#6a573f' };
  rubber.userData.grime = { amount: 0.5, local: true, heightMix: 0, scale: 8, micro: 0.4, microScale: 55, color: '#4d3d2b' };
  seat.userData.grime = { amount: 0.0, micro: 0.18, microScale: 160 };
  steel.userData.grime = { amount: 0.4, low: 0.2, high: 0.8, scale: 8, micro: 0.05 };

  return { paint, paintMatte, plastic, darkMetal, steel, rubber, rim, chrome, seat, headGlass, amber, tail, checker,
    grille: new THREE.MeshStandardMaterial({ map: grilleTex(), roughness: 0.7, metalness: 0.3 }),
    stripes: new THREE.MeshStandardMaterial({ map: stripeTex(), roughness: 0.4 }),
    decal: new THREE.MeshStandardMaterial({ map: decalTex(), transparent: true, roughness: 0.35 }),
    plate: new THREE.MeshStandardMaterial({ map: plateTex(), roughness: 0.4 }),
    signature: signatureMaterial(),
  };
}

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(c, srgb = true) { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; }

function decalTex() {
  const [c, g] = canvas(1024, 160);
  g.fillStyle = '#121212';
  roundRect(g, 0, 18, 1024, 124, 22); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 3;
  roundRect(g, 8, 26, 1008, 108, 18); g.stroke();
  g.fillStyle = '#f2f2f2';
  g.font = 'italic 600 64px Georgia, "Times New Roman", serif';
  g.textBaseline = 'middle';
  g.fillText('Agromehanika', 40, 84);
  g.font = '700 82px Georgia, "Times New Roman", serif';
  g.textAlign = 'right';
  g.fillText('AGT 835', 990, 86);
  return tex(c);
}

// Signatur „Jens W.“ – handschriftlich, wie mit Lackstift aufgebracht
function signatureMaterial() {
  const [c, g] = canvas(1024, 300);
  const t = tex(c);
  const draw = () => {
    g.clearRect(0, 0, 1024, 300);
    g.save();
    g.translate(512, 150);
    g.rotate(-0.06);
    g.font = '700 168px "Dancing Script", "Segoe Script", "Brush Script MT", cursive';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // leichter Schatten für Lesbarkeit auf dem roten Lack
    g.fillStyle = 'rgba(60,0,0,0.35)';
    g.fillText('Jens W.', 4, 6);
    g.fillStyle = '#f6eedb';
    g.fillText('Jens W.', 0, 0);
    // Schwung unter der Unterschrift
    const w = g.measureText('Jens W.').width;
    g.strokeStyle = '#f6eedb'; g.lineWidth = 7; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-w * 0.48, 78);
    g.bezierCurveTo(-w * 0.1, 108, w * 0.25, 52, w * 0.52, 70);
    g.stroke();
    g.restore();
    t.needsUpdate = true;
  };
  draw();
  // Schrift nachladen und neu zeichnen, sobald sie verfügbar ist
  if (document.fonts?.load) document.fonts.load('700 168px "Dancing Script"').then(draw).catch(() => {});
  return new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
}

function grilleTex() {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#0d0e0f'; g.fillRect(0, 0, 256, 128);
  g.strokeStyle = '#3a3c3e'; g.lineWidth = 1.4;
  for (let i = -128; i < 256; i += 7) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke(); g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke(); }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 256, 3);
  return tex(c);
}

function stripeTex() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#f5f5f2'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#d0201a';
  for (let i = -256; i < 512; i += 72) { g.beginPath(); g.moveTo(i, 256); g.lineTo(i + 36, 256); g.lineTo(i + 36 + 256, 0); g.lineTo(i + 256, 0); g.closePath(); g.fill(); }
  return tex(c);
}

function plateTex() {
  const [c, g] = canvas(512, 256);
  g.fillStyle = '#f4f4ee'; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#1f6b2c'; g.lineWidth = 12; g.strokeRect(8, 8, 496, 240);
  g.fillStyle = '#1d4fb0'; g.fillRect(14, 14, 70, 228);
  g.fillStyle = '#ffd400'; g.font = '700 30px sans-serif'; g.textAlign = 'center'; g.fillText('D', 49, 220);
  g.fillStyle = '#1f6b2c';
  g.font = '700 108px "Arial Narrow", Arial, sans-serif';
  g.fillText('AGT', 300, 118);
  g.fillText('835', 300, 228);
  return tex(c);
}

function checkerTex() {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#6f7275'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#9a9da0';
  for (let y = 0; y < 128; y += 16) for (let x = 0; x < 128; x += 16) {
    g.save(); g.translate(x + 8, y + 8); g.rotate(((x + y) / 16) % 2 ? 0.8 : -0.8); g.fillRect(-5, -1.5, 10, 3); g.restore();
  }
  const t = tex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 2); return t;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
