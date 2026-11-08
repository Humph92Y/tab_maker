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
function suggestRhythm(song, mi) {
  const m = song.measures[mi]; const n = m.beats.length; if (!n) return false;
  const cap = measureCapacity(measureTs(song, mi));
  for (let d = 1; d < song.measures.length; d++) {
    for (const mj of [mi - d, mi + d]) {
      const o = song.measures[mj];
      if (!o || o.beats.length !== n) continue;
      if (measureCapacity(measureTs(song, mj)) !== cap || measureFill(o) !== cap) continue;
      m.beats.forEach((b, i) => { b.dur = o.beats[i].dur; b.dot = o.beats[i].dot; b.trip = o.beats[i].trip; });
      return 'copy';
    }
  }
  let base = 32;
  for (const dv of DUR_LIST) { if (TICKS[dv] * n <= cap) { base = dv; break; } }
  m.beats.forEach(b => { b.dur = base; b.dot = false; b.trip = false; });
  let rem = cap - n * TICKS[base];
  let guard = 0;
  while (rem > 0 && guard++ < 50) {
    let changed = false;
    for (let i = n - 1; i >= 0 && rem > 0; i--) {
      const b = m.beats[i]; const t = TICKS[b.dur];
      if (!b.dot && rem >= t && b.dur > 1) { b.dur /= 2; rem -= t; changed = true; }
      else if (!b.dot && rem >= t / 2 && b.dur < 32) { b.dot = true; rem -= t / 2; changed = true; }
    }
    if (!changed) break;
  }
  return 'fit';
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
