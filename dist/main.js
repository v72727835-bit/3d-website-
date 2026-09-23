'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const entries = [
    { key: 'horse', name: 'Horse rider', action: 'horse rider', file: 'assets/horse-entry.mp4', color: '#ffbd64', duration: 4.1, duration3d: 5 },
    { key: 'carriage', name: 'Royal rath', action: 'royal rath', file: 'assets/carriage-entry.mp4', color: '#dab4ff', duration: 3.8, duration3d: 6.4 },
    { key: 'bike', name: 'Superbike', action: 'superbike', file: 'assets/bike-entry.mp4', color: '#b2acff', duration: 2.6, duration3d: 4 },
    { key: 'dragon', name: 'Golden dragon', action: 'golden dragon', color: '#ffdc7e', duration: 6, duration3d: 6.8 }
  ];
  const room = document.querySelector('.room');
  const stage = $('entry-stage');
  const video = $('entry-video');
  const steps = [...document.querySelectorAll('.entry-sequence li')];
  // Sound is on by default.  AudioContext creation still happens from the
  // Enter click, which keeps it compatible with mobile browser audio rules.
  let next = 0, last = -1, playing = false, enabledSound = true, run = 0;
  let finishTimer, loadTimer, particleFrame;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  // Entrances are rendered live in WebGL. The filmed reference clips stay on
  // disk purely as a fallback for browsers without a usable WebGL context.
  let gl = null, sfx = null;
  import('./entrysfx.js')
    .then((mod) => {
      sfx = mod.createSfx();
      if (enabledSound) sfx.setEnabled(true);
    })
    .catch(() => { sfx = null; });
  const engineReady = import('./entry3d.js')
    .then(async (mod) => {
      gl = mod.createEntryEngine($('stage3d'));
      if (!gl) throw new Error('no webgl');
      room.classList.add('gl');
      gl.resize();
      await Promise.all(entries.map((e) => gl.prepare(e.key)));
      window.addEventListener('resize', () => gl.resize(), { passive: true });
    })
    .catch(() => {
      gl = null;
      room.classList.remove('gl');
      video.src = entries[0].file;
      video.load();
    });
  const stars = document.querySelector('.ambient-stars');
  for (let i = 0; i < 48; i++) {
    const dot = document.createElement('i');
    dot.style.cssText = `left:${(i * 41.73) % 100}%;top:${(i * 29.17) % 78}%;--duration:${2 + (i % 5)}s;--delay:-${i % 7}s;`;
    stars.appendChild(dot);
  }

  function updateControls(active = -1) {
    $('enter').disabled = playing;
    $('replay').disabled = playing || last < 0;
    $('button-label').textContent = playing ? `${entries[active].name} entering…` : `Enter with ${entries[next].action}`;
    $('sequence-count').textContent = `${String((playing ? active : next) + 1).padStart(2, '0')} / 04`;
    $('hint').textContent = playing ? 'Your entrance is playing' : 'Tap to enter · A new ride with every click';
    steps.forEach((step, i) => {
      step.classList.toggle('next', i === (playing ? active : next));
      step.classList.toggle('playing', playing && i === active);
      step.classList.toggle('played', !playing && i === last && i !== next);
      if (i === (playing ? active : next)) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
  }

  function stopSounds() {
    sfx?.stop();
  }

  function playSound(index) {
    // Hooves, wingbeats, engine and roar are synthesised in entrysfx.js and
    // scheduled against the audio clock, so they stay in step with the rig.
    sfx?.play(entries[index].key, entries[index].duration);
  }

  function updateSoundControl() {
    $('sound').setAttribute('aria-pressed', String(enabledSound));
    $('sound').setAttribute('aria-label', `Turn entrance sound ${enabledSound ? 'off' : 'on'}`);
    $('sound').title = `Turn sound ${enabledSound ? 'off' : 'on'}`;
    $('sound').querySelector('use').setAttribute('href', enabledSound ? '#i-sound' : '#i-mute');
  }

  function particles(color, duration) {
    cancelAnimationFrame(particleFrame);
    const canvas = $('particles');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = stage.clientWidth, h = 340, dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced.matches) return;
    const born = performance.now();
    const motes = Array.from({ length: 55 }, (_, i) => ({ x: (i * 67.93) % w, y: (i * 43.72) % h, radius: .6 + i % 3, speed: 10 + i % 25, phase: i * 1.3 }));
    function frame(t) {
      const elapsed = (t - born) / 1000;
      ctx.clearRect(0, 0, w, h);
      if (!playing || elapsed > duration) return;
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 7;
      const fade = Math.min(elapsed * 2, 1, (duration - elapsed) * 2);
      motes.forEach((p) => {
        ctx.globalAlpha = Math.max(0, (.25 + .35 * Math.sin(elapsed * 3 + p.phase)) * fade);
        ctx.beginPath();
        ctx.arc((p.x - elapsed * p.speed + w * 2) % w, (p.y - elapsed * 11 + h * 2) % h, p.radius, 0, Math.PI * 2);
        ctx.fill();
      });
      particleFrame = requestAnimationFrame(frame);
    }
    particleFrame = requestAnimationFrame(frame);
  }

  function finish(token, failed = false) {
    if (token !== run) return;
    clearTimeout(finishTimer); clearTimeout(loadTimer);
    video.onended = null; video.onerror = null;
    video.pause();
    gl?.stop();
    playing = false;
    stage.classList.remove('visible');
    stage.setAttribute('aria-hidden', 'true');
    room.classList.remove('is-playing');
    cancelAnimationFrame(particleFrame);
    stopSounds();
    updateControls();
    if (failed) {
      $('message-heading').textContent = 'Entrance could not load';
      $('message-detail').textContent = 'Tap the button to try again.';
    } else {
      $('message-heading').textContent = `${entries[last].name} · Arrived`;
      $('message-detail').textContent = `Next entrance: ${entries[next].name}`;
    }
  }

  async function start(index, replay = false) {
    if (playing) return;
    // This runs synchronously inside the button press, so the soundtrack is
    // unlocked before the WebGL preload has a chance to delay the entry.
    if (enabledSound) sfx?.setEnabled(true);
    const entry = entries[index];
    const token = ++run;
    playing = true;
    $('menu-panel').hidden = true;
    $('menu').setAttribute('aria-expanded', 'false');
    updateControls(index);
    await engineReady;
    if (token !== run) return;
    $('message-heading').textContent = `${entry.name} is arriving`;
    $('message-detail').textContent = 'The room is yours.';
    stage.className = `entry-stage ${entry.key}`;
    video.pause();
    video.onended = null; video.onerror = null;
    let started = false;
    const reveal = () => {
      if (token !== run || started) return;
      started = true;
      clearTimeout(loadTimer);
      last = index;
      if (!replay) next = (index + 1) % entries.length;
      stage.classList.add('visible');
      stage.setAttribute('aria-hidden', 'false');
      room.classList.add('is-playing');
      playSound(index);
      if (!gl) particles(entry.color, entry.duration);
      finishTimer = setTimeout(() => finish(token), (entry.duration + .7) * 1000);
    };
    loadTimer = setTimeout(() => finish(token, true), 12000);
    if (gl) {
      const seconds = entry.duration3d;
      entry.duration = seconds;
      if (gl.play(entry.key, seconds, () => finish(token))) {
        reveal();
        clearTimeout(finishTimer);
        // The engine reports its own completion; this only guards a lost frame loop.
        finishTimer = setTimeout(() => finish(token), (seconds + 1.5) * 1000);
        return;
      }
    }
    if (entry.file) {
      video.src = entry.file;
      video.currentTime = 0;
      video.onended = () => finish(token);
      video.onerror = () => finish(token, true);
      try { await video.play(); reveal(); } catch { finish(token, true); }
    } else {
      try {
        const img = $('dragon-image');
        if (!img.complete || !img.naturalWidth) await img.decode();
        if (token !== run) return;
        // Start CSS flight only once the image is decoded, including on replay.
        stage.classList.remove('dragon');
        void stage.offsetWidth;
        stage.classList.add('dragon');
        reveal();
        clearTimeout(finishTimer);
        finishTimer = setTimeout(() => finish(token), entry.duration * 1000);
      } catch { finish(token, true); }
    }
  }

  function reset() {
    ++run;
    clearTimeout(finishTimer); clearTimeout(loadTimer); cancelAnimationFrame(particleFrame);
    video.pause(); video.onended = null; video.onerror = null;
    gl?.stop();
    stopSounds(); playing = false; next = 0; last = -1;
    stage.className = 'entry-stage'; stage.setAttribute('aria-hidden', 'true');
    room.classList.remove('is-playing');
    $('menu-panel').hidden = true; $('menu').setAttribute('aria-expanded', 'false');
    $('message-heading').textContent = 'Welcome to the room';
    $('message-detail').textContent = 'Make your royal entrance.';
    updateControls();
  }

  $('enter').addEventListener('click', () => start(next));
  $('replay').addEventListener('click', () => { if (last >= 0) start(last, true); });
  $('reset').addEventListener('click', reset);
  $('menu-reset').addEventListener('click', reset);
  $('sound').addEventListener('click', () => {
    enabledSound = !enabledSound;
    // The first enable happens inside a click, which is what unlocks audio.
    sfx?.setEnabled(enabledSound);
    updateSoundControl();
  });
  $('menu').addEventListener('click', () => {
    $('menu-panel').hidden = !$('menu-panel').hidden;
    $('menu').setAttribute('aria-expanded', String(!$('menu-panel').hidden));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#menu-panel') && !event.target.closest('#menu')) {
      $('menu-panel').hidden = true;
      $('menu').setAttribute('aria-expanded', 'false');
    }
  });
  $('edit').addEventListener('click', () => $('edit-dialog').showModal());
  $('cancel-edit').addEventListener('click', () => $('edit-dialog').close());
  $('edit-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const roomName = $('name-input').value.trim();
    const arrivalName = $('arrival-input').value.trim();
    if (!roomName || !arrivalName) return;
    $('room-name').textContent = roomName;
    $('arrival-name').textContent = arrivalName;
    document.querySelector('.host-name').replaceChildren(Object.assign(document.createElement('i'), { textContent: '●' }), document.createTextNode(` ${arrivalName}`));
    document.querySelector('.host-avatar>span').textContent = arrivalName[0].toUpperCase();
    document.title = `${roomName} · Royal Entries`;
    $('edit-dialog').close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { $('menu-panel').hidden = true; $('menu').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopSounds(); });
  updateSoundControl();
  updateControls();
})();
