// Motor-Sound aus den echten Aufnahmen (Leerlauf + Fahrt) plus synthetische Ergänzungen.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.buffers = {};
  }

  async preload(base) {
    // Dateien schon vor dem Klick laden (Dekodieren erst nach dem Nutzer-Klick)
    const load = async (name) => {
      const r = await fetch(`${base}audio/${name}.mp3`);
      if (!r.ok) throw new Error(name);
      return r.arrayBuffer();
    };
    try {
      this.raw = { idle: await load('idle'), drive: await load('drive') };
    } catch (e) {
      console.warn('Audio konnte nicht geladen werden', e);
      this.raw = null;
    }
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.engineBus.connect(this.master);

    if (this.raw) {
      try {
        this.buffers.idle = await ctx.decodeAudioData(this.raw.idle.slice(0));
        this.buffers.drive = await ctx.decodeAudioData(this.raw.drive.slice(0));
      } catch (e) { console.warn('Dekodieren fehlgeschlagen', e); }
    }
    const loop = (buf) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      // MP3-Encoderpausen am Anfang/Ende überspringen
      src.loopStart = 0.06; src.loopEnd = buf.duration - 0.06;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(g).connect(this.engineBus);
      src.start(0, Math.random() * (buf.duration - 0.2));
      return { src, g };
    };
    if (this.buffers.idle) this.idle = loop(this.buffers.idle);
    if (this.buffers.drive) this.drive = loop(this.buffers.drive);

    // Synthetischer Dreizylinder-Unterbau: gibt der Drehzahl Kontur
    this.osc = ctx.createOscillator(); this.osc.type = 'sawtooth';
    this.osc2 = ctx.createOscillator(); this.osc2.type = 'square';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.8;
    this.synthLP = lp;
    this.synthGain = ctx.createGain(); this.synthGain.gain.value = 0;
    this.osc.connect(lp); this.osc2.connect(lp);
    lp.connect(this.synthGain).connect(this.engineBus);
    this.osc.start(); this.osc2.start();

    this.noiseBuf = this.makeNoise(2);
    this.whiteBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    { const d = this.whiteBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    this.initDriveSounds();
    this.startAmbient();
    this.ready = true;
  }

  makeNoise(sec) {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * sec, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 + w * 0.15; }
    return b;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.1);
  }

  // Anlasser: Orgeln, dann springt der Diesel an
  crank() {
    if (!this.ready) return 1.4;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 9;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.22;
    lfo.connect(lfoG).connect(g.gain);
    const whine = ctx.createOscillator(); whine.type = 'sawtooth'; whine.frequency.setValueAtTime(140, t); whine.frequency.linearRampToValueAtTime(190, t + 1.2);
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 600;
    whine.connect(wlp).connect(wg).connect(g);
    n.connect(bp).connect(g).connect(this.master);
    g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.08);
    g.gain.setValueAtTime(0.32, t + 1.15); g.gain.linearRampToValueAtTime(0, t + 1.35);
    n.start(t); lfo.start(t); whine.start(t);
    n.stop(t + 1.4); lfo.stop(t + 1.4); whine.stop(t + 1.4);
    return 1.2;
  }

  horn() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const g = ctx.createGain(); g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    g.connect(lp).connect(this.master);
    for (const f of [415, 498]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
      o.connect(g); o.start(t); o.stop(t + 0.55);
    }
    g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.setValueAtTime(0.12, t + 0.45); g.gain.linearRampToValueAtTime(0, t + 0.55);
  }

  clunk(strength = 0.5) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400 + strength * 600;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.25 * strength + 0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + strength * 0.2);
    n.connect(lp).connect(g).connect(this.master);
    n.start(t, Math.random()); n.stop(t + 0.5);
  }

  // ---------- Klanglandschaft: Wind, Blätter, Vögel, Grillen ----------
  startAmbient() {
    const ctx = this.ctx;
    const rnd = (a, b) => a + Math.random() * (b - a);
    this.ambient = ctx.createGain(); this.ambient.gain.value = 2.2; // ≈ -33 dBFS im Mittel, Motorleerlauf ≈ -18 dBFS
    this.ambient.connect(this.master);

    // Raumhall aus generierter Impulsantwort (weite Landschaft, kein Raum)
    const len = ctx.sampleRate * 2.8;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) { const t = i / len; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 600 ? i / 600 : 1); }
    }
    const verb = ctx.createConvolver(); verb.buffer = ir;
    this.verb = verb;
    const verbGain = ctx.createGain(); verbGain.gain.value = 0.3;
    verb.connect(verbGain).connect(this.ambient);

    // Vogelbus: trocken + Hall
    this.birdBus = ctx.createGain(); this.birdBus.gain.value = 0.9;
    const birdDry = ctx.createGain(); birdDry.gain.value = 0.55;
    const birdSend = ctx.createGain(); birdSend.gain.value = 0.7;
    this.birdBus.connect(birdDry).connect(this.ambient);
    this.birdBus.connect(birdSend).connect(verb);

    // Wind: tiefes Rauschen + Blätterrascheln, mit zufälligen Böen
    const mkNoise = () => { const n = ctx.createBufferSource(); n.buffer = this.noiseBuf; n.loop = true; n.start(0, Math.random() * 1.5); return n; };
    const white = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    { const d = white.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const windLow = mkNoise();
    const wlp = ctx.createBiquadFilter(); wlp.type = 'lowpass'; wlp.frequency.value = 380; wlp.Q.value = 0.5;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    windLow.connect(wlp).connect(wg).connect(this.ambient);
    const leaves = ctx.createBufferSource(); leaves.buffer = white; leaves.loop = true; leaves.start();
    const lbp = ctx.createBiquadFilter(); lbp.type = 'bandpass'; lbp.frequency.value = 4200; lbp.Q.value = 0.6;
    const lhp = ctx.createBiquadFilter(); lhp.type = 'highpass'; lhp.frequency.value = 1800;
    const lg = ctx.createGain(); lg.gain.value = 0.003;
    leaves.connect(lbp).connect(lhp).connect(lg).connect(this.ambient);
    lg.connect(verb);
    const gust = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime, k = Math.random();
      wg.gain.setTargetAtTime(0.025 + k * 0.05, t, rnd(1.2, 3));
      wlp.frequency.setTargetAtTime(260 + k * 380, t, 2);
      lg.gain.setTargetAtTime(0.0012 + k * k * 0.0075, t, rnd(0.8, 2));
      setTimeout(gust, rnd(2500, 7000));
    };
    gust();
    this.amb = { windGain: wg, leafGain: lg, verbGain, birdDry, birdSend };

    // ---- einzelner Vogelton mit Gleiten, Vibrato und Oberton ----
    const tone = (out, t, dur, f0, f1, o = {}) => {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      const g = ctx.createGain(); g.gain.value = 0;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 50), t + dur);
      if (o.vib) {
        const l = ctx.createOscillator(); l.frequency.value = o.vib;
        const lg2 = ctx.createGain(); lg2.gain.value = f0 * (o.vibDepth ?? 0.02);
        l.connect(lg2).connect(osc.frequency); l.start(t); l.stop(t + dur + 0.05);
      }
      osc.connect(g).connect(out);
      if (o.harm) {
        const h = ctx.createOscillator(); h.type = 'sine';
        h.frequency.setValueAtTime(f0 * 2, t); h.frequency.exponentialRampToValueAtTime(Math.max(f1 * 2, 50), t + dur);
        const hg2 = ctx.createGain(); hg2.gain.value = o.harm;
        h.connect(hg2).connect(g); h.start(t); h.stop(t + dur + 0.05);
      }
      const peak = o.gain ?? 0.5, att = Math.min(0.02, dur * 0.25);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + att);
      g.gain.setValueAtTime(peak, t + dur * 0.6);
      g.gain.linearRampToValueAtTime(0, t + dur);
      osc.start(t); osc.stop(t + dur + 0.05);
    };
    // Stimme im Raum: Position (Panorama) + Entfernung (Tiefpass, Pegel)
    const voice = (dist) => {
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) pan.pan.value = rnd(-0.9, 0.9);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000 - dist * 6000;
      const g = ctx.createGain(); g.gain.value = 0.075 * (1 - dist * 0.7);
      g.connect(lp).connect(pan).connect(this.birdBus);
      return g;
    };
    const loop = (fn, min, max) => { const run = () => { if (!this.ctx) return; fn(); setTimeout(run, rnd(min, max)); }; setTimeout(run, rnd(300, min)); };

    // Amsel: flötende Phrasen
    loop(() => {
      const out = voice(rnd(0.2, 0.7)), t0 = ctx.currentTime + 0.05;
      let t = t0;
      const base = rnd(1400, 2000), n = 3 + Math.floor(rnd(0, 5));
      for (let i = 0; i < n; i++) {
        const f = base * rnd(0.85, 1.55), d = rnd(0.09, 0.26);
        tone(out, t, d, f, f * rnd(0.85, 1.2), { vib: rnd(18, 32), vibDepth: 0.015, harm: 0.18, gain: 0.55 });
        t += d + rnd(0.02, 0.09);
      }
      // gezwitschertes Ende
      if (Math.random() < 0.6) for (let i = 0; i < 4; i++) { tone(out, t, 0.035, rnd(3500, 5200), rnd(2600, 3600), { gain: 0.25 }); t += 0.05; }
    }, 3500, 9000);

    // Kohlmeise: „zi-zi-bä“
    loop(() => {
      const out = voice(rnd(0.1, 0.6));
      let t = ctx.currentTime + 0.05;
      const hi = rnd(4800, 5600), lo = hi * rnd(0.62, 0.72), reps = 3 + Math.floor(rnd(0, 3));
      for (let i = 0; i < reps; i++) {
        tone(out, t, 0.075, hi, hi * 0.97, { gain: 0.45, harm: 0.05 }); t += 0.11;
        tone(out, t, 0.1, lo, lo * 0.95, { gain: 0.4, harm: 0.08 }); t += 0.16;
      }
    }, 6000, 15000);

    // Spatzen: Tschilp-Salven
    loop(() => {
      const out = voice(rnd(0.3, 0.8));
      let t = ctx.currentTime + 0.05;
      const n = 2 + Math.floor(rnd(0, 6));
      for (let i = 0; i < n; i++) {
        const f = rnd(3000, 4200);
        tone(out, t, rnd(0.04, 0.07), f * 1.25, f * 0.75, { gain: 0.35, harm: 0.35, vib: 70, vibDepth: 0.04 });
        t += rnd(0.12, 0.3);
      }
    }, 2500, 7000);

    // Buchfink: beschleunigender, fallender Triller mit Schnörkel
    loop(() => {
      const out = voice(rnd(0.3, 0.75));
      let t = ctx.currentTime + 0.05, f = rnd(4200, 5000), gap = 0.11;
      for (let i = 0; i < 12; i++) {
        tone(out, t, 0.05, f, f * 0.8, { gain: 0.38, harm: 0.1 });
        t += gap; gap *= 0.9; f *= 0.975;
      }
      tone(out, t + 0.03, 0.22, f * 0.9, f * 1.4, { gain: 0.42, vib: 30, vibDepth: 0.03 });
    }, 10000, 22000);

    // Kuckuck in der Ferne (selten)
    loop(() => {
      if (Math.random() < 0.5) return;
      const out = voice(0.92);
      let t = ctx.currentTime + 0.05;
      for (let i = 0; i < 2 + Math.floor(rnd(0, 3)); i++) {
        tone(out, t, 0.2, 690, 680, { gain: 0.9, harm: 0.08 });
        tone(out, t + 0.28, 0.32, 560, 550, { gain: 0.8, harm: 0.08 });
        t += 0.95;
      }
    }, 25000, 50000);

    // Grillen (nur abends hörbar)
    this.cricketBus = ctx.createGain(); this.cricketBus.gain.value = 0;
    this.cricketBus.connect(this.ambient);
    this.cricketBus.connect(verb);
    for (let v = 0; v < 3; v++) {
      const carrier = ctx.createOscillator(); carrier.frequency.value = rnd(4300, 4900);
      const am = ctx.createGain(); am.gain.value = 0;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (pan.pan) pan.pan.value = rnd(-0.8, 0.8);
      const lvl = ctx.createGain(); lvl.gain.value = 0.012;
      carrier.connect(am).connect(pan).connect(lvl).connect(this.cricketBus);
      carrier.start();
      const chirpLoop = () => {
        if (!this.ctx) return;
        let t = ctx.currentTime + 0.02;
        const pulses = 3 + Math.floor(rnd(0, 2));
        for (let i = 0; i < pulses; i++) {
          am.gain.setValueAtTime(0, t); am.gain.linearRampToValueAtTime(1, t + 0.006);
          am.gain.linearRampToValueAtTime(0, t + 0.022); t += 0.035;
        }
        setTimeout(chirpLoop, rnd(450, 900));
      };
      setTimeout(chirpLoop, rnd(0, 800));
    }
    this.setMood(this.mood || 'golden');
  }

  // ---------- Fahrgeräusche ----------
  initDriveSounds() {
    const ctx = this.ctx;
    this.driveBus = ctx.createGain(); this.driveBus.gain.value = 1;
    this.driveBus.connect(this.master);
    // Getriebe: Zahnradheulen, Tonhöhe folgt Raddrehzahl × Übersetzung
    this.whine = ctx.createOscillator(); this.whine.type = 'triangle';
    const wbp = ctx.createBiquadFilter(); wbp.type = 'bandpass'; wbp.Q.value = 6; this.whineBP = wbp;
    this.whineG = ctx.createGain(); this.whineG.gain.value = 0;
    this.whine.connect(wbp).connect(this.whineG).connect(this.driveBus);
    this.whine.start();
    const loopNoise = (buf) => { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.start(0, Math.random()); return n; };
    // Kies/Schotter: körniges Knirschen
    const cbp = ctx.createBiquadFilter(); cbp.type = 'bandpass'; cbp.frequency.value = 2400; cbp.Q.value = 0.9;
    this.crunchG = ctx.createGain(); this.crunchG.gain.value = 0;
    loopNoise(this.whiteBuf).connect(cbp).connect(this.crunchG).connect(this.driveBus);
    const clp = ctx.createBiquadFilter(); clp.type = 'lowpass'; clp.frequency.value = 500;
    this.rumbleG = ctx.createGain(); this.rumbleG.gain.value = 0;
    loopNoise(this.noiseBuf).connect(clp).connect(this.rumbleG).connect(this.driveBus);
    // Gras: weiches Rascheln unter den Reifen
    const glp = ctx.createBiquadFilter(); glp.type = 'lowpass'; glp.frequency.value = 1400;
    const ghp = ctx.createBiquadFilter(); ghp.type = 'highpass'; ghp.frequency.value = 250;
    this.swishG = ctx.createGain(); this.swishG.gain.value = 0;
    loopNoise(this.whiteBuf).connect(glp).connect(ghp).connect(this.swishG).connect(this.driveBus);
  }

  updateDrive({ speed = 0, gear = 1, reverse = false, onPath = false, listen = 1 }) {
    if (!this.ready || !this.whine) return;
    const t = this.ctx.currentTime, v = Math.min(speed / 8, 1);
    const ratios = [7.5, 5.2, 3.8, 2.8, 2.1, 1.6, 1.25, 1.0];
    const f = Math.max(30, speed * 38 * (reverse ? 6 : ratios[gear - 1]));
    this.whine.frequency.setTargetAtTime(f, t, 0.08);
    this.whineBP.frequency.setTargetAtTime(f, t, 0.08);
    this.whineG.gain.setTargetAtTime(speed > 0.3 ? (0.012 + v * 0.02) * listen : 0, t, 0.15);
    // Kies knistert unregelmäßig – Zufall pro Frame ergibt die Körnung
    const crunch = onPath ? Math.min(speed / 4, 1) : 0;
    this.crunchG.gain.setTargetAtTime(crunch * (0.03 + Math.random() * 0.07) * listen, t, 0.015);
    this.rumbleG.gain.setTargetAtTime((onPath ? 0.14 : 0.07) * v * listen, t, 0.1);
    this.swishG.gain.setTargetAtTime(!onPath ? Math.min(speed / 5, 1) * (0.012 + Math.random() * 0.012) * listen : 0, t, 0.05);
  }

  // Hydraulik beim Heben/Senken: Zischen + Pumpenton
  hydraulic(dur = 1.6) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.whiteBuf; n.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 1.4;
    const g = ctx.createGain(); g.gain.value = 0;
    n.connect(bp).connect(g).connect(this.master);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(380, t); o.frequency.linearRampToValueAtTime(520, t + dur);
    const olp = ctx.createBiquadFilter(); olp.type = 'lowpass'; olp.frequency.value = 900;
    const og = ctx.createGain(); og.gain.value = 0;
    o.connect(olp).connect(og).connect(this.master);
    for (const [gg, peak] of [[g, 0.05], [og, 0.035]]) {
      gg.gain.setValueAtTime(0, t); gg.gain.linearRampToValueAtTime(peak, t + 0.12);
      gg.gain.setValueAtTime(peak, t + dur - 0.2); gg.gain.linearRampToValueAtTime(0, t + dur);
    }
    n.start(t); o.start(t); n.stop(t + dur + 0.05); o.stop(t + dur + 0.05);
  }

  // Abkühlender Motor: metallisches Knacken, wird seltener
  coolingTicks() {
    if (!this.ready) return;
    clearTimeout(this.tickTimer);
    const start = this.ctx.currentTime;
    const tick = () => {
      const ctx = this.ctx, t = ctx.currentTime, el = t - start;
      if (el > 35 || this.engineRunning) return;
      const o = ctx.createOscillator(); o.type = 'square';
      o.frequency.value = 2200 + Math.random() * 2500;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = o.frequency.value; bp.Q.value = 12;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05 + Math.random() * 0.04, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
      o.connect(bp).connect(g).connect(this.master);
      o.start(t); o.stop(t + 0.06);
      this.tickTimer = setTimeout(tick, (400 + Math.random() * 1600) * (1 + el / 10));
    };
    this.tickTimer = setTimeout(tick, 1500);
  }

  // Kirchenglocke im Dorf – nach dem Teiltonaufbau echter Glocken:
  // Unterton (Hum), Grundton (Prime), kleine Terz, Quinte, Nominal und obere Mixtur.
  // Jeder Teilton als leicht verstimmtes Paar (Schwebung = typisches „Wummern“),
  // dazu ein metallischer Anschlag aus Klöppel-Geräusch und eigener großer Hall.
  bell(strikes = 3, gap = 2.8) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (!this.bellVerb) {
      // lange Hallfahne (~6 s), dunkel ausklingend – Kirchturm über dem Tal
      const len = ctx.sampleRate * 6;
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        let lp = 0;
        for (let i = 0; i < len; i++) {
          const t = i / len;
          lp += ((Math.random() * 2 - 1) - lp) * (0.5 - t * 0.42); // wird zum Ende dumpfer
          d[i] = lp * Math.pow(1 - t, 2.2) * (i < 1200 ? i / 1200 : 1);
        }
      }
      this.bellVerb = ctx.createConvolver(); this.bellVerb.buffer = ir;
      const vg = ctx.createGain(); vg.gain.value = 0.9;
      this.bellVerb.connect(vg).connect(this.ambient);
    }
    const out = ctx.createGain(); out.gain.value = 0.05;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200; // Entfernung
    const dry = ctx.createGain(); dry.gain.value = 0.35;
    const wet = ctx.createGain(); wet.gain.value = 1.0;
    out.connect(lp);
    lp.connect(dry).connect(this.ambient);
    lp.connect(wet).connect(this.bellVerb);

    const base = 196; // g – mittelgroße Dorfglocke
    // [Verhältnis, Lautstärke, Abklingzeit s]
    const partials = [
      [0.5, 0.55, 9], [1.0, 0.7, 6.5], [1.183, 0.6, 5], [1.506, 0.32, 3.6], [2.0, 0.6, 3.2],
      [2.514, 0.3, 2.4], [2.662, 0.28, 2.2], [3.011, 0.22, 1.8], [4.166, 0.16, 1.2], [5.433, 0.12, 0.9], [6.796, 0.08, 0.6],
    ];
    for (let k = 0; k < strikes; k++) {
      const t = ctx.currentTime + 0.1 + k * gap;
      const vel = 0.85 + Math.random() * 0.15;
      for (const [ratio, amp, dec] of partials) {
        for (const det of [-1, 1]) {
          const o = ctx.createOscillator();
          o.frequency.value = base * ratio * (1 + det * (0.0006 + ratio * 0.0004));
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(amp * vel * 0.5, t + 0.004);
          g.gain.exponentialRampToValueAtTime(amp * vel * 0.18, t + Math.min(0.3, dec * 0.1)); // schneller erster Abfall
          g.gain.exponentialRampToValueAtTime(0.0004, t + dec);
          o.connect(g).connect(out); o.start(t); o.stop(t + dec + 0.1);
        }
      }
      // Klöppelanschlag: kurzes, hell klingendes Metallgeräusch
      const n = ctx.createBufferSource(); n.buffer = this.whiteBuf;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 2.5;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.5 * vel, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      n.connect(bp).connect(ng).connect(out); n.start(t, Math.random()); n.stop(t + 0.1);
      // hoher, metallischer „Ping“ einiger Inharmonischer
      for (const f of [3870, 5210, 7140]) {
        const o = ctx.createOscillator(); o.frequency.value = f * (0.98 + Math.random() * 0.04);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.06 * vel, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.35);
        o.connect(g).connect(out); o.start(t); o.stop(t + 0.4);
      }
    }
  }

  setMood(name) {
    this.mood = name;
    if (!this.ctx || !this.birdBus) return;
    const t = this.ctx.currentTime;
    const birds = { day: 1.0, golden: 0.85, dusk: 0.3 }[name] ?? 0.85;
    this.birdBus.gain.setTargetAtTime(birds, t, 1.5);
    this.cricketBus.gain.setTargetAtTime(name === 'dusk' ? 1 : 0, t, 2);
    clearTimeout(this.bellTimer);
    // ab und zu schlägt die Kirchturmuhr; beim Wechsel auf Abend: Abendläuten
    const chime = () => { this.bell(this.mood === 'dusk' ? 5 : 3); this.bellTimer = setTimeout(chime, 180000 + Math.random() * 120000); };
    if (name === 'dusk') this.bellTimer = setTimeout(() => { this.bell(7, 2.4); this.bellTimer = setTimeout(chime, 180000); }, 3500);
    else this.bellTimer = setTimeout(chime, 60000 + Math.random() * 60000);
  }

  // pro Frame
  update(rpm, load, listenerGain = 1) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const on = rpm > 120;
    const r = clamp(rpm, 0, 3200);
    const n = clamp((r - 900) / 2100, 0, 1);
    const tc = 0.06;
    this.engineBus.gain.setTargetAtTime(on ? listenerGain * clamp(r / 700, 0, 1) : 0, t, 0.15);
    // Leerlauf-Aufnahme ~900 U/min, Fahrt-Aufnahme ~1900 U/min angenommen
    if (this.idle) {
      this.idle.src.playbackRate.setTargetAtTime(clamp(r / 900, 0.5, 2.0), t, tc);
      this.idle.g.gain.setTargetAtTime((1 - clamp(n * 1.6 + load * 0.4, 0, 0.85)) * 0.9, t, tc);
    }
    if (this.drive) {
      this.drive.src.playbackRate.setTargetAtTime(clamp(r / 1900, 0.55, 1.6), t, tc);
      this.drive.g.gain.setTargetAtTime(clamp(n * 1.5 + load * 0.4, 0.05, 1) * 0.85, t, tc);
    }
    const fire = (r / 60) * 1.5; // Zündfrequenz 3-Zylinder-Viertakt
    this.osc.frequency.setTargetAtTime(Math.max(fire, 1), t, tc);
    this.osc2.frequency.setTargetAtTime(Math.max(fire * 0.5, 1), t, tc);
    this.synthLP.frequency.setTargetAtTime(120 + n * 260 + load * 120, t, tc);
    const synthLevel = this.idle ? 0.1 + load * 0.08 : 0.35 + n * 0.2;
    this.synthGain.gain.setTargetAtTime(on ? synthLevel : 0, t, 0.1);
  }
}
