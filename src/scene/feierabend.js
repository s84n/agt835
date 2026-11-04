import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt } from './terrain.js';
import { seeded } from './noise.js';

// Feierabend-Ecke unter dem Obstbaum: Holzbank, Apfelkiste, Bierkasten (ohne Marke), Fallobst.
// Liefert außerdem die Sitzposition für die Kamera.

function woodTexture(seed, base = [150, 108, 66]) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  const rnd = seeded(seed);
  g.fillStyle = `rgb(${base.join(',')})`; g.fillRect(0, 0, 256, 64);
  for (let i = 0; i < 70; i++) {
    const y = rnd() * 64, l = (rnd() - 0.5) * 50;
    g.strokeStyle = `rgba(${base[0] + l | 0},${base[1] + l * 0.8 | 0},${base[2] + l * 0.6 | 0},0.55)`;
    g.lineWidth = 0.6 + rnd() * 1.6;
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 32) g.lineTo(x, y + Math.sin(x / 40 + i) * 2.5 * rnd());
    g.stroke();
  }
  // Astlöcher
  for (let i = 0; i < 3; i++) {
    const x = rnd() * 256, y = rnd() * 64;
    g.fillStyle = 'rgba(70,45,25,0.7)'; g.beginPath(); g.ellipse(x, y, 5, 2.5, 0, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

const box = (w, h, d, x, y, z, ry = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};

function bench(mat, metal) {
  const wood = [], iron = [];
  // Sitz: 3 Latten
  for (let i = 0; i < 3; i++) wood.push(box(1.7, 0.035, 0.11, 0, 0.45, -0.13 + i * 0.13));
  // Lehne: 2 Latten, leicht nach hinten geneigt
  for (let i = 0; i < 2; i++) {
    const g = new THREE.BoxGeometry(1.7, 0.1, 0.03);
    g.rotateX(-0.22); g.translate(0, 0.66 + i * 0.16, -0.24 - i * 0.035);
    wood.push(g);
  }
  // Gusseiserne Seitenteile
  for (const s of [-1, 1]) {
    iron.push(box(0.05, 0.45, 0.05, s * 0.75, 0.225, 0.14));
    iron.push(box(0.05, 0.86, 0.05, s * 0.75, 0.43, -0.22));
    iron.push(box(0.05, 0.05, 0.42, s * 0.75, 0.42, -0.04));
    iron.push(box(0.05, 0.04, 0.34, s * 0.75, 0.62, 0.0));
  }
  const g = new THREE.Group();
  const w = new THREE.Mesh(mergeGeometries(wood), mat);
  const m = new THREE.Mesh(mergeGeometries(iron), metal);
  for (const o of [w, m]) { o.castShadow = true; o.receiveShadow = true; g.add(o); }
  return g;
}

function crate(mat, w, h, d) {
  const parts = [];
  for (let i = 0; i < 3; i++) {
    parts.push(box(w, h / 3 - 0.02, 0.02, 0, h / 6 + i * h / 3, d / 2));
    parts.push(box(w, h / 3 - 0.02, 0.02, 0, h / 6 + i * h / 3, -d / 2));
    parts.push(box(0.02, h / 3 - 0.02, d, w / 2, h / 6 + i * h / 3, 0));
    parts.push(box(0.02, h / 3 - 0.02, d, -w / 2, h / 6 + i * h / 3, 0));
  }
  parts.push(box(w, 0.02, d, 0, 0.01, 0));
  const m = new THREE.Mesh(mergeGeometries(parts), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

export function createRestArea(x, z, rotY) {
  const group = new THREE.Group();
  group.position.set(x, heightAt(x, z), z);
  group.rotation.y = rotY;
  const rnd = seeded(77);

  const woodMat = new THREE.MeshStandardMaterial({ map: woodTexture(3), roughness: 0.85 });
  const crateMat = new THREE.MeshStandardMaterial({ map: woodTexture(9, [176, 140, 96]), roughness: 0.9 });
  const metal = new THREE.MeshStandardMaterial({ color: '#232527', roughness: 0.6, metalness: 0.5 });
  group.add(bench(woodMat, metal));

  // Apfelkiste links neben der Bank
  const appleCrate = crate(crateMat, 0.5, 0.3, 0.36);
  appleCrate.position.set(-1.25, 0, 0.15);
  appleCrate.rotation.y = 0.25;
  group.add(appleCrate);

  // Äpfel: in der Kiste + Fallobst unter dem Baum (eine Instanz-Mesh, zwei Farbtöne)
  const appleGeo = new THREE.SphereGeometry(0.038, 10, 8);
  appleGeo.scale(1, 0.9, 1);
  const appleMat = new THREE.MeshStandardMaterial({ roughness: 0.45 });
  const N = 60;
  const apples = new THREE.InstancedMesh(appleGeo, appleMat, N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  const cols = ['#b5241c', '#c8361f', '#9a1d17', '#c9a23a', '#7fa13a'].map((c) => new THREE.Color(c));
  let i = 0;
  for (; i < 28; i++) { // Kiste
    const lx = (rnd() - 0.5) * 0.4, lz = (rnd() - 0.5) * 0.28, ly = 0.22 + rnd() * 0.1;
    p.set(lx, ly, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.25).add(appleCrate.position);
    q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, 0));
    apples.setMatrixAt(i, m4.compose(p, q, s));
    apples.setColorAt(i, cols[Math.floor(rnd() * 3)]);
  }
  for (; i < N; i++) { // Fallobst im Gras
    const a = rnd() * Math.PI * 2, r = 0.8 + rnd() * 2.6;
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r - 1.0;
    const wx = x + lx * Math.cos(rotY) + lz * Math.sin(rotY), wz = z - lx * Math.sin(rotY) + lz * Math.cos(rotY);
    p.set(lx, heightAt(wx, wz) - group.position.y + 0.03, lz);
    q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, 0));
    apples.setMatrixAt(i, m4.compose(p, q, s));
    apples.setColorAt(i, cols[Math.floor(rnd() * cols.length)].clone().multiplyScalar(0.75 + rnd() * 0.25));
  }
  apples.castShadow = true; apples.receiveShadow = true;
  group.add(apples);

  // Bierkasten rechts (neutral grün, ohne Marke) mit Flaschen
  const beer = new THREE.Group();
  beer.position.set(1.2, 0, 0.2);
  beer.rotation.y = -0.18;
  const crateBox = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.28), new THREE.MeshStandardMaterial({ color: '#2e5a35', roughness: 0.55 }));
  crateBox.position.y = 0.15; crateBox.castShadow = true;
  beer.add(crateBox);
  const bottle = mergeGeometries([
    new THREE.CylinderGeometry(0.03, 0.03, 0.16, 10).translate(0, 0.08, 0),
    new THREE.CylinderGeometry(0.012, 0.03, 0.06, 10).translate(0, 0.19, 0),
    new THREE.CylinderGeometry(0.013, 0.013, 0.04, 8).translate(0, 0.24, 0),
  ]);
  const glass = new THREE.MeshStandardMaterial({ color: '#4a2a0c', roughness: 0.15, metalness: 0.1 });
  const bottles = new THREE.InstancedMesh(bottle, glass, 19);
  let b = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
    if (r === 1 && c === 3) continue; // eine fehlt – die steht auf der Bank
    p.set(-0.16 + c * 0.08, 0.1, -0.1 + r * 0.068);
    bottles.setMatrixAt(b++, m4.compose(p, q.identity(), s));
  }
  bottles.castShadow = true;
  beer.add(bottles);
  group.add(beer);
  const openBottle = new THREE.Mesh(bottle, glass);
  openBottle.position.set(0.55, 0.47, 0.02);
  openBottle.castShadow = true;
  group.add(openBottle);

  // Kamera: auf der Bank sitzend, Blick über Traktor und Tal
  // leicht hinter und über der Bank (Schulterblick): Bank, Kiste und Bierkasten im Vordergrund
  const seat = new THREE.Vector3(-0.9, 1.75, -2.1);
  const lookLocal = new THREE.Vector3(0.6, 0.35, 6.0);
  group.updateMatrixWorld(true);
  const seatWorld = group.localToWorld(seat.clone());
  const lookWorld = group.localToWorld(lookLocal.clone());

  const obstacles = [
    { x: group.localToWorld(new THREE.Vector3(0, 0, 0)).x, z: group.localToWorld(new THREE.Vector3(0, 0, 0)).z, r: 0.95 },
  ];
  for (const o of [appleCrate.position, beer.position]) {
    const w = group.localToWorld(o.clone());
    obstacles.push({ x: w.x, z: w.z, r: 0.35 });
  }
  return { group, obstacles, seatWorld, lookWorld };
}
