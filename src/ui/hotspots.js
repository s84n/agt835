import * as THREE from 'three';

export const HOTSPOTS = [
  {
    id: 'motor', label: 'Motor', eyebrow: 'Herzstück · Lombardini',
    title: 'Drei Zylinder. Null Allüren.',
    text: 'Unter der roten Haube arbeitet ein wassergekühlter Lombardini-Dreizylinder-Diesel. Er hängt sauber am Gas, braucht wenig und läuft und läuft, ob am steilen Hang oder im Holz.',
    facts: [['Typ', 'Lombardini LDW 1603'], ['Hubraum', '1.649 cm³'], ['Leistung', '27 kW / 36,6 PS'], ['Nenndrehzahl', 'ca. 3.000 U/min']],
    cam: [2.3, 1.55, 2.5], action: 'rev',
  },
  {
    id: 'knick', label: 'Knicklenkung', eyebrow: 'Fahrwerk · 4WD',
    title: 'Knickt ein, kommt überall durch.',
    text: 'Vorder- und Hinterwagen sind über ein Gelenk verbunden. Gelenkt wird, indem der ganze Traktor in der Mitte abknickt. Alle vier gleich großen Räder treiben permanent an. Das bringt einen engen Wendekreis zwischen den Obstbäumen und Traktion am Hang.',
    facts: [['Antrieb', 'Permanenter Allrad'], ['Lenkung', 'Knicklenkung'], ['Wendekreis', 'ca. 2,9 m'], ['Bereifung', '4 × gleich groß']],
    cam: [2.9, 2.4, 0.3], action: 'steer',
  },
  {
    id: 'getriebe', label: 'Getriebe', eyebrow: 'Kraftübertragung',
    title: '8 vor, 4 zurück.',
    text: 'Das synchronisierte Wendegetriebe macht Richtungswechsel einfach, etwa beim Rangieren mit dem Kipper oder beim Hin und Her am Holzstapel. Die Hebel sitzen griffgünstig zwischen den Knien.',
    facts: [['Getriebe', 'Synchron-Wendegetriebe'], ['Gänge', '8 V / 4 R'], ['Höchstgeschw.', 'ca. 30 km/h']],
    cam: [1.0, 2.3, -1.5], action: 'shift',
  },
  {
    id: 'zapfwelle', label: 'Zapfwelle', eyebrow: 'Heck · Antrieb für Geräte',
    title: '540 Umdrehungen Arbeitswille.',
    text: 'Die Heckzapfwelle treibt Mulcher, Fräse oder Seilwinde an. Zusammen mit dem Kraftheber wird aus dem kleinen Traktor ein Werkzeugträger für alles, was auf der Streuobstwiese anfällt.',
    facts: [['Position', 'Heck'], ['Drehzahl', '540 U/min'], ['Profil', 'Standard 1 3/8"']],
    cam: [1.3, 1.0, -3.1], action: 'pto',
  },
  {
    id: 'kraftheber', label: 'Kraftheber', eyebrow: 'Hydraulik · Dreipunkt',
    title: 'Hebt eine Tonne.',
    text: 'Die hydraulische Dreipunktaufhängung hebt Anbaugeräte wie den KRPAN-Kipper oder die Federzinkenegge mit rund 1.000 kg Hubkraft.',
    facts: [['Aufhängung', 'Dreipunkt hinten'], ['Hubkraft', 'ca. 1.000 kg'], ['Gewicht', '1.200–1.940 kg']],
    cam: [-2.1, 1.2, -3.0], action: 'lift',
  },
  {
    id: 'buegel', label: 'Fahrerplatz', eyebrow: 'Sicherheit · Ergonomie',
    title: 'Bügel vorn, Blick frei.',
    text: 'Der klappbare Überrollbügel sitzt vorn auf dem Vorderwagen, die Spiegel daran. Der Sitz thront über der Hinterachse. So bleibt der Traktor niedrig und kompakt genug für tief hängende Äste.',
    facts: [['Bügel', 'Frontmontiert'], ['Baujahr', 'ca. 2001'], ['Hersteller', 'Agromehanika, Kranj (SLO)']],
    cam: [2.2, 3.0, -2.6], action: 'lights',
  },
];

export class HotspotLayer {
  constructor(container, anchors, onSelect) {
    this.container = container;
    this.items = HOTSPOTS.map((h) => {
      const el = document.createElement('button');
      el.className = 'hotspot';
      el.innerHTML = `<span class="dot"></span><span class="label">${h.label}</span>`;
      el.setAttribute('aria-label', h.label);
      el.addEventListener('click', (e) => { e.stopPropagation(); onSelect(h); });
      container.appendChild(el);
      return { h, el, anchor: anchors[h.id] };
    });
    this.v = new THREE.Vector3();
    this.c = new THREE.Vector3();
  }

  setActive(id) { this.items.forEach((i) => i.el.classList.toggle('active', i.h.id === id)); }

  update(camera, center, w, h) {
    const camDir = camera.getWorldDirection(this.c);
    for (const it of this.items) {
      it.anchor.getWorldPosition(this.v);
      const toAnchor = this.v.clone().sub(center);
      const toCam = camera.position.clone().sub(center).normalize();
      const facing = toAnchor.normalize().dot(toCam);
      const p = this.v.clone().project(camera);
      const visible = p.z < 1 && this.v.clone().sub(camera.position).dot(camDir) > 0;
      it.el.style.display = visible ? '' : 'none';
      it.el.style.transform = `translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px) translate(-9px, -50%)`;
      it.el.classList.toggle('behind', facing < -0.25);
    }
  }
}
