/* Ambience — the calm background sounds.
 *
 * All four are real field recordings, bundled as 40-second loops in
 * resources/sounds/ and built by scripts/fetch-sounds.js, which also records
 * where each one came from and under which licence. They are read through the
 * main process (Chromium will not fetch file:// URLs), decoded once, and then
 * looped — the loops are circular by construction, so nothing has to be done
 * at the seam here.
 *
 * Behind each one is also a synthesised bed — coloured noise through a filter
 * or two, moved by slow oscillators so it never sits perfectly still. Those
 * only play if a loop is missing or will not decode, so the section always
 * works, whatever is or is not installed.
 *
 * One sound plays at a time. Starting another crossfades; the context is
 * suspended once nothing is playing, so an idle app costs no audio thread.
 *
 * The rule throughout: a gain is only ever changed by ramping from a value
 * pinned with setValueAtTime at the current time. Assigning .value under a
 * running graph steps the signal, and a step is a click.
 */

(function (global) {
  'use strict';

  // `credit` is what the section shows under the player and what the licences
  // require us to carry. It repeats resources/sounds/CREDITS.md on purpose:
  // that file documents the build, this is what a person reads in the app.
  const SOUNDS = [
    {
      id: 'rain',
      name: 'Rain',
      hint: 'Even, steady rain — the quietest thing to work under',
      credit: { title: 'Calm rain', author: 'Zuvji', license: 'CC BY-SA 4.0' }
    },
    {
      id: 'waves',
      name: 'Waves',
      hint: 'Surf on a beach, rolling in and back out',
      credit: { title: 'Ocean Waves on a Tropical Beach', author: 'Jarrod Stanley', license: 'CC0' }
    },
    {
      id: 'nature',
      name: 'Nature',
      hint: 'Open air and trees, out in the woods',
      credit: { title: 'Bourne woods, windy', author: 'Robert EA Harvey', license: 'CC BY-SA 4.0' }
    },
    {
      id: 'fire',
      name: 'Fireplace',
      hint: 'A bonfire settling and crackling',
      credit: { title: 'Bonfire burning', author: 'Work With Sounds / Werstas', license: 'CC BY 4.0' }
    }
  ];

  const FADE = 0.6; // seconds — start, stop and crossfade all share it
  const BUFFER_SECONDS = 8;
  const SEAM = 0.25; // seconds of circular crossfade at the loop point

  let ctx = null;
  let master = null;
  let current = null; // { id, output, sources, dispose }
  let volume = 0.5;
  let playing = false;
  let suspendTimer = null;
  // Bumped by every play and every stop. A decode that finishes after the
  // user has moved on finds its token stale and drops its voice on the floor.
  let generation = 0;

  const buffers = new Map();
  // id -> { buffer }. Only a couple are kept: a decoded 40s stereo loop is
  // tens of megabytes, and nobody is listening to two sounds at once.
  const loaded = new Map();
  const KEEP = 2;
  // Ids with no loop bundled, so a synthesised sound stops asking every press.
  const missing = new Set();

  function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
  }

  // A slider is read by ear, not by number: squaring it puts the useful range
  // where the hand expects it instead of crowding it into the bottom third.
  function curve(v) {
    return clamp01(v) * clamp01(v) * 0.9;
  }

  /* -------------------------------------------------------------- noise -- */

  // Generated once per colour and shared by every graph that wants it.
  //
  // The tail is folded back into the head so the buffer is circular: sample
  // zero continues the sample before it, which is the difference between a
  // loop you stop hearing and one that ticks every few seconds.
  function noise(kind) {
    if (buffers.has(kind)) return buffers.get(kind);

    const rate = ctx.sampleRate;
    const length = Math.floor(BUFFER_SECONDS * rate);
    const seam = Math.floor(SEAM * rate);
    const raw = new Float32Array(length + seam);

    if (kind === 'white') {
      for (let i = 0; i < raw.length; i++) raw[i] = Math.random() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet's filter: three poles, close enough to -3dB per octave.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        raw[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
      }
    } else {
      // Brown: integrated white, leaked back towards zero so it cannot drift
      // off into inaudible DC and eat the headroom.
      let last = 0;
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last * 3.5;
      }
    }

    for (let i = 0; i < seam; i++) {
      const t = i / seam;
      raw[i] = raw[i] * t + raw[length + i] * (1 - t);
    }

    const buffer = ctx.createBuffer(1, length, rate);
    buffer.copyToChannel(raw.subarray(0, length), 0);
    buffers.set(kind, buffer);
    return buffer;
  }

  /* ------------------------------------------------------------- pieces -- */

  function source(kind) {
    const node = ctx.createBufferSource();
    node.buffer = noise(kind);
    node.loop = true;
    // Two graphs asking for the same colour would otherwise start in lockstep.
    node.start(0, Math.random() * BUFFER_SECONDS);
    return node;
  }

  function filter(type, freq, q) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = freq;
    if (typeof q === 'number') node.Q.value = q;
    return node;
  }

  function gain(value) {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  }

  // A slow oscillator writing into a parameter: the breathing that keeps a bed
  // from reading as a machine. Returned so it can be stopped with the rest.
  function sway(param, freq, depth) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const amount = gain(depth);
    osc.connect(amount).connect(param);
    osc.start(0);
    return osc;
  }

  /* ------------------------------------------------------------- sounds -- */

  const BUILD = {
    // Hiss for the drops, a lowpassed bed for the roof, drifting against each
    // other so the shower seems to pass rather than hold.
    rain(out) {
      const bright = gain(0.5);
      const bp = filter('bandpass', 1200, 0.6);
      const drops = source('white');
      drops.connect(filter('highpass', 400)).connect(bp).connect(bright).connect(out);

      const body = gain(0.45);
      const bed = source('brown');
      bed.connect(filter('lowpass', 420)).connect(body).connect(out);

      return {
        sources: [drops, bed, sway(bright.gain, 0.05, 0.14), sway(body.gain, 0.031, 0.1)]
      };
    },

    // One swell shapes everything: the level, the cutoff, and the foam on top,
    // which only arrives at the crest.
    waves(out) {
      const swell = gain(0.55);
      const lp = filter('lowpass', 430);
      const surf = source('brown');
      surf.connect(lp).connect(swell).connect(out);

      const foam = gain(0);
      const hiss = source('white');
      hiss.connect(filter('highpass', 900)).connect(foam).connect(out);

      return {
        sources: [
          surf,
          hiss,
          sway(swell.gain, 0.07, 0.3),
          sway(lp.frequency, 0.07, 190),
          sway(foam.gain, 0.07, 0.05)
        ]
      };
    },

    // A resonant band sweeping slowly: the sound of air finding a gap.
    nature(out) {
      const bp = filter('bandpass', 600, 2.2);
      const level = gain(0.85);
      const air = source('pink');
      air.connect(bp).connect(level).connect(out);

      return {
        sources: [air, sway(bp.frequency, 0.055, 300), sway(level.gain, 0.023, 0.3)]
      };
    },

    // A warm bed with grains scattered over it. The crackles are scheduled in
    // real time rather than baked into a loop, so no rhythm ever emerges.
    // Like its siblings here, this only plays if the bundled loop is missing.
    fire(out) {
      const bed = gain(0.55);
      const logs = source('brown');
      logs.connect(filter('lowpass', 760)).connect(bed).connect(out);

      const spark = filter('bandpass', 2000, 1.4);
      spark.connect(out);

      let timer = null;
      const pop = () => {
        try {
          const now = ctx.currentTime;
          const grain = ctx.createBufferSource();
          grain.buffer = noise('white');
          const env = gain(0.0001);
          grain.connect(env).connect(spark);
          const peak = 0.05 + Math.random() * 0.22;
          env.gain.setValueAtTime(0.0001, now);
          env.gain.linearRampToValueAtTime(peak, now + 0.004);
          env.gain.exponentialRampToValueAtTime(0.0001, now + 0.06 + Math.random() * 0.06);
          grain.start(now, Math.random() * BUFFER_SECONDS, 0.16);
          grain.stop(now + 0.18);
          grain.onended = () => {
            try {
              env.disconnect();
            } catch { }
          };
        } catch { }
        timer = setTimeout(pop, 40 + Math.random() * 380);
      };
      timer = setTimeout(pop, 120);

      return {
        sources: [logs],
        dispose: () => clearTimeout(timer)
      };
    },

  };

  /* -------------------------------------------------------------- chime -- */

  /* The tone that marks the end of an interval.
   *
   * A struck bell, not a beep: three partials, each falling away at its own
   * rate, with the upper two detuned a couple of Hz against the harmonics they
   * sit on. That slow beating is most of what separates a bell from an organ
   * note, and the staggered decays are the rest — the top of a real bell dies
   * long before its fundamental does.
   *
   * It goes straight to the output rather than through the master gain, so the
   * ambience slider does not quietly turn the chime down too. */

  const BELL = [
    { freq: 440, level: 1, decay: 2 },
    { freq: 882, level: 0.35, decay: 1.4 },
    { freq: 1322, level: 0.18, decay: 0.8 }
  ];

  const CHIME_LEVEL = 0.25;
  const DUCK = 0.5; // how far the bed drops under the bell, about -6 dB

  function chime() {
    try {
      if (!ensure()) return false;
      clearTimeout(suspendTimer);
      if (ctx.state === 'suspended') ctx.resume();

      const now = ctx.currentTime;
      const out = gain(CHIME_LEVEL);
      out.connect(filter('lowpass', 4000)).connect(ctx.destination);

      let longest = 0;
      for (const partial of BELL) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = partial.freq;

        // Exponential ramps cannot reach zero, so the tail lands on silence
        // rather than at it, and the oscillator stops a moment later.
        const env = gain(0.0001);
        env.gain.setValueAtTime(0.0001, now);
        env.gain.exponentialRampToValueAtTime(partial.level, now + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, now + partial.decay);

        osc.connect(env).connect(out);
        osc.start(now);
        osc.stop(now + partial.decay + 0.05);
        osc.onended = () => {
          try {
            osc.disconnect();
            env.disconnect();
          } catch { }
        };
        longest = Math.max(longest, partial.decay);
      }

      setTimeout(() => {
        try {
          out.disconnect();
        } catch { }
      }, (longest + 0.3) * 1000);

      // A bell at this level is lost inside a rain bed at the same level, so
      // the bed steps aside for it and eases back over about a second.
      if (playing && master) {
        const level = curve(volume);
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(master.gain.value, now);
        master.gain.linearRampToValueAtTime(level * DUCK, now + 0.12);
        master.gain.setTargetAtTime(level, now + 0.35, 0.3);
      }

      return true;
    } catch (err) {
      console.warn('[ambience] could not sound the chime:', err && err.message);
      return false;
    }
  }

  /* ------------------------------------------------------------- engine -- */

  function ensure() {
    if (ctx) return true;
    const Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return false;
    // Pinned to 48 kHz rather than taking the device rate. decodeAudioData
    // resamples to whatever the context runs at, and on a 192 kHz interface a
    // 40-second stereo loop decodes to 60 MB instead of 15.
    try {
      ctx = new Ctor({ sampleRate: 48000 });
    } catch {
      ctx = new Ctor();
    }
    master = ctx.createGain();
    master.gain.value = curve(volume);
    master.connect(ctx.destination);
    return true;
  }

  function synthVoice(id) {
    const out = gain(0.0001);
    const made = BUILD[id](out);
    return { id, output: out, sources: made.sources || [], dispose: made.dispose || null };
  }

  // The recording is already circular, so looping it is the whole trick. The
  // random offset means pressing play twice does not start the same 40 seconds
  // from the same place twice.
  function fileVoice(id, buffer) {
    const out = gain(0.0001);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.connect(out);
    node.start(0, Math.random() * buffer.duration);
    return { id, output: out, sources: [node], dispose: null };
  }

  function evict() {
    while (loaded.size > KEEP) {
      const oldest = loaded.keys().next().value;
      if (oldest === undefined) break;
      loaded.delete(oldest);
    }
  }

  // Returns { buffer } for the loop behind this id, or null when there is none
  // bundled and the synthesiser should take over. The loops never change under
  // a running app, so one read and one decode per sound is all it ever costs —
  // and a buffer dropped by the cache is simply read again.
  async function recording(id) {
    const have = loaded.get(id);
    if (have) return have;
    if (missing.has(id)) return null;

    const api = global.pomodoro;
    if (!api || !api.sounds) return null;

    try {
      const bytes = await api.sounds.file(id);
      if (!bytes || !bytes.byteLength) {
        missing.add(id);
        return null;
      }
      // Electron hands a Buffer across; take a copy of exactly its bytes,
      // because decodeAudioData detaches whatever it is given.
      const buffer = await ctx.decodeAudioData(new Uint8Array(bytes).slice().buffer);
      const entry = { buffer };
      loaded.set(id, entry);
      evict();
      return entry;
    } catch (err) {
      console.warn(`[ambience] falling back to synthesis for ${id}:`, err && err.message);
      return null;
    }
  }

  // Ramp it away, then take it apart once the ramp has finished. Tearing the
  // graph down on the same frame is what a cut sounds like.
  function retire(voice) {
    if (!voice) return;
    const now = ctx.currentTime;
    try {
      voice.output.gain.setValueAtTime(voice.output.gain.value, now);
      voice.output.gain.linearRampToValueAtTime(0.0001, now + FADE);
    } catch { }
    if (voice.dispose) voice.dispose();
    setTimeout(() => {
      for (const node of voice.sources) {
        try {
          node.stop();
        } catch { }
        try {
          node.disconnect();
        } catch { }
      }
      try {
        voice.output.disconnect();
      } catch { }
    }, (FADE + 0.15) * 1000);
  }

  // Resolves once the sound is actually audible. It reports true the moment
  // the intent is taken, though — the button flips on the press, not after a
  // decode — which is what playing tracks.
  async function play(id) {
    try {
      if (!ensure()) return false;
      const wanted = SOUNDS.some((s) => s.id === id) ? id : SOUNDS[0].id;
      const token = ++generation;

      clearTimeout(suspendTimer);
      if (ctx.state === 'suspended') ctx.resume();
      playing = true;

      const entry = await recording(wanted);
      // Stopped, or asked for something else, while the file was decoding.
      if (token !== generation) return false;

      const voice = entry ? fileVoice(wanted, entry.buffer) : synthVoice(wanted);
      voice.output.connect(master);

      const now = ctx.currentTime;
      voice.output.gain.setValueAtTime(0.0001, now);
      voice.output.gain.linearRampToValueAtTime(1, now + FADE);

      retire(current);
      current = voice;
      return true;
    } catch (err) {
      console.warn('[ambience] could not start:', err && err.message);
      return false;
    }
  }

  function stop() {
    playing = false;
    generation++;
    if (!ctx || !current) return;
    retire(current);
    current = null;
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (!playing && ctx && ctx.state === 'running') ctx.suspend();
    }, (FADE + 0.4) * 1000);
  }

  function setVolume(value) {
    volume = clamp01(value);
    if (!master) return;
    // A short glide, not a jump: dragging the slider must not zipper.
    try {
      master.gain.setTargetAtTime(curve(volume), ctx.currentTime, 0.04);
    } catch { }
  }

  global.Ambience = {
    SOUNDS,
    play,
    stop,
    chime,
    setVolume,
    isPlaying: () => playing,
    currentId: () => (current ? current.id : null),
    // True once the bundled loop for this id has been decoded — the section
    // reads it to decide between a credit and saying the sound is generated.
    isRecorded: (id) => Boolean(loaded.get(id)),
    // A window on the cache, for diagnostics and for the tests that check
    // decoded buffers are actually being let go. Nothing in the UI reads it.
    stats: () => ({
      decoded: loaded.size,
      sampleRate: ctx ? ctx.sampleRate : null,
      // The live master gain. Worth watching because the chime borrows it for
      // its duck: a bed left quiet after a chime would show up here.
      master: master ? master.gain.value : null,
      target: curve(volume)
    })
  };
})(window);
