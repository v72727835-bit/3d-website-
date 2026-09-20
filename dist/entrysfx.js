/**
 * entrysfx.js — entrance sound, synthesised in the browser.
 *
 * Nothing is downloaded: hooves, wingbeats, wheel rumble, engine and dragon
 * roar are all built from oscillators and shaped noise. Every voice for an
 * entrance is scheduled up front against the audio clock, so the sound stays
 * locked to the animation even if the frame rate dips, and nothing needs to
 * run per frame.
 *
 * The rides travel right to left across the stage, so the whole mix pans with
 * them and passes through a small generated room reverb.
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createSfx() {
  let ctx = null, master = null, dry = null, wet = null, noiseBuf = null;
  let voices = [], enabled = false;

  /* ---------------------------------------------------------------- *
   * Graph
   * ---------------------------------------------------------------- */

  function impulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch { return false; }

    master = ctx.createGain();
    master.gain.value = 0.85;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 9;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);

    // A short generated room. Reverb is what stops synthesised hits sounding
    // like a test tone played inside a shoebox.
    const verb = ctx.createConvolver();
    verb.buffer = impulse(1.9, 3.2);
    wet = ctx.createGain();
    wet.gain.value = 0.3;
    wet.connect(verb).connect(master);
    dry = ctx.createGain();
    dry.connect(master);

    const len = Math.floor(ctx.sampleRate * 2.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  /** Per-entrance output: everything hangs off a panner that sweeps R→L. */
  function makeBus(t0, duration) {
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) {
      pan.pan.setValueAtTime(0.85, t0);
      pan.pan.linearRampToValueAtTime(0.5, t0 + duration * 0.25);
      pan.pan.linearRampToValueAtTime(-0.5, t0 + duration * 0.72);
      pan.pan.linearRampToValueAtTime(-0.9, t0 + duration);
      gain.connect(pan);
      pan.connect(dry); pan.connect(wet);
    } else {
      gain.connect(dry); gain.connect(wet);
    }
    return gain;
  }

  function track(node) { voices.push(node); return node; }

  function noise(t0, dur) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.start(t0);
    src.stop(t0 + dur);
    return track(src);
  }

  function osc(type, freq, t0, dur) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    o.start(t0);
    o.stop(t0 + dur);
    return track(o);
  }

  /** Attack/decay envelope on a gain node. */
  function env(t0, attack, dur, peak, curve = 0.0015) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(curve, t0 + dur);
    g.gain.setValueAtTime(0, t0 + dur + 0.01);
    return g;
  }

  function band(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }

  /* ---------------------------------------------------------------- *
   * Sound elements
   * ---------------------------------------------------------------- */

  /** One hoof strike: a noise crack over a low thud. */
  function hoof(out, t, level, pitch = 1) {
    const n = noise(t, 0.2);
    const bp = band('bandpass', 1500 * pitch, 1.3);
    const g = env(t, 0.002, 0.11, 0.5 * level);
    n.connect(bp).connect(g).connect(out);

    const thud = osc('sine', 150 * pitch, t, 0.22);
    thud.frequency.exponentialRampToValueAtTime(52 * pitch, t + 0.14);
    const tg = env(t, 0.003, 0.17, 0.55 * level);
    thud.connect(tg).connect(out);
  }

  /** Air moving — wingbeat, body rush, tyre wash. */
  function whoosh(out, t, dur, level, low = 400, high = 1800) {
    const n = noise(t, dur + 0.1);
    const bp = band('bandpass', low, 0.9);
    bp.frequency.setValueAtTime(low, t);
    bp.frequency.linearRampToValueAtTime(high, t + dur * 0.45);
    bp.frequency.linearRampToValueAtTime(low * 0.7, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    n.connect(bp).connect(g).connect(out);
  }

  /** Struck bell / chime. */
  function chime(out, t, freq, level, dur = 1.4) {
    [1, 2.76, 5.4].forEach((mult, i) => {
      const o = osc('sine', freq * mult, t, dur);
      const g = env(t, 0.004, dur * (1 - i * 0.22), level * (i ? 0.22 / i : 1));
      o.connect(g).connect(out);
    });
  }

  /** Brass-ish fanfare note for the royal arrivals. */
  function brass(out, t, freq, dur, level) {
    const o = osc('sawtooth', freq, t, dur);
    const o2 = osc('sawtooth', freq * 1.005, t, dur);
    const lp = band('lowpass', 900, 3);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(2600, t + 0.09);
    lp.frequency.linearRampToValueAtTime(1100, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.05);
    g.gain.setValueAtTime(level, t + dur * 0.62);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(lp); o2.connect(lp);
    lp.connect(g).connect(out);
  }

  /* ---------------------------------------------------------------- *
   * Per-entrance arrangements. Timings mirror the visual rigs: the gallop
   * cycle matches the leg cycle, the engine revs while the bike is moving
   * fastest, the dragon breathes fire during the centre hold.
   * ---------------------------------------------------------------- */

  const GALLOP = [0, 0.1, 0.44, 0.56];   // the four strikes of a gallop cycle

  function horse(out, t0, D) {
    const cycle = 0.66;                   // matches the rig's 9.5 rad/s gait
    for (let c = 0; c * cycle < D - 0.2; c++) {
      GALLOP.forEach((f, i) => {
        const t = t0 + c * cycle + f * cycle;
        if (t > t0 + D - 0.1) return;
        // Quieter as the horse arrives and again as it leaves.
        const near = 1 - Math.abs((t - t0) / D - 0.45) * 0.9;
        hoof(out, t, (i === 3 ? 1 : 0.72) * clamp(near, 0.25, 1), 0.95 + i * 0.03);
      });
    }
    whoosh(out, t0, 0.9, 0.16, 300, 1400);
    whoosh(out, t0 + D - 1.1, 1.0, 0.13, 900, 260);
    brass(out, t0 + D * 0.34, 392, 0.5, 0.11);
    brass(out, t0 + D * 0.34 + 0.24, 523, 0.75, 0.1);
    [1046, 1318, 1568].forEach((f, i) => chime(out, t0 + D * 0.4 + i * 0.13, f, 0.07));
  }

  function carriage(out, t0, D) {
    const cycle = 0.85;                   // slower, heavier draught trot
    for (let c = 0; c * cycle < D - 0.3; c++) {
      [0, 0.26, 0.5, 0.76].forEach((f, i) => {
        const t = t0 + c * cycle + f * cycle;
        if (t > t0 + D - 0.15) return;
        hoof(out, t, 0.5 + (i % 2) * 0.18, 0.8);
      });
    }
    // Iron rims on stone: a continuous low rumble that rises and falls.
    const n = noise(t0, D);
    const lp = band('lowpass', 260, 1.1);
    const rum = ctx.createGain();
    rum.gain.setValueAtTime(0.0001, t0);
    rum.gain.linearRampToValueAtTime(0.1, t0 + D * 0.28);
    rum.gain.setValueAtTime(0.1, t0 + D * 0.66);
    rum.gain.exponentialRampToValueAtTime(0.001, t0 + D);
    n.connect(lp).connect(rum).connect(out);
    // Harness bells, loosely in time with the trot.
    for (let i = 0; i * 0.42 < D - 0.8; i++) {
      chime(out, t0 + 0.3 + i * 0.42, 1568 + (i % 3) * 210, 0.045, 0.9);
    }
    // Wingbeats.
    for (let i = 0; t0 + i * 1.42 < t0 + D - 0.8; i++) {
      whoosh(out, t0 + 0.15 + i * 1.42, 0.7, 0.14, 240, 1100);
    }
    [523, 659, 784, 1047].forEach((f, i) => brass(out, t0 + D * 0.3 + i * 0.2, f, 0.9, 0.085));
  }

  function bike(out, t0, D) {
    // Two detuned saws through a moving lowpass: the classic engine voice.
    const revs = [
      [0, 70], [D * 0.18, 210], [D * 0.22, 130],           // first gear, shift
      [D * 0.34, 260], [D * 0.38, 150],                     // second, shift
      [D * 0.52, 200], [D * 0.66, 120], [D, 58]             // hold, then away
    ];
    [1, 1.008, 0.5].forEach((mult, i) => {
      const o = osc('sawtooth', 70 * mult, t0, D + 0.2);
      revs.forEach(([t, f]) => o.frequency.linearRampToValueAtTime(f * mult, t0 + t));
      const lp = band('lowpass', 900, 4);
      lp.frequency.setValueAtTime(500, t0);
      lp.frequency.linearRampToValueAtTime(2800, t0 + D * 0.4);
      lp.frequency.linearRampToValueAtTime(700, t0 + D);
      const g = ctx.createGain();
      const lvl = i === 2 ? 0.1 : 0.075;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(lvl, t0 + 0.25);
      g.gain.setValueAtTime(lvl, t0 + D * 0.72);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + D);
      o.connect(lp).connect(g).connect(out);
    });
    // Tyre and wind wash.
    const n = noise(t0, D);
    const hp = band('highpass', 900);
    const wind = ctx.createGain();
    wind.gain.setValueAtTime(0.0001, t0);
    wind.gain.linearRampToValueAtTime(0.055, t0 + D * 0.3);
    wind.gain.exponentialRampToValueAtTime(0.001, t0 + D);
    n.connect(hp).connect(wind).connect(out);
    // Turbo whistle over the hero beat, and two exhaust pops on the shifts.
    const wh = osc('sine', 2600, t0 + D * 0.3, D * 0.3);
    wh.frequency.linearRampToValueAtTime(4200, t0 + D * 0.5);
    const wg = env(t0 + D * 0.3, 0.12, D * 0.3, 0.025);
    wh.connect(wg).connect(out);
    [D * 0.22, D * 0.38].forEach((t) => {
      const pop = noise(t0 + t, 0.12);
      const bp = band('bandpass', 420, 1.6);
      pop.connect(bp).connect(env(t0 + t, 0.002, 0.1, 0.3)).connect(out);
    });
  }

  function dragon(out, t0, D) {
    // Sub rumble under the whole flight.
    const sub = osc('sine', 38, t0, D);
    sub.frequency.linearRampToValueAtTime(30, t0 + D);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.linearRampToValueAtTime(0.12, t0 + 0.8);
    sg.gain.setValueAtTime(0.12, t0 + D * 0.75);
    sg.gain.exponentialRampToValueAtTime(0.001, t0 + D);
    sub.connect(sg).connect(out);

    // Wingbeats at the rig's 3.35 rad/s flap.
    const beat = (2 * Math.PI) / 3.35;
    for (let i = 0; t0 + i * beat < t0 + D - 0.5; i++) {
      whoosh(out, t0 + i * beat, beat * 0.72, 0.19, 160, 900);
    }

    // The roar: detuned saws plus noise through three moving formants.
    const rt = t0 + D * 0.3, rd = 1.5;
    const roarGain = ctx.createGain();
    roarGain.gain.setValueAtTime(0.0001, rt);
    roarGain.gain.linearRampToValueAtTime(0.4, rt + 0.16);
    roarGain.gain.setValueAtTime(0.36, rt + rd * 0.6);
    roarGain.gain.exponentialRampToValueAtTime(0.001, rt + rd);
    roarGain.connect(out);
    [[520, 6], [1120, 9], [2400, 11]].forEach(([f, q], i) => {
      const fmt = band('bandpass', f, q);
      fmt.frequency.setValueAtTime(f * 1.25, rt);
      fmt.frequency.linearRampToValueAtTime(f * 0.78, rt + rd);
      const fg = ctx.createGain();
      fg.gain.value = 0.55 / (i + 1);
      fmt.connect(fg).connect(roarGain);
      [82, 82 * 1.01, 41].forEach((base) => {
        const o = osc('sawtooth', base, rt, rd);
        o.frequency.linearRampToValueAtTime(base * 0.72, rt + rd);
        o.connect(fmt);
      });
      const n = noise(rt, rd);
      const ng = ctx.createGain();
      ng.gain.value = 0.5;
      n.connect(ng).connect(fmt);
    });

    // Fire breath during the centre hold, matching the visual burst.
    const ft = t0 + D * 0.46, fd = D * 0.18;
    const fire = noise(ft, fd);
    const fbp = band('bandpass', 700, 0.7);
    fbp.frequency.setValueAtTime(400, ft);
    fbp.frequency.linearRampToValueAtTime(2200, ft + fd * 0.5);
    fbp.frequency.linearRampToValueAtTime(600, ft + fd);
    const fg = ctx.createGain();
    fg.gain.setValueAtTime(0.0001, ft);
    fg.gain.linearRampToValueAtTime(0.2, ft + 0.12);
    fg.gain.exponentialRampToValueAtTime(0.001, ft + fd);
    fire.connect(fbp).connect(fg).connect(out);

    [784, 1046, 1318].forEach((f, i) => chime(out, t0 + D * 0.62 + i * 0.16, f, 0.05, 1.8));
    whoosh(out, t0 + D - 1.2, 1.1, 0.16, 1100, 220);
  }

  const ARRANGEMENTS = { horse, carriage, bike, dragon };

  /* ---------------------------------------------------------------- *
   * API
   * ---------------------------------------------------------------- */

  function stop() {
    voices.forEach((v) => { try { v.stop(); } catch { /* already finished */ } });
    voices = [];
  }

  return {
    get enabled() { return enabled; },

    /** Must be called from a user gesture the first time. */
    setEnabled(on) {
      enabled = on;
      if (!on) { stop(); return; }
      if (ensure()) ctx.resume().catch(() => {});
    },

    play(key, duration) {
      if (!enabled || !ARRANGEMENTS[key] || !ensure()) return false;
      ctx.resume().catch(() => {});
      stop();
      const t0 = ctx.currentTime + 0.04;
      const out = makeBus(t0, duration);
      try {
        ARRANGEMENTS[key](out, t0, duration);
      } catch {
        stop();                            // a partial arrangement is worse than none
        return false;
      }
      return true;
    },

    stop
  };
}
