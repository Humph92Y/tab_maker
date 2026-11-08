// ===== 소리 재생 (Web Audio) =====
// 기타 줄 소리는 Karplus-Strong(줄 진동을 흉내내는 고전 합성법)으로 직접 만들어서
// 인터넷 연결 없이, 저작권 걱정 없이 재생됨. 슬라이드/벤딩은 실제로 음높이가 이동함.

const Player = (() => {
  let ctx = null, input, cleanOut, distIn, master, reverbSend;
  const bufCache = {};
  let sources = [], timers = [], playing = false;
  let passes = []; // {start, beats:[{id,t,d}], end}
  let onStop = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    // 리버브(공간감)
    const conv = ctx.createConvolver(); conv.buffer = makeImpulse(1.6);
    reverbSend = ctx.createGain(); reverbSend.gain.value = 0.18;
    reverbSend.connect(conv); conv.connect(master);
    input = ctx.createGain();
    // 클린 톤
    cleanOut = ctx.createBiquadFilter(); cleanOut.type = 'lowpass'; cleanOut.frequency.value = 6500;
    const cleanG = ctx.createGain(); cleanG.gain.value = 0.9;
    cleanOut.connect(cleanG); cleanG.connect(master); cleanG.connect(reverbSend);
    // 디스토션 톤: 게인 → 클리핑 → 앰프/캐비닛 느낌 필터
    distIn = ctx.createBiquadFilter(); distIn.type = 'highpass'; distIn.frequency.value = 110;
    const pre = ctx.createGain(); pre.gain.value = 28;
    const shaper = ctx.createWaveShaper(); shaper.curve = distCurve(60); shaper.oversample = '4x';
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 800; mid.gain.value = 4; mid.Q.value = 0.8;
    const cab = ctx.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = 4200; cab.Q.value = 0.9;
    const cab2 = ctx.createBiquadFilter(); cab2.type = 'lowpass'; cab2.frequency.value = 6000;
    const post = ctx.createGain(); post.gain.value = 0.16;
    distIn.connect(pre); pre.connect(shaper); shaper.connect(mid); mid.connect(cab); cab.connect(cab2); cab2.connect(post);
    post.connect(master); post.connect(reverbSend);
    setTone('clean');
  }

  function setTone(t) {
    if (!ctx) return;
    input.disconnect();
    input.connect(t === 'distortion' ? distIn : cleanOut);
  }

  function distCurve(k) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (1 + k) * x / (1 + k * Math.abs(x)) * 0.9 + (x > 0 ? 0.02 : 0); }
    return c;
  }
  function makeImpulse(sec) {
    const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    return b;
  }

  // Karplus-Strong 줄 소리 만들기
  function getBuf(midi) {
    if (bufCache[midi]) return bufCache[midi];
    const sr = ctx.sampleRate, f = 440 * Math.pow(2, (midi - 69) / 12);
    const dur = midi < 52 ? 4.5 : midi < 64 ? 3.5 : 2.6;
    const len = Math.floor(sr * dur);
    const N = Math.max(2, Math.round(sr / f - 0.5));
    const line = new Float32Array(N);
    for (let i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
    for (let i = 0; i < N; i++) line[i] = (line[i] + line[(i + 1) % N]) * 0.5; // 살짝 부드럽게
    let mean = 0; for (let i = 0; i < N; i++) mean += line[i]; mean /= N; for (let i = 0; i < N; i++) line[i] -= mean;
    const rho = Math.pow(0.001, 1 / (sr * 7));
    const data = new Float32Array(len);
    let p = 0;
    for (let n = 0; n < len; n++) {
      const nx = (p + 1) % N;
      data[n] = line[p];
      line[p] = rho * 0.5 * (line[p] + line[nx]);
      p = nx;
    }
    // 피킹 위치 효과
    const pd = Math.max(1, Math.round(N * 0.18));
    for (let n = len - 1; n >= pd; n--) data[n] -= 0.35 * data[n - pd];
    let peak = 0; for (let n = 0; n < len; n++) peak = Math.max(peak, Math.abs(data[n]));
    const fade = Math.floor(sr * 0.08);
    for (let n = 0; n < len; n++) { data[n] = data[n] / peak * 0.5; if (n > len - fade) data[n] *= (len - n) / fade; }
    const ab = ctx.createBuffer(1, len, sr); ab.copyToChannel ? ab.copyToChannel(data, 0) : ab.getChannelData(0).set(data);
    const actual = sr / (N + 0.5);
    bufCache[midi] = { buf: ab, corr: f / actual };
    return bufCache[midi];
  }

  // 하나의 '울림'(같은 줄에서 레가토로 이어지는 음들 포함) 재생
  function voice(v) {
    const { buf, corr } = getBuf(v.midi);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const pr = src.playbackRate;
    const rate = (semi) => corr * Math.pow(2, semi / 12);
    pr.setValueAtTime(rate(v.startSemi || 0), v.t0);
    v.events.sort((a, b) => a.t - b.t).forEach(e => {
      if (e.ramp) { pr.setValueAtTime(rate(e.from), e.t); pr.linearRampToValueAtTime(rate(e.semi), e.t + e.len); }
      else pr.setValueAtTime(rate(e.semi), e.t);
    });
    const g = ctx.createGain();
    let node = src;
    if (v.filter) { const lp = ctx.createBiquadFilter(); lp.type = v.filter.type; lp.frequency.value = v.filter.freq; src.connect(lp); node = lp; }
    node.connect(g); g.connect(input);
    g.gain.setValueAtTime(0, v.t0);
    g.gain.linearRampToValueAtTime(v.vel, v.t0 + 0.004);
    if (v.decay) g.gain.setTargetAtTime(0, v.t0 + 0.01, v.decay);
    else g.gain.setValueAtTime(v.vel, v.t1);
    g.gain.setTargetAtTime(0, Math.max(v.t1, v.t0 + 0.01), 0.02);
    src.start(v.t0); src.stop(v.t1 + 0.25);
    sources.push(src);
    src.onended = () => { const i = sources.indexOf(src); if (i >= 0) sources.splice(i, 1); };
  }

  function click(t, accent) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1600 : 1050;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.06); sources.push(o);
  }

  const harmOffset = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };

  // 곡 → 재생 일정 만들기
  function schedulePass(song, opts, t0) {
    const tuning = TUNINGS[song.tuning].midi;
    const spq = 60 / (song.bpm * opts.speed); // 4분음표 1개 = 몇 초
    const tk = (ticks) => ticks / 480 * spq;
    const flat = flatBeats(song).filter(fb => fb.mi >= opts.from && fb.mi <= opts.to);
    if (!flat.length) return 0;
    const base = flat[0].onset;
    let endTick = 0;
    for (let mi = opts.from; mi <= opts.to && mi < song.measures.length; mi++) endTick += Math.max(measureFill(song.measures[mi]), measureCapacity(measureTs(song, mi)));
    const beats = flat.map(fb => ({ id: fb.beat.id, mi: fb.mi, t: t0 + tk(fb.onset - base), d: tk(fb.ticks) }));
    // 메트로놈
    if (opts.metronome) {
      let tick = 0;
      for (let mi = opts.from; mi <= opts.to; mi++) {
        const ts = measureTs(song, mi), unit = 1920 / ts[1];
        for (let k = 0; k < ts[0]; k++) click(t0 + tk(tick + k * unit), k === 0);
        tick += Math.max(measureFill(song.measures[mi]), measureCapacity(ts));
      }
    }
    const consumed = new Set();
    const index = new Map(); flat.forEach((fb, i) => index.set(fb.beat.id, i));
    flat.forEach((fb, i) => {
      const b = fb.beat; if (isRest(b)) return;
      const bt = t0 + tk(fb.onset - base) - (b.grace ? 0.07 : 0), bd = b.grace ? 0.07 : tk(fb.ticks);
      // 코드는 피킹 방향으로 살짝 시간차(스트럼)
      const ordered = b.notes.slice().sort((x, y) => y.s - x.s);
      const dir = (b.pick || b.pa) === 'u' ? -1 : 1;
      if (dir < 0) ordered.reverse();
      const strum = b.notes.length >= 3 ? 0.012 : 0;
      ordered.forEach((n, k) => {
        if (consumed.has(n.id)) return;
        const st = bt + k * strum;
        let vel = 0.55 * (n.ghost ? 0.45 : 1) * (n.acc ? 1.35 : 1);
        let midi = tuning[n.s] + n.f;
        const v = { t0: st, t1: bt + bd, midi, events: [], vel, startSemi: 0 };
        if (n.dead) { v.t1 = st + 0.05; v.filter = { type: 'lowpass', freq: 1200 }; v.vel *= 0.8; voice(v); return; }
        if (n.harm) { v.midi = tuning[n.s] + (harmOffset[n.f] || 12); v.filter = { type: 'highpass', freq: 900 }; v.vel *= 0.7; v.t1 = bt + bd + 1.2; voice(v); return; }
        if (n.pm) { v.filter = { type: 'lowpass', freq: 750 }; v.decay = 0.09; }
        if (n.slide === 'in') { v.startSemi = -4; for (let s = -3; s <= 0; s++) v.events.push({ t: st + (s + 4) * 0.02, semi: s }); }
        // 레가토 체인 따라가기
        let cur = n, curSemi = 0, curT = st, curD = bd, curMi = fb.mi, curBi = fb.bi;
        let endT = bt + bd;
        const applyTech = (note, t, d, semi) => {
          if (note.bend) {
            const up = semi + note.bend.a * 2;
            const rise = Math.min(0.2, d * 0.45);
            v.events.push({ t: t + 0.03, ramp: true, from: semi, semi: up, len: rise });
            if (note.bend.r) v.events.push({ t: t + Math.max(d * 0.6, rise + 0.06), ramp: true, from: up, semi, len: Math.min(0.2, d * 0.35) });
          }
          if (note.vib) {
            const s0 = note.bend && !note.bend.r ? semi + note.bend.a * 2 : semi;
            for (let tt = t + (note.bend ? Math.min(0.28, d * 0.6) : Math.min(0.12, d * 0.3)); tt < t + d - 0.02; tt += 0.025) v.events.push({ t: tt, semi: s0 + 0.35 * Math.sin((tt - t) * 2 * Math.PI * 5.5) });
          }
          if (note.slide === 'out') { const n2 = Math.min(0.18, d * 0.5); for (let s = 1; s <= 6; s++) v.events.push({ t: t + d - n2 + n2 * s / 6, semi: semi - s }); }
        };
        applyTech(cur, curT, curD, curSemi);
        while (cur.hp || cur.slide === 'to') {
          const nx = nextOnString(song, curMi, curBi, cur.s);
          if (!nx || !index.has(nx.beat.id)) break;
          const nfb = flat[index.get(nx.beat.id)];
          const nt = t0 + tk(nfb.onset - base), nd = tk(nfb.ticks);
          const target = nx.note.f - n.f;
          if (cur.slide === 'to') {
            const span = Math.min(0.12, (nt - curT) * 0.5); const steps = Math.abs(target - curSemi) || 1;
            for (let s = 1; s <= steps; s++) v.events.push({ t: nt - span + span * s / steps, semi: curSemi + Math.sign(target - curSemi) * s });
          } else v.events.push({ t: nt, semi: target });
          consumed.add(nx.note.id);
          cur = nx.note; curSemi = target; curT = nt; curD = nd; curMi = nx.mi; curBi = nx.bi; endT = nt + nd;
          applyTech(cur, curT, curD, curSemi);
        }
        // 붙임줄(tie)로 이어진 음은 길이만 늘림
        let tieNext = nextOnString(song, curMi, curBi, n.s);
        while (tieNext && tieNext.note.tie && index.has(tieNext.beat.id)) {
          const tfb = flat[index.get(tieNext.beat.id)];
          consumed.add(tieNext.note.id); endT = t0 + tk(tfb.onset - base) + tk(tfb.ticks);
          tieNext = nextOnString(song, tieNext.mi, tieNext.bi, n.s);
        }
        if (n.lr) { const nxs = nextOnString(song, curMi, curBi, n.s); endT = nxs && index.has(nxs.beat.id) ? t0 + tk(flat[index.get(nxs.beat.id)].onset - base) : endT + 2.5; }
        v.t1 = endT;
        voice(v);
      });
    });
    const total = tk(endTick);
    passes.push({ start: t0, end: t0 + total, beats });
    return total;
  }

  function play(song, opts, stopCb) {
    init(); stop(true);
    if (ctx.state === 'suspended') ctx.resume();
    setTone(song.tone);
    playing = true; onStop = stopCb;
    let t = ctx.currentTime + 0.15;
    if (opts.countIn) {
      const ts = measureTs(song, opts.from), spq = 60 / (song.bpm * opts.speed), unit = spq * 4 / ts[1];
      for (let k = 0; k < ts[0]; k++) click(t + k * unit, k === 0);
      t += unit * ts[0];
    }
    const runPass = (start) => {
      const dur = schedulePass(song, opts, start);
      if (dur <= 0) { stop(); return; }
      const endAt = start + dur;
      if (opts.loop) timers.push(setTimeout(() => { if (playing) runPass(endAt); }, Math.max(0, (endAt - ctx.currentTime - 0.6) * 1000)));
      else timers.push(setTimeout(() => { if (playing) stop(); }, (endAt - ctx.currentTime + 0.4) * 1000));
    };
    runPass(t);
  }

  function stop(silent) {
    timers.forEach(clearTimeout); timers = [];
    sources.forEach(s => { try { s.stop(); } catch (e) { } }); sources = [];
    passes = [];
    const was = playing; playing = false;
    if (was && !silent && onStop) onStop();
  }

  // 현재 재생 중인 박 id
  function currentBeat() {
    if (!playing || !ctx) return null;
    const now = ctx.currentTime;
    for (let p = passes.length - 1; p >= 0; p--) {
      const ps = passes[p]; if (now < ps.start) continue;
      let cur = null; for (const b of ps.beats) { if (b.t <= now) cur = b; else break; }
      return cur;
    }
    return null;
  }

  function preview(midi, tone) {
    init(); if (ctx.state === 'suspended') ctx.resume(); setTone(tone);
    const t = ctx.currentTime + 0.02;
    voice({ t0: t, t1: t + 0.9, midi, events: [], vel: 0.5, startSemi: 0 });
  }

  return { play, stop, currentBeat, preview, isPlaying: () => playing };
})();
