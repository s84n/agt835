import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt } from './terrain.js';
import { seeded } from './noise.js';

// Feierabend-Ecke unter dem Obstbaum: Holzbank, Apfelkiste, Bierkasten (ohne Marke), Fallobst.
// Liefert außerdem die Sitzposition für die Kamera.

export function woodTexture(seed, base = [150, 108, 66]) {
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

// Parkbank mit gusseisernen Seitenteilen. Alle Teile berühren sich wirklich:
// Fuß → Bein → Sitzauflage → Latten, Hinterbein → schräge Lehnenstrebe → Lehnenlatten,
// Vorderbein bis unter die Armlehne, Armlehne endet an der Lehnenstrebe.
// Wird für die Feierabend-Ecke und die Aussichtsbank verwendet.
export function bench(mat, metal) {
  const wood = [], iron = [];
  const FX = 0.78;                 // Seitenteile bei x = ±0.78
  const SEAT = 0.435;              // Oberkante Sitzauflage
  const BACK0 = { y: 0.41, z: -0.22 }, BACK1 = { y: 0.9, z: -0.335 }; // Lehnenstrebe unten/oben
  const tilt = Math.atan2(BACK1.z - BACK0.z, BACK1.y - BACK0.y);     // negativ: lehnt nach hinten
  const backZ = (y) => BACK0.z + (y - BACK0.y) * Math.tan(tilt);
  const bar = (w, h, d, x, y, z, rx = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    return g;
  };
  for (const s of [-1, 1]) {
    const x = s * FX;
    iron.push(bar(0.05, 0.68, 0.05, x, 0.34, 0.19));                       // Vorderbein bis zur Armlehne
    iron.push(bar(0.05, SEAT, 0.05, x, SEAT / 2, BACK0.z));               // Hinterbein bis zur Sitzauflage
    const len = Math.hypot(BACK1.y - BACK0.y, BACK1.z - BACK0.z);
    iron.push(bar(0.05, len + 0.03, 0.05, x, (BACK0.y + BACK1.y) / 2, (BACK0.z + BACK1.z) / 2, tilt)); // Lehnenstrebe
    iron.push(bar(0.05, 0.05, 0.47, x, SEAT - 0.025, -0.015));            // Sitzauflage vorn–hinten
    const az = backZ(0.68);
    iron.push(bar(0.065, 0.04, 0.215 - az + 0.03, x, 0.7, (az + 0.215) / 2 - 0.0)); // Armlehne
    for (const z of [0.19, BACK0.z]) iron.push(bar(0.08, 0.02, 0.11, x, 0.01, z)); // Füße
  }
  iron.push(bar(2 * FX, 0.04, 0.04, 0, 0.13, BACK0.z));                   // Querstrebe hinten
  iron.push(bar(2 * FX, 0.04, 0.04, 0, 0.13, 0.19));                      // Querstrebe vorn
  iron.push(bar(0.04, 0.05, 0.47, 0, SEAT - 0.025, -0.015));              // Mittelauflage unter den Latten
  // Sitz: 4 Latten auf der Auflage, 2 cm Fuge
  // (hinterste Latte endet genau vor der Lehnenstrebe)
  const SW = 0.095, GAP = 0.018, ST = 0.035;
  for (let i = 0; i < 4; i++) wood.push(bar(1.8, ST, SW, 0, SEAT + ST / 2, 0.225 - SW / 2 - i * (SW + GAP)));
  // Lehne: 3 Latten vorn auf der Strebe verschraubt, gleiche Neigung
  for (const y of [0.55, 0.69, 0.83]) {
    const off = 0.025 + 0.016; // halbe Strebe + halbe Latte
    wood.push(bar(1.8, 0.11, 0.032, 0, y, backZ(y) + off * Math.cos(tilt), tilt));
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
    const a = rnd() * Math.PI * 2, r = 0.6 + rnd() * 2.4;
    const lx = Math.cos(a) * r, lz = Math.sin(a) * r * 0.8 - 2.6;
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
  // kleiner Biertisch vor der Bank, darauf die offene Flasche und ein paar Äpfel
  const table = new THREE.Group();
  table.position.set(0, 0, 0.78);
  const top = [];
  for (let i = 0; i < 4; i++) top.push(box(1.2, 0.035, 0.13, 0, 0.72, -0.21 + i * 0.14));
  const tTop = new THREE.Mesh(mergeGeometries(top), woodMat);
  const legs = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const g = new THREE.BoxGeometry(0.035, 0.74, 0.035);
      g.rotateX(sz * 0.18); g.translate(sx * 0.5, 0.36, sz * 0.12);
      legs.push(g);
    }
    legs.push(box(0.035, 0.035, 0.4, sx * 0.5, 0.2, 0));
  }
  const tLegs = new THREE.Mesh(mergeGeometries(legs), metal);
  for (const o of [tTop, tLegs]) { o.castShadow = true; o.receiveShadow = true; table.add(o); }
  group.add(table);
  const openBottle = new THREE.Mesh(bottle, glass);
  openBottle.position.set(0.28, 0.74, 0.86);
  openBottle.castShadow = true;
  group.add(openBottle);
  const tableApples = new THREE.InstancedMesh(appleGeo, appleMat, 3);
  [[-0.3, 0.76, 0.72], [-0.22, 0.76, 0.8], [-0.36, 0.76, 0.84]].forEach(([ax, ay, az], k) => {
    tableApples.setMatrixAt(k, m4.compose(p.set(ax, ay, az), q.setFromEuler(new THREE.Euler(k, k * 2, 0)), s));
    tableApples.setColorAt(k, cols[k]);
  });
  tableApples.castShadow = true;
  group.add(tableApples);

  // Kamera: auf der Bank sitzend, Blick über Traktor und Tal
  // leicht hinter und über der Bank (Schulterblick): Bank, Kiste und Bierkasten im Vordergrund
  // auf der Bank sitzend: Augenhöhe ~1,2 m, Blick über den Tisch zum Traktor
  const seat = new THREE.Vector3(-0.1, 1.2, 0.02);
  const lookLocal = new THREE.Vector3(0, 0.62, 5.0);
  group.updateMatrixWorld(true);
  const seatWorld = group.localToWorld(seat.clone());
  const lookWorld = group.localToWorld(lookLocal.clone());

  const obstacles = [
    { x: group.localToWorld(new THREE.Vector3(0, 0, 0)).x, z: group.localToWorld(new THREE.Vector3(0, 0, 0)).z, r: 0.95 },
  ];
  for (const o of [appleCrate.position, beer.position, table.position]) {
    const w = group.localToWorld(o.clone());
    obstacles.push({ x: w.x, z: w.z, r: 0.35 });
  }
  return { group, obstacles, seatWorld, lookWorld };
}
