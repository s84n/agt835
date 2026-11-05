import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt, VIEW } from './terrain.js';
import { bench, woodTexture } from './feierabend.js';
import { VILLAGE_ROAD } from './village.js';

// Aussichtsbank am Hang: Blick übers Tal aufs Dorf und den Albtrauf. Daneben ein Feldkreuz,
// dahinter steht eine große Linde (kommt aus der Obstwiese, siehe LINDE).

const target = new THREE.Vector3(-92, 0, VILLAGE_ROAD(-92) - 10); // Dorfmitte mit Kirche
const rotY = Math.atan2(target.x - VIEW.x, target.z - VIEW.z);
const fwd = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
// Linde schräg hinter der Bank
export const LINDE = { x: VIEW.x - fwd.x * 3.2 + right.x * 1.8, z: VIEW.z - fwd.z * 3.2 + right.z * 1.8, k: 2.0 };

export function createViewpoint() {
  const group = new THREE.Group();
  const y0 = heightAt(VIEW.x, VIEW.z);
  const b = new THREE.Group();
  b.position.set(VIEW.x, y0, VIEW.z);
  b.rotation.y = rotY;
  const wood = new THREE.MeshStandardMaterial({ map: woodTexture(17, [138, 104, 70]), roughness: 0.88 });
  const metal = new THREE.MeshStandardMaterial({ color: '#2d2f2c', roughness: 0.6, metalness: 0.5 });
  b.add(bench(wood, metal));
  group.add(b);

  // Feldkreuz mit kleinem Blechdach, links neben der Bank
  const cx = VIEW.x - right.x * 2.4 + fwd.x * 0.3, cz = VIEW.z - right.z * 2.4 + fwd.z * 0.3;
  const cross = new THREE.Group();
  cross.position.set(cx, heightAt(cx, cz), cz);
  cross.rotation.y = rotY;
  const cw = new THREE.MeshStandardMaterial({ map: woodTexture(29, [96, 70, 48]), roughness: 0.9 });
  const parts = [
    new THREE.BoxGeometry(0.14, 2.9, 0.14).translate(0, 1.45, 0),
    new THREE.BoxGeometry(1.2, 0.13, 0.13).translate(0, 2.15, 0),
  ];
  const c = new THREE.Mesh(mergeGeometries(parts), cw);
  const roof = new THREE.Mesh(mergeGeometries([
    new THREE.BoxGeometry(0.03, 0.28, 0.5).rotateZ(0.9).translate(-0.12, 2.92, 0),
    new THREE.BoxGeometry(0.03, 0.28, 0.5).rotateZ(-0.9).translate(0.12, 2.92, 0),
  ]), new THREE.MeshStandardMaterial({ color: '#5d6466', roughness: 0.5, metalness: 0.6 }));
  // Sockel aus Kalkstein
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5).translate(0, 0.1, 0), new THREE.MeshStandardMaterial({ color: '#c8c1b0', roughness: 0.95 }));
  cross.add(c, roof, base);
  group.add(cross);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // Sitzend: Augenhöhe ~1,2 m, Blick hinab aufs Dorf
  b.updateMatrixWorld(true);
  const seatWorld = b.localToWorld(new THREE.Vector3(0.2, 1.25, 0.02));
  const lookWorld = target.clone().setY(heightAt(target.x, target.z) + 3);
  const parkWorld = new THREE.Vector3(VIEW.park.x, heightAt(VIEW.park.x, VIEW.park.z), VIEW.park.z);
  const obstacles = [{ x: VIEW.x, z: VIEW.z, r: 1.0 }, { x: cx, z: cz, r: 0.4 }];
  return { group, obstacles, seatWorld, lookWorld, parkWorld };
}
