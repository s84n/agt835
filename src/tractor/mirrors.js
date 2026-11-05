import * as THREE from 'three';

// Echte Rückspiegel: Für jeden Spiegel wird das Auge des Betrachters an der Spiegelebene
// gespiegelt. Von dort schaut eine Kamera mit schiefem Sichtkegel (Off-Axis-Projektion) genau
// durch das Spiegelglas nach hinten. Ihr Bild landet 1:1 auf dem Glas. Was man sieht, hängt
// also wie beim echten Spiegel vom eigenen Blickwinkel ab.
// Kosten klein halten: winzige Textur, nur in der Nähe, Spiegel abwechselnd aktualisieren.

const _c = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3();
const _e = new THREE.Vector3(), _ep = new THREE.Vector3(), _d = new THREE.Vector3(), _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sphere = new THREE.Sphere();

export class Mirrors {
  constructor(glasses, quality) {
    // glasses: Meshes mit PlaneGeometry (w × h), Vorderseite = lokale +z
    const low = quality.name === 'low';
    this.every = low ? 3 : 2;
    this.frame = 0;
    this.items = glasses.map((mesh) => {
      const p = mesh.geometry.parameters;
      const h = low ? 192 : 320;
      const rt = new THREE.WebGLRenderTarget(Math.round(h * p.width / p.height), h, { type: THREE.HalfFloatType, samples: low ? 0 : 2 });
      const cam = new THREE.PerspectiveCamera();
      cam.matrixAutoUpdate = false;
      // Spiegelbild ist seitenverkehrt: u spiegeln
      const uv = mesh.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      mesh.material = new THREE.MeshBasicMaterial({ map: rt.texture, color: new THREE.Color(0.86, 0.88, 0.9) });
      mesh.castShadow = false;
      return { mesh, rt, cam, w: p.width / 2, h: p.height / 2, valid: false };
    });
  }

  update(renderer, scene, camera, hide = []) {
    this.frame++;
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    camera.getWorldPosition(_e);
    this.items.forEach((it, i) => {
      // abwechselnd aktualisieren, bis beide einmal ein Bild haben
      if (it.valid && (this.frame + i) % this.every !== 0) return;
      const m = it.mesh;
      m.updateWorldMatrix(true, false);
      _c.setFromMatrixPosition(m.matrixWorld);
      if (_c.distanceTo(_e) > 16) return;
      _sphere.set(_c, 0.2);
      if (!_frustum.intersectsSphere(_sphere)) return;
      _r.setFromMatrixColumn(m.matrixWorld, 0).normalize();
      _u.setFromMatrixColumn(m.matrixWorld, 1).normalize();
      _n.setFromMatrixColumn(m.matrixWorld, 2).normalize();
      const dist = _d.subVectors(_e, _c).dot(_n);
      if (dist < 0.02) return; // Auge hinter dem Spiegel
      // gespiegeltes Auge; Kamera schaut entlang +n durch das Glas
      _ep.copy(_e).addScaledVector(_n, -2 * dist);
      const cam = it.cam;
      _m.makeBasis(_r.clone().negate(), _u, _n.clone().negate());
      _m.setPosition(_ep);
      cam.matrixWorld.copy(_m);
      cam.matrixWorldInverse.copy(_m).invert();
      // Glas im Kamerasystem: Mitte cx/cy, Abstand dist → schiefer Sichtkegel genau auf die Ränder
      _d.subVectors(_c, _ep);
      const cx = -_d.dot(_r), cy = _d.dot(_u);
      // Das gespiegelte Auge liegt genauso weit hinter dem Glas wie das echte davor (dist).
      // Nahebene liegt auf dem Glas: was hinter dem Spiegel steckt, wird nicht gezeichnet.
      const near = dist * 0.999;
      const k = near / dist;
      cam.projectionMatrix.makePerspective((cx - it.w) * k, (cx + it.w) * k, (cy + it.h) * k, (cy - it.h) * k, near, 3000);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      cam.layers.mask = camera.layers.mask;

      const vis = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const own = this.items.map((x) => x.mesh.visible);
      this.items.forEach((x) => (x.mesh.visible = false));
      const prevRT = renderer.getRenderTarget(), prevShadow = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(it.rt);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = prevShadow;
      this.items.forEach((x, j) => (x.mesh.visible = own[j]));
      hide.forEach((o, j) => (o.visible = vis[j]));
      it.valid = true;
    });
  }
}
