// ===== 악보 데이터 구조 (Model) =====
// 한 곡(song) = 여러 마디(measures), 한 마디 = 여러 박(beats), 한 박 = 여러 음(notes)
// 줄 번호 s: 0 = 1번줄(가장 가는 높은 E) ... 5 = 6번줄(가장 굵은 낮은 E)

const TICKS = { 1: 1920, 2: 960, 4: 480, 8: 240, 16: 120, 32: 60 }; // 4분음표 = 480
const DUR_LIST = [1, 2, 4, 8, 16, 32];
const DUR_LABEL = { 1: '온음표', 2: '2분음표', 4: '4분음표', 8: '8분음표', 16: '16분음표', 32: '32분음표' };

const TUNINGS = {
  standard: { name: '표준 (E A D G B E)', midi: [64, 59, 55, 50, 45, 40] },
  dropD: { name: '드롭 D (D A D G B E)', midi: [64, 59, 55, 50, 45, 38] },
  halfDown: { name: '반음 내림 (Eb)', midi: [63, 58, 54, 49, 44, 39] },
  wholeDown: { name: '온음 내림 (D)', midi: [62, 57, 53, 48, 43, 38] },
  dropC: { name: '드롭 C (C G C F A D)', midi: [62, 57, 53, 48, 43, 36] },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiName(m, withOct = true) { return NOTE_NAMES[((m % 12) + 12) % 12] + (withOct ? (Math.floor(m / 12) - 1) : ''); }

let _uidN = 1;
function uid() { return 'i' + (_uidN++).toString(36) + Math.random().toString(36).slice(2, 6); }

function newBeat(dur = 8) { return { id: uid(), dur, dot: false, trip: false, notes: [], pick: null }; }
function newMeasure() { return { id: uid(), beats: [], ts: null, section: '' }; }
function newNote(s, f) { return { id: uid(), s, f }; }
function newSong() {
  return {
    version: 1, title: '제목 없음', artist: '', bpm: 100, ts: [4, 4], tuning: 'standard', tone: 'clean',
    view: { fingers: false, picks: false, names: false, fingerNums: false, perLine: 4 },
    fx: { rev: true, revAmt: 25, del: false, delAmt: 30, delTime: '8d' },
    measures: Array.from({ length: 8 }, newMeasure),
  };
}

function beatTicks(b) { if (b.grace) return 0; let t = TICKS[b.dur]; if (b.dot) t *= 1.5; if (b.trip) t = t * 2 / 3; return t; }
function isRest(b) { return !b.notes || b.notes.length === 0; }
function measureTs(song, mi) { for (let i = mi; i >= 0; i--) if (song.measures[i].ts) return song.measures[i].ts; return song.ts; }
function measureCapacity(ts) { return ts[0] * 1920 / ts[1]; }
function measureFill(m) { return m.beats.reduce((a, b) => a + beatTicks(b), 0); }
function noteMidi(song, n) { return TUNINGS[song.tuning].midi[n.s] + n.f; }
function noteAt(beat, s) { return beat ? beat.notes.find(n => n.s === s) : null; }

// 곡 전체를 한 줄로 펼친 박 목록 (시작 위치 tick 포함)
function flatBeats(song) {
  const out = []; let t = 0;
  song.measures.forEach((m, mi) => {
    let mt = 0;
    m.beats.forEach((b, bi) => { out.push({ mi, bi, beat: b, onset: t + mt, mOnset: mt, ticks: beatTicks(b) }); mt += beatTicks(b); });
    t += Math.max(mt, measureCapacity(measureTs(song, mi)));
  });
  return out;
}

// 같은 줄에서 바로 다음/이전 음 찾기
function nextOnString(song, mi, bi, s) {
  for (let i = mi; i < song.measures.length; i++) {
    const bs = song.measures[i].beats;
    for (let j = (i === mi ? bi + 1 : 0); j < bs.length; j++) { const n = noteAt(bs[j], s); if (n) return { mi: i, bi: j, note: n, beat: bs[j] }; }
  }
  return null;
}
function prevOnString(song, mi, bi, s) {
  for (let i = mi; i >= 0; i--) {
    const bs = song.measures[i].beats;
    for (let j = (i === mi ? bi - 1 : bs.length - 1); j >= 0; j--) { const n = noteAt(bs[j], s); if (n) return { mi: i, bi: j, note: n, beat: bs[j] }; }
  }
  return null;
}

// 이 음이 앞 음에서 레가토(해머/풀/슬라이드/붙임줄)로 이어져 오는지
function isLegatoTarget(song, mi, bi, n) {
  if (n.tie) return true;
  const p = prevOnString(song, mi, bi, n.s);
  return !!(p && (p.note.hp || p.note.slide === 'to'));
}

// ===== 리듬 자동 추천 (한 마디) =====
// 1) 같은 음 개수의 다른 마디가 꽉 차 있으면 그 리듬을 그대로 복사 (리프 반복에 강함)
// 2) 없으면 마디 길이에 맞게 균등 분배
// ===== 리듬(음표 길이) 추천 =====
// 길이(틱) → 음표 표기
const TICK_TO_DUR = { 1920: [1, 0, 0], 1440: [2, 1, 0], 960: [2, 0, 0], 720: [4, 1, 0], 480: [4, 0, 0], 360: [8, 1, 0], 240: [8, 0, 0], 180: [16, 1, 0], 120: [16, 0, 0], 60: [32, 0, 0], 320: [4, 0, 1], 160: [8, 0, 1], 80: [16, 0, 1] };
const RHY_VALUES = [1920, 1440, 960, 720, 480, 360, 240, 180, 120];
function setBeatTicks(b, t) { const v = TICK_TO_DUR[t]; if (!v) return false; b.dur = v[0]; b.dot = !!v[1]; b.trip = !!v[2]; return true; }
function rhythmSig(m) { return m.beats.map(b => b.grace ? 'g' : beatTicks(b) + (isRest(b) ? 'r' : '')).join(','); }

// 박의 위치(정박/엇박)를 보고 "음악적으로 자연스러운" 길이 조합을 점수로 찾음.
// fixed: 고정할 박 (직접 길이를 정한 박, 꾸밈음)
function rhythmFits(song, mi, opts) {
  opts = opts || {};
  const m = song.measures[mi], ts = measureTs(song, mi), cap = measureCapacity(ts);
  const unit = 1920 / ts[1];
  const beats = m.beats;
  const idx = beats.map((b, i) => i).filter(i => !beats[i].grace);
  if (!idx.length) return [];
  const fixed = i => opts.keepManual !== false && beats[i].dm;
  const half = cap % (unit * 2) === 0 && cap >= unit * 4 ? cap / 2 : 0;
  function cost(t, L, prev, i, isLast) {
    let c = 0;
    const g = Math.min(L === 720 ? 240 : L === 1440 ? 480 : L === 360 ? 120 : L === 180 ? 60 : L, unit);
    if (t % g) c += 2.2;                                  // 박 중간에서 긴 음이 시작 (싱코페이션)
    if (t % unit && Math.floor(t / unit) !== Math.floor((t + L - 1) / unit) && L > 120) c += 0.8; // 박을 걸쳐서 이어짐
    if (half && t < half && t + L > half && t % unit) c += 1;
    if (L === 720 || L === 360 || L === 1440 || L === 180) c += 0.9; // 점음표는 덜 흔함
    if (L <= 120) c += 0.35; if (L === 1920) c += 0.4;
    if (prev && prev !== L) c += 0.6;
    if (beats[i] && isRest(beats[i]) && L > unit) c += 0.3;
    if (isLast && prev && L < prev) c += 0.4;               // 마디 끝은 길게 끝나는 경우가 많음
    return c;
  }
  // DP: (i, t, prev) → 상위 K개
  const K = 4; let layer = new Map(); layer.set('0|0', [{ c: 0, seq: [], t: 0, prev: 0 }]);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], isLast = k === idx.length - 1; const next = new Map();
    const vals = fixed(i) ? [beatTicks(beats[i])] : (opts.values || RHY_VALUES);
    layer.forEach(list => list.forEach(st => {
      vals.forEach(L => {
        const t = st.t + L; if (t > cap) return;
        if (isLast && t !== cap) return;
        if (!isLast && cap - t < (idx.length - k - 1) * 60) return;
        const c = st.c + (fixed(i) ? 0 : cost(st.t, L, st.prev, i, isLast));
        const key = t + '|' + L; const arr = next.get(key) || [];
        arr.push({ c, seq: st.seq.concat(L), t, prev: L }); arr.sort((a, b) => a.c - b.c); if (arr.length > K) arr.length = K;
        next.set(key, arr);
      });
    }));
    layer = next; if (!layer.size) return [];
  }
  const out = []; layer.forEach(list => list.forEach(st => {
    const distinct = new Set(st.seq).size; out.push({ c: st.c + (distinct - 1) * 0.8, seq: st.seq });
  }));
  out.sort((a, b) => a.c - b.c);
  return out.map(o => { const r = beats.map(b => b.grace ? 0 : null); idx.forEach((i, k) => r[i] = o.seq[k]); return { ticks: r, cost: o.c }; });
}

// 리듬 후보 목록: [{label, ticks:[...]}]
function rhythmCandidates(song, mi) {
  const m = song.measures[mi]; if (!m.beats.length) return [];
  const cap = measureCapacity(measureTs(song, mi));
  const out = []; const seen = new Set();
  const add = (label, ticks) => {
    if (!ticks) return; const key = ticks.join(','); if (seen.has(key)) return;
    if (ticks.reduce((a, b) => a + b, 0) !== cap) return; seen.add(key); out.push({ label, ticks });
  };
  // 1) 같은 음 개수의 박자가 맞는 다른 마디 (프렛까지 같으면 가장 먼저)
  const fr = x => x.beats.map(b => b.notes.map(n => n.s + ':' + n.f).sort().join('+')).join('|');
  const sims = [];
  song.measures.forEach((o, mj) => {
    if (mj === mi || o.beats.length !== m.beats.length) return;
    if (measureCapacity(measureTs(song, mj)) !== cap || measureFill(o) !== cap) return;
    if (o.beats.some((b, i) => !!b.grace !== !!m.beats[i].grace)) return;
    sims.push({ mj, same: fr(o) === fr(m), d: Math.abs(mj - mi) });
  });
  sims.sort((a, b) => (b.same - a.same) || a.d - b.d);
  sims.slice(0, 2).forEach(s => add(`${s.mj + 1}번 마디와 같은 리듬${s.same ? ' (같은 음)' : ''}`, song.measures[s.mj].beats.map(beatTicks)));
  // 2) 자연스러운 조합 (직접 정한 길이는 유지)
  const fits = rhythmFits(song, mi);
  const names = ['가장 자연스러운 리듬', '다른 후보', '다른 후보', '다른 후보'];
  fits.slice(0, 6).forEach((f, k) => add(names[Math.min(k, 3)], f.ticks));
  if (m.beats.some(b => b.dm)) rhythmFits(song, mi, { keepManual: false }).slice(0, 2).forEach(f => add('직접 정한 길이도 바꾸기', f.ticks));
  // 3) 셋잇단 (음 개수가 맞을 때)
  const real = m.beats.filter(b => !b.grace).length;
  [[160, '셋잇단 8분음표로 고르게'], [80, '셋잇단 16분음표로 고르게'], [320, '셋잇단 4분음표로 고르게']].forEach(([t, l]) => {
    if (real * t === cap) add(l, m.beats.map(b => b.grace ? 0 : t));
  });
  return out.slice(0, 6);
}
// 마디 문제: 'over' 넘침, 'under' 모자람, 'check' PDF 확인 필요, null 정상
function measureProblem(song, mi) {
  const m = song.measures[mi]; if (!m || !m.beats.length) return null;
  const cap = measureCapacity(measureTs(song, mi)), fill = measureFill(m);
  if (fill > cap) return 'over';
  if (fill < cap && !m.okUnder && mi < song.measures.length - 1) return 'under';
  if (m.check) return 'check';
  return null;
}
function splitRestTicks(t) { const out = []; for (const v of [1920, 960, 480, 240, 120, 60]) while (t >= v) { out.push(v); t -= v; } return out; }
function applyTicks(m, ticks) { m.beats.forEach((b, i) => { if (!b.grace && ticks[i]) setBeatTicks(b, ticks[i]); }); }

function suggestRhythm(song, mi, opts) {
  const m = song.measures[mi]; if (!m.beats.length) return false;
  const c = rhythmCandidates(song, mi);
  let pick = c[0];
  if (opts && opts.noCopy) pick = c.find(x => !/같은 리듬/.test(x.label)) || c[0];
  if (!pick) return false;
  applyTicks(m, pick.ticks);
  return /같은 리듬/.test(pick.label) ? 'copy' : 'fit';
}

// ===== 피킹 자동 추천 (교대 피킹: 박의 위치 기준) =====
// 기타 교본의 기본 원칙: 손목은 리듬에 맞춰 계속 위/아래로 움직이고,
// 정박(앞)은 다운(⊓), 엇박(뒤)은 업(V). 해머/풀/슬라이드/붙임줄로 이어지는 음은 피킹하지 않음.
function gcd(a, b) { a = Math.round(a); b = Math.round(b); while (b) { [a, b] = [b, a % b]; } return a; }
function suggestPicking(song) {
  song.measures.forEach((m, mi) => {
    let g = 240, t = 0;
    m.beats.forEach(b => { if (!isRest(b)) g = gcd(g, t); t += beatTicks(b); });
    if (g < 60) g = 60;
    t = 0;
    m.beats.forEach((b, bi) => {
      b.pa = null;
      if (!isRest(b)) {
        const allLegato = b.notes.every(n => isLegatoTarget(song, mi, bi, n));
        if (!allLegato) b.pa = (Math.round(t / g) % 2 === 0) ? 'd' : 'u';
      }
      t += beatTicks(b);
    });
  });
}

function cloneSong(s) { return JSON.parse(JSON.stringify(s)); }

function demoSong() {
  const s = newSong();
  s.title = '예제: 간단한 블루스 릭'; s.artist = '연습용'; s.bpm = 90;
  s.view.fingers = true; s.view.picks = true;
  const mk = (list) => { const m = newMeasure(); list.forEach(([dur, notes, extra]) => { const b = newBeat(dur); notes.forEach(([st, f, o]) => b.notes.push(Object.assign(newNote(st, f), o || {}))); Object.assign(b, extra || {}); m.beats.push(b); }); return m; };
  s.measures = [
    mk([[8, [[1, 5]]], [8, [[1, 8]]], [8, [[0, 5]]], [8, [[0, 8]]], [8, [[1, 8, { bend: { a: 1 } }]]], [8, [[1, 5]]], [4, [[2, 7, { vib: true }]]]]),
    mk([[8, [[2, 5, { hp: true }]]], [8, [[2, 7]]], [8, [[3, 5]]], [8, [[3, 7, { slide: 'to' }]]], [8, [[3, 9]]], [8, [[3, 7]]], [4, [[4, 7, { vib: true }]]]]),
    mk([[4, [[5, 3], [4, 5], [3, 5]]], [4, [[5, 3], [4, 5], [3, 5]]], [8, [[5, 5, { pm: true }], [4, 7, { pm: true }]]], [8, [[5, 5, { pm: true }], [4, 7, { pm: true }]]], [4, [[4, 0], [3, 2], [2, 2], [1, 1], [0, 0]]]]),
  ];
  s.measures.push(newMeasure());
  s.measures[0].section = 'Intro';
  return s;
}
