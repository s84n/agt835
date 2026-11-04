import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createMaterials } from './materials.js';
import { applyGrimeToObject } from './grime.js';

// Prozedurales Modell des Agromehanika AGT 835 (nach den Fotos).
// Koordinaten: Ursprung = Knickgelenk auf Bodenhöhe, +Z = vorne, +X = rechts, Maße in Metern.

export const DIM = {
  wheelR: 0.4, wheelW: 0.34, track: 0.56, axleF: 0.66, axleR: 0.66,
};

const box = (w, h, d, r = 0.02, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2) * 0.999);

function mesh(geo, mat, x = 0, y = 0, z = 0, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function tube(points, radius, mat, parent, segs = 48) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'catmullrom', 0.2);
  return mesh(new THREE.TubeGeometry(curve, segs, radius, 10, false), mat, 0, 0, 0, parent);
}

// ---------- Rad ----------
function tireGeometry() {
  const { wheelR } = DIM;
  const rIn = 0.25, rOut = wheelR - 0.035, hw = DIM.wheelW / 2, cr = 0.065;
  const pts = [];
  pts.push(new THREE.Vector2(rIn, -hw + 0.03));
  pts.push(new THREE.Vector2(rIn + 0.04, -hw));
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(rOut - cr + Math.cos(a) * cr, -hw + cr + Math.sin(a) * cr)); }
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(new THREE.Vector2(rOut - cr + Math.cos(a) * cr, hw - cr + Math.sin(a) * cr)); }
  pts.push(new THREE.Vector2(rIn + 0.04, hw));
  pts.push(new THREE.Vector2(rIn, hw - 0.03));
  const lathe = new THREE.LatheGeometry(pts, 64);
  lathe.rotateZ(Math.PI / 2);
  const parts = [lathe];
  // Stollen (Chevron, wie die AS-Bereifung auf den Fotos)
  const N = 20;
  for (let s = -1; s <= 1; s += 2) {
    for (let i = 0; i < N; i++) {
      // Stollen reichen tief in den Reifenkörper (Höhe 11 cm, davon ~3,7 cm sichtbar),
      // damit auch an den abgerundeten Schultern keine Lücken entstehen
      const lug = new THREE.BoxGeometry(0.16, 0.11, 0.065, 3, 1, 1);
      lug.rotateY(s * 0.55);
      lug.translate(s * 0.08, rOut - 0.018, 0);
      // äußeres Ende der Schulter folgen lassen (leicht nach innen ziehen)
      const lp = lug.attributes.position;
      for (let v = 0; v < lp.count; v++) {
        const ax = Math.abs(lp.getX(v));
        if (lp.getY(v) > rOut - 0.02 && ax > hw - cr) lp.setY(v, lp.getY(v) - (ax - (hw - cr)) * 0.45);
      }
      lug.rotateX(((i + (s > 0 ? 0.5 : 0)) / N) * Math.PI * 2);
      parts.push(lug);
    }
  }
  return mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g.toNonIndexed(); }));
}

function rimGeometry() {
  const parts = [];
  const barrel = new THREE.CylinderGeometry(0.252, 0.252, 0.27, 28, 1, true).rotateZ(Math.PI / 2);
  parts.push(barrel);
  const disc = new THREE.CylinderGeometry(0.245, 0.245, 0.02, 28).rotateZ(Math.PI / 2).translate(0.02, 0, 0);
  parts.push(disc);
  const ring = new THREE.TorusGeometry(0.185, 0.018, 6, 28).rotateY(Math.PI / 2).translate(0.035, 0, 0);
  parts.push(ring);
  const hub = new THREE.CylinderGeometry(0.075, 0.09, 0.07, 18).rotateZ(Math.PI / 2).translate(0.065, 0, 0);
  parts.push(hub);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.CylinderGeometry(0.012, 0.012, 0.04, 6).rotateZ(Math.PI / 2).translate(0.05, Math.sin(a) * 0.12, Math.cos(a) * 0.12);
    parts.push(b);
  }
  return mergeGeometries(parts.map((g) => { g.deleteAttribute('uv'); return g.index ? g.toNonIndexed() : g; }));
}

export function createTractor() {
  const M = createMaterials();
  const root = new THREE.Group();
  root.name = 'AGT835';
  const body = new THREE.Group(); // für Motorvibration
  root.add(body);

  const front = new THREE.Group(); front.name = 'Vorderwagen';
  const rear = new THREE.Group(); rear.name = 'Hinterwagen';
  body.add(front, rear);
  const engineShake = new THREE.Group();
  front.add(engineShake);

  const tireGeo = tireGeometry();
  const rimGeo = rimGeometry();
  const wheels = [];
  function addWheel(parent, x, z) {
    const g = new THREE.Group();
    g.position.set(x, DIM.wheelR, z);
    if (x < 0) g.scale.x = -1;
    const spin = new THREE.Group();
    g.add(spin);
    mesh(tireGeo, M.rubber, 0, 0, 0, spin);
    mesh(rimGeo, M.rim, 0, 0, 0, spin);
    parent.add(g);
    wheels.push(spin);
    return g;
  }

  // ===================== VORDERWAGEN =====================
  const { track, axleF, axleR, wheelR } = DIM;
  addWheel(front, track, axleF);
  addWheel(front, -track, axleF);

  // Rahmen, Achse, Gelenk
  mesh(box(0.34, 0.24, 1.7, 0.03), M.darkMetal, 0, 0.5, 0.85, front);
  mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.92, 12).rotateZ(Math.PI / 2), M.darkMetal, 0, wheelR, axleF, front);
  mesh(new THREE.SphereGeometry(0.15, 16, 12), M.darkMetal, 0, wheelR, axleF, front).scale.set(1.2, 0.9, 1);
  mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 16), M.steel, 0, 0.5, 0.0, front);

  // Maße nach Foto: Haube von z 0.50 bis 1.62 (Front ~0.96 m vor der Vorderachse), flach, Oberkante ~1.16 m
  const HZ0 = 0.5, HZ1 = 1.62, HL = HZ1 - HZ0, HZC = (HZ0 + HZ1) / 2;

  // Motor (liegt unter der flachen Haube sichtbar frei, wie auf dem Foto)
  mesh(box(0.46, 0.32, 0.82, 0.03), M.darkMetal, 0, 0.73, 1.0, engineShake);
  for (let i = 0; i < 3; i++) {
    mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.1, 10), M.plastic, 0.12, 0.92, 0.78 + i * 0.2, engineShake);
    tube([[0.12, 0.95, 0.78 + i * 0.2], [0.22, 0.93, 0.76 + i * 0.2], [0.27, 0.82, 0.92]], 0.008, M.steel, engineShake, 12);
  }
  mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 18).rotateZ(Math.PI / 2), M.darkMetal, -0.24, 0.68, 0.85, engineShake); // Lichtmaschine
  mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.3, 14).rotateX(Math.PI / 2), M.plastic, -0.17, 0.82, 1.15, engineShake); // Luftfilter
  tube([[-0.2, 0.6, 1.35], [-0.28, 0.55, 1.15], [-0.27, 0.55, 0.6], [-0.15, 0.45, 0.25]], 0.025, M.plastic, engineShake, 20); // Schlauch
  tube([[0.25, 0.86, 0.9], [0.3, 0.7, 0.85], [0.3, 0.48, 0.7], [0.3, 0.42, 0.5]], 0.028, M.darkMetal, engineShake, 16); // Auspuffrohr
  mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.6, 10).rotateX(Math.PI / 2), M.darkMetal, 0.2, 0.5, 0.95, engineShake);

  // Haube (flacher als zuvor, länger nach vorn)
  const hood = mesh(box(0.72, 0.25, HL, 0.08, 4), M.paint, 0, 1.035, HZC, engineShake);
  hood.name = 'Haube';
  // Lochblech-Seitenteile mit 6 runden Löchern – vorn direkt unter der Haube
  const PW = 0.42, PH = 0.3, PY = 0.62;
  const sideShape = new THREE.Shape();
  sideShape.moveTo(0, 0); sideShape.lineTo(PW, 0); sideShape.lineTo(PW, PH); sideShape.lineTo(0, PH); sideShape.closePath();
  for (let cx = 0; cx < 3; cx++) for (let cy = 0; cy < 2; cy++) {
    const h = new THREE.Path();
    h.absarc(0.1 + cx * 0.105, 0.11 + cy * 0.11, 0.036, 0, Math.PI * 2, true);
    sideShape.holes.push(h);
  }
  const sideGeo = new THREE.ExtrudeGeometry(sideShape, { depth: 0.025, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2, curveSegments: 18 });
  for (const s of [-1, 1]) {
    const p = mesh(sideGeo, M.paint, s * 0.345, PY, s > 0 ? HZ1 : HZ1 - PW, engineShake);
    p.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
    // dunkler Hintergrund hinter den Löchern
    mesh(new THREE.PlaneGeometry(PW, PH), M.plastic, s * 0.325, PY + PH / 2, HZ1 - PW / 2, engineShake).rotation.y = s * Math.PI / 2;
    // Blinker vorne seitlich, an der unteren Ecke des Lochblechs
    mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.05, 16).rotateZ(Math.PI / 2), M.amber, s * 0.37, PY + 0.17, HZ1 - 0.06, engineShake).userData.blinker = s;
    // Schriftzug auf der Haube
    const d = mesh(new THREE.PlaneGeometry(0.62, 0.09), M.decal, s * 0.362, 1.035, 0.88, engineShake);
    d.rotation.y = s * Math.PI / 2;
    d.castShadow = false;
    // Unterschrift des Ideengebers – vorne auf der Haube, auf Höhe des Schriftzugs
    const sig = mesh(new THREE.PlaneGeometry(0.33, 0.096), M.signature, s * 0.3625, 1.035, 1.36, engineShake);
    sig.rotation.y = s * Math.PI / 2;
    sig.castShadow = false;
  }
  // Front: Kühlergrill unter der Haubenkante + Lampenträger + Scheinwerfer
  mesh(box(0.66, 0.1, 0.1, 0.01), M.plastic, 0, 0.87, HZ1 - 0.05, engineShake);
  mesh(new THREE.PlaneGeometry(0.62, 0.2), M.grille, 0, 0.98, HZ1 + 0.003, engineShake);
  mesh(box(0.7, 0.2, 0.12, 0.02), M.plastic, 0, 0.76, HZ1 - 0.04, engineShake);
  const headlights = [];
  for (const s of [-1, 1]) {
    mesh(box(0.17, 0.12, 0.05, 0.015), M.chrome, s * 0.2, 0.76, HZ1 + 0.035, engineShake);
    const glass = mesh(new THREE.PlaneGeometry(0.15, 0.1), M.headGlass, s * 0.2, 0.76, HZ1 + 0.0615, engineShake);
    glass.castShadow = false;
    const spot = new THREE.SpotLight(0xfff1d0, 0, 28, 0.55, 0.6, 1.4);
    spot.position.set(s * 0.2, 0.76, HZ1 + 0.08);
    spot.target.position.set(s * 0.4, 0.0, 9);
    engineShake.add(spot, spot.target);
    headlights.push(spot);
  }
  // Frontgewicht / Trittkasten (nach Detailfoto): deutlich breiter als die Haube, steht seitlich
  // als Trittfläche über, Profil läuft vorn spitz zu, Riffelblech, Warnstreifen oben auf der Kante.
  const BW = 1.04;                       // Breite: ~16 cm Überstand je Seite gegenüber der Haube
  const B = { z0: 1.27, zb: 1.71, zt: 1.73, ztip: 1.86, y0: 0.36, y1: 0.62, ytip: 0.5 };
  const bShape = new THREE.Shape();
  bShape.moveTo(B.z0, B.y0);
  bShape.lineTo(B.zb, B.y0);
  bShape.lineTo(B.ztip, B.ytip);
  bShape.lineTo(B.zt, B.y1);
  bShape.lineTo(B.z0, B.y1);
  bShape.closePath();
  const bGeo = new THREE.ExtrudeGeometry(bShape, { depth: BW - 0.02, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 2 });
  bGeo.rotateY(-Math.PI / 2);
  const plateMat = M.checker.clone();
  plateMat.color.set('#26282a');
  plateMat.map = M.checker.map.clone(); plateMat.map.repeat.set(5, 5); plateMat.map.needsUpdate = true;
  plateMat.userData.grime = { amount: 0.8, low: 0.3, high: 0.9, scale: 7, micro: 0.06, color: '#5e4a35', rust: 0.55, dust: 0.9 };
  mesh(bGeo, plateMat, BW / 2 - 0.01, 0, 0, front);
  // Warnstreifen oben auf der Vorderkante (liegend)
  const topStripe = mesh(new THREE.PlaneGeometry(BW - 0.06, 0.15), M.stripes, 0, B.y1 + 0.013, B.zt - 0.09, front);
  topStripe.rotation.x = -Math.PI / 2; topStripe.castShadow = false;
  // Obere Schrägfläche vorn: Warntafeln links/rechts, Kennzeichen mittig
  const slopeAng = Math.atan2(B.ztip - B.zt, B.y1 - B.ytip);
  const sc = new THREE.Vector3(0, (B.y1 + B.ytip) / 2, (B.zt + B.ztip) / 2);
  const sn = new THREE.Vector3(0, Math.sin(slopeAng), Math.cos(slopeAng)).multiplyScalar(0.013);
  for (const s of [-1, 1]) {
    const st = mesh(new THREE.PlaneGeometry(0.3, 0.13), M.stripes, s * 0.33, sc.y + sn.y, sc.z + sn.z, front);
    st.rotation.x = -slopeAng; st.castShadow = false;
    // seitlicher Reflektor auf dem Riffelblech
    mesh(new THREE.PlaneGeometry(0.08, 0.035), M.amber, s * (BW / 2 + 0.002), 0.47, 1.62, front).rotation.y = s * Math.PI / 2;
  }
  const pl = mesh(new THREE.PlaneGeometry(0.24, 0.12), M.plate, 0, sc.y + sn.y, sc.z + sn.z, front);
  pl.rotation.x = -slopeAng; pl.castShadow = false;
  // Träger zum Rahmen
  mesh(box(0.3, 0.16, 0.2, 0.02), M.darkMetal, 0, 0.5, 1.2, front);

  // Vordere Kotflügel als lange, flache Trittflächen (schwarz), wie auf dem Foto
  const fShape = new THREE.Shape();
  const T = 0.035;
  fShape.moveTo(0.12, 0.64);
  fShape.quadraticCurveTo(0.16, 0.9, 0.34, 0.915);
  fShape.lineTo(0.84, 0.925);
  fShape.quadraticCurveTo(0.95, 0.925, 1.0, 0.84);
  fShape.lineTo(1.0 - T, 0.83);
  fShape.quadraticCurveTo(0.93, 0.89, 0.84, 0.89);
  fShape.lineTo(0.34, 0.88);
  fShape.quadraticCurveTo(0.19, 0.87, 0.12 + T, 0.64);
  fShape.closePath();
  const fGeo = new THREE.ExtrudeGeometry(fShape, { depth: 0.36, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 2, curveSegments: 12 });
  fGeo.rotateY(-Math.PI / 2); // Profil liegt in der Z/Y-Ebene, Breite entlang X
  const ribs = [];
  for (let i = 0; i < 9; i++) ribs.push(new THREE.BoxGeometry(0.3, 0.006, 0.012).translate(0, 0.937, 0.4 + i * 0.05));
  const ribGeo = mergeGeometries(ribs);
  for (const s of [-1, 1]) {
    mesh(fGeo, M.plastic, s * track + 0.18, 0, 0, front);
    mesh(ribGeo, M.plastic, s * track, 0, 0, front); // Rillen als Rutschschutz
    mesh(box(0.2, 0.05, 0.08, 0.01), M.darkMetal, s * 0.31, 0.86, 0.55, front); // Halter am Rahmen
    mesh(box(0.2, 0.05, 0.08, 0.01), M.darkMetal, s * 0.31, 0.84, 0.3, front);
  }

  // Armaturenträger + Lenksäule
  mesh(box(0.36, 0.5, 0.28, 0.05), M.plastic, 0, 0.98, 0.3, front);
  mesh(box(0.3, 0.08, 0.18, 0.03), M.plastic, 0, 1.24, 0.24, front).rotation.x = -0.35;
  const column = new THREE.Group();
  column.position.set(0, 1.08, 0.12);
  column.rotation.x = -0.5;
  front.add(column);
  mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.32, 10), M.plastic, 0, 0.12, 0, column);
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(0, 0.28, 0);
  column.add(steeringWheel);
  mesh(new THREE.TorusGeometry(0.19, 0.016, 10, 36).rotateX(Math.PI / 2), M.plastic, 0, 0, 0, steeringWheel);
  for (let i = 0; i < 3; i++) {
    const sp = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.19, 6), M.plastic, 0, 0, 0, steeringWheel);
    sp.rotation.z = Math.PI / 2; sp.rotation.y = (i / 3) * Math.PI * 2;
    sp.position.set(Math.cos((i / 3) * Math.PI * 2) * 0.095, 0, -Math.sin((i / 3) * Math.PI * 2) * 0.095);
  }
  mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 12), M.plastic, 0, 0.0, 0, steeringWheel);
  mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.06, 8), M.plastic, 0.16, 0.035, 0.05, steeringWheel);

  // Überrollbügel (vorne montiert, wie beim AGT 835) mit Spiegeln
  const barZ = 0.42;
  tube([[-0.35, 0.72, barZ], [-0.35, 1.5, barZ], [-0.35, 1.95, barZ - 0.01], [-0.28, 2.07, barZ - 0.02], [0, 2.1, barZ - 0.02], [0.28, 2.07, barZ - 0.02], [0.35, 1.95, barZ - 0.01], [0.35, 1.5, barZ], [0.35, 0.72, barZ]], 0.032, M.plastic, front, 80);
  for (const s of [-1, 1]) {
    mesh(box(0.09, 0.12, 0.08, 0.01), M.darkMetal, s * 0.33, 0.75, barZ, front);
    mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10), M.steel, s * 0.35, 1.72, barZ, front);
    tube([[s * 0.35, 1.72, barZ], [s * 0.52, 1.74, barZ - 0.02], [s * 0.6, 1.8, barZ - 0.03]], 0.01, M.steel, front, 10);
    const mir = new THREE.Group();
    mir.position.set(s * 0.62, 1.86, barZ - 0.03);
    mir.rotation.y = s * 0.2;
    front.add(mir);
    mesh(box(0.15, 0.24, 0.035, 0.03), M.plastic, 0, 0, 0, mir);
    mesh(new THREE.PlaneGeometry(0.13, 0.22), M.chrome, 0, 0, -0.019, mir).rotation.y = Math.PI;
  }

  // ===================== HINTERWAGEN =====================
  addWheel(rear, track, -axleR);
  addWheel(rear, -track, -axleR);
  mesh(box(0.42, 0.34, 1.0, 0.04), M.darkMetal, 0, 0.5, -0.55, rear);
  mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.92, 12).rotateZ(Math.PI / 2), M.darkMetal, 0, wheelR, -axleR, rear);
  mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.3, 16), M.steel, 0, 0.5, -0.06, rear);
  // Trittbretter (Riffelblech)
  for (const s of [-1, 1]) mesh(box(0.34, 0.03, 0.42, 0.01), M.checker, s * 0.4, 0.58, 0.02, rear);
  mesh(box(0.5, 0.03, 0.35, 0.01), M.checker, 0, 0.67, -0.16, rear);

  // Kotflügel hinten (rot, kastenförmig)
  for (const s of [-1, 1]) {
    mesh(box(0.38, 0.17, 0.82, 0.05, 3), M.paint, s * track, 0.95, -axleR - 0.02, rear);
    mesh(box(0.3, 0.16, 0.3, 0.04, 3), M.paint, s * track, 0.84, -axleR + 0.5, rear).rotation.x = 0.5;
    mesh(box(0.04, 0.42, 0.76, 0.015), M.paint, s * 0.355, 0.7, -axleR, rear);
    // Rückleuchte + Reflektor
    mesh(box(0.22, 0.08, 0.03, 0.01), M.plastic, s * track, 0.95, -axleR - 0.44, rear);
    mesh(new THREE.PlaneGeometry(0.09, 0.06), M.amber, s * (track - 0.05), 0.95, -axleR - 0.456, rear).rotation.y = Math.PI;
    mesh(new THREE.PlaneGeometry(0.09, 0.06), M.tail, s * (track + 0.05), 0.95, -axleR - 0.456, rear).rotation.y = Math.PI;
    mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.015, 16).rotateX(Math.PI / 2), M.tail, s * track, 0.84, -axleR - 0.44, rear);
    // Haltegriff auf dem Kotflügel
    tube([[s * (track - 0.12), 1.03, -axleR + 0.25], [s * (track - 0.12), 1.12, -axleR + 0.2], [s * (track - 0.12), 1.12, -axleR - 0.05], [s * (track - 0.12), 1.03, -axleR - 0.1]], 0.012, M.steel, rear, 16);
  }

  // Sitz mit Haltebügel
  mesh(box(0.2, 0.25, 0.2, 0.03), M.darkMetal, 0, 0.82, -0.58, rear);
  mesh(box(0.44, 0.09, 0.42, 0.04, 3), M.seat, 0, 1.0, -0.55, rear);
  const back = mesh(box(0.42, 0.36, 0.08, 0.04, 3), M.seat, 0, 1.22, -0.8, rear);
  back.rotation.x = -0.18;
  tube([[-0.25, 0.98, -0.42], [-0.26, 1.1, -0.5], [-0.25, 1.32, -0.82], [-0.15, 1.42, -0.86], [0.15, 1.42, -0.86], [0.25, 1.32, -0.82], [0.26, 1.1, -0.5], [0.25, 0.98, -0.42]], 0.015, M.plastic, rear, 40);

  // Schalthebel
  const levers = [];
  for (const [x, col] of [[0.1, M.plastic], [-0.08, M.tail], [0.2, M.plastic]]) {
    const l = new THREE.Group();
    l.position.set(x, 0.7, -0.18);
    rear.add(l);
    mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.42, 6), M.steel, 0, 0.21, 0, l);
    mesh(new THREE.SphereGeometry(0.028, 10, 8), col, 0, 0.43, 0, l);
    l.rotation.x = 0.25;
    levers.push(l);
  }

  // Heck: Turm mit Kennzeichen, Zapfwelle, Dreipunkt, Anhängekupplung
  mesh(box(0.3, 0.42, 0.14, 0.02), M.plastic, 0, 0.88, -1.0, rear);
  mesh(new THREE.PlaneGeometry(0.24, 0.12), M.plate, 0, 1.0, -1.072, rear).rotation.y = Math.PI;
  mesh(box(0.34, 0.26, 0.2, 0.03), M.darkMetal, 0, 0.5, -1.06, rear);
  const pto = new THREE.Group();
  pto.position.set(0, 0.46, -1.17);
  rear.add(pto);
  mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.11, 6).rotateX(Math.PI / 2), M.steel, 0, 0, 0, pto);
  mesh(new THREE.BoxGeometry(0.012, 0.075, 0.1), M.steel, 0, 0, 0, pto);
  const ptoShield = new THREE.CylinderGeometry(0.09, 0.09, 0.14, 16, 1, true, -Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
  const sh = mesh(ptoShield, M.paintMatte, 0, 0.47, -1.18, rear);
  sh.material = M.paintMatte.clone(); sh.material.side = THREE.DoubleSide;
  // Kugelkopfkupplung
  mesh(box(0.08, 0.06, 0.18, 0.01), M.darkMetal, 0, 0.32, -1.2, rear);
  mesh(new THREE.SphereGeometry(0.04, 12, 10), M.steel, 0, 0.38, -1.27, rear);

  // Dreipunkt-Hubwerk (drehbar)
  const hitch = new THREE.Group();
  hitch.position.set(0, 0.42, -1.08);
  rear.add(hitch);
  const lowerLinks = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(s * 0.17, 0, 0);
    hitch.add(arm);
    mesh(box(0.035, 0.07, 0.62, 0.01), M.darkMetal, s * 0.04, 0, -0.3, arm).rotation.y = s * 0.12;
    mesh(new THREE.TorusGeometry(0.035, 0.012, 6, 14).rotateY(Math.PI / 2), M.steel, s * 0.08, 0, -0.6, arm);
    lowerLinks.push(arm);
    // Hubarme oben
    const lift = new THREE.Group();
    lift.position.set(s * 0.15, 0.78, -1.05);
    rear.add(lift);
    mesh(box(0.035, 0.05, 0.3, 0.01), M.darkMetal, 0, 0, -0.15, lift);
    lowerLinks.push(lift);
  }
  const topLink = new THREE.Group();
  topLink.position.set(0, 0.78, -1.1);
  rear.add(topLink);
  mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.45, 10).rotateX(Math.PI / 2), M.darkMetal, 0, 0, -0.22, topLink);
  mesh(new THREE.TorusGeometry(0.03, 0.01, 6, 12).rotateY(Math.PI / 2), M.steel, 0, 0, -0.46, topLink);

  // Auspuff-Position (für Rauchpartikel) – unten rechts hinter der Haube
  const exhaust = new THREE.Object3D();
  exhaust.position.set(0.3, 0.42, 0.5);
  front.add(exhaust);

  // Hotspot-Anker
  const anchors = {
    motor: makeAnchor(engineShake, 0.0, 1.2, 1.1),
    knick: makeAnchor(front, 0.0, 0.62, 0.0),
    getriebe: makeAnchor(rear, 0.2, 1.05, -0.22),
    zapfwelle: makeAnchor(rear, 0.0, 0.46, -1.25),
    kraftheber: makeAnchor(rear, -0.3, 0.55, -1.45),
    buegel: makeAnchor(front, 0.0, 2.12, barZ),
  };

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  applyGrimeToObject(root);
  // Starre Teile je Baugruppe zusammenfassen: spart rund die Hälfte der Draw Calls
  for (const g of [front, rear, engineShake]) mergeStatic(g);

  return {
    root, body, front, rear, engineShake, wheels, steeringWheel, levers, pto, hitch, lowerLinks, topLink,
    headlights, exhaust, anchors, materials: M,
  };
}

// Fasst direkte Mesh-Kinder einer Gruppe mit gleichem Material (und gleichem Schattenwurf)
// zu je einem Mesh zusammen. Objekte mit eigenen Kindern oder Namen bleiben erhalten.
function mergeStatic(group) {
  const buckets = new Map();
  for (const o of [...group.children]) {
    if (!o.isMesh || o.isInstancedMesh || o.children.length || o.name || Array.isArray(o.material)) continue;
    const key = `${o.material.uuid}|${o.castShadow}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const geos = list.map((o) => {
      o.updateMatrix();
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      g.applyMatrix4(o.matrix);
      return g;
    });
    // nur gemeinsame Attribute behalten, damit sich alles zusammenführen lässt
    const common = Object.keys(geos[0].attributes).filter((k) => geos.every((g) => g.attributes[k]));
    for (const g of geos) for (const k of Object.keys(g.attributes)) if (!common.includes(k)) g.deleteAttribute(k);
    for (const g of geos) { g.morphAttributes = {}; g.clearGroups(); }
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    const m = new THREE.Mesh(merged, list[0].material);
    m.castShadow = list[0].castShadow;
    m.receiveShadow = true;
    list.forEach((o) => group.remove(o));
    group.add(m);
  }
}

function makeAnchor(parent, x, y, z) {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}
