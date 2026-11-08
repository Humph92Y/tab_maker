// ===== 운지(왼손 손가락) 자동 추천 =====
// 참고한 방법:
//  - Sayegh (1989) "Fingering for String Instruments with the Optimum Path Paradigm":
//    운지를 '최소 비용 경로' 문제로 보고 동적계획법(Viterbi)으로 전체 곡에서 가장 편한 길을 찾음
//  - Heijink & Meulenbroek (2002): 손 벌림(스트레치)과 포지션 이동이 연주 난이도를 가장 크게 높임
//  - Radicioni et al. (2004), Tuohy & Potter (2005), Barbancho et al. (2012): 포지션 유지·손가락 독립성 비용
//  - 기타 교본의 기본 원칙: '한 프렛에 한 손가락'(1 finger per fret), 벤딩은 약지(다른 손가락이 받쳐줌),
//    슬라이드는 같은 손가락 유지, 해머온은 아래 손가락을 누른 채 위 손가락으로, 표준 오픈 코드 운지
// 손가락 번호: 1 검지, 2 중지, 3 약지, 4 새끼, 'T' 엄지 (0프렛 개방현은 손가락 없음)

// 표준 코드 운지표 (6번줄 → 1번줄 순서, x = 안 침)
const CHORD_SHAPES = [
  ['C', 'x32010', 'x32010'], ['C7', 'x32310', 'x32410'], ['Cadd9', 'x32033', 'x21034'],
  ['D', 'xx0232', 'xx0132'], ['D7', 'xx0212', 'xx0213'], ['Dm', 'xx0231', 'xx0231'], ['Dsus4', 'xx0233', 'xx0134'], ['Dsus2', 'xx0230', 'xx0130'],
  ['E', '022100', '023100'], ['E7', '020100', '020100'], ['Em', '022000', '023000'], ['Em7', '020000', '020000'],
  ['F', '133211', '134211'], ['Fsmall', 'xx3211', 'xx3211'], ['Fmaj7', 'xx3210', 'xx3210'],
  ['G', '320003', '210003'], ['G2', '320033', '210034'], ['G7', '320001', '320001'],
  ['A', 'x02220', 'x01230'], ['A7', 'x02020', 'x02030'], ['Am', 'x02210', 'x02310'], ['Am7', 'x02010', 'x02010'], ['Asus2', 'x02200', 'x01200'], ['Asus4', 'x02230', 'x01230'],
  ['B7', 'x21202', 'x21304'], ['Bm', 'x24432', 'x13421'],
].map(([name, frets, fingers]) => {
  const map = {}; // s(0=1번줄) -> {f, finger}
  for (let i = 0; i < 6; i++) {
    const fr = frets[i], fg = fingers[i]; const s = 5 - i;
    if (fr !== 'x') map[s] = { f: +fr, finger: +fg };
  }
  return { name, map };
});

const Fingering = (() => {
  const INF = 1e9;

  function staticCost(notes, fing) {
    let c = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], f = fing[i];
      if (f === 'T') { c += 1; continue; }
      if (f === 4) c += 0.6;
      if (n.bend) c += [0, 2.5, 0.8, 0, 5][f];
      if (n.vib && f === 4) c += 1;
    }
    // 코드(2음 이상)는 검지를 기준으로 잡는 것이 기본 (파워코드 1-3, 바레코드 등)
    if (notes.length >= 2 && !fing.includes(1) && !fing.includes('T')) c += 2.5;
    for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
      const fi = fing[i], fj = fing[j]; if (fi === 'T' || fj === 'T') continue;
      const ri = notes[i].f, rj = notes[j].f;
      if (fi === fj) {
        if (ri !== rj) return INF;
        c += fi === 1 ? 0.5 : fi === 3 ? 1.5 : 3; // 바레
        continue;
      }
      const [lo, hi] = fi < fj ? [i, j] : [j, i];
      const d = notes[hi].f - notes[lo].f, k = fing[hi] - fing[lo];
      if (d < 0) return INF;
      if (d > k + 2) return INF;
      if (d > k) c += (d - k) * (notes[lo].f < 5 ? 2 : 1.5);
      if (d < k) c += (k - d) * 0.4;
      if (d === 0 && notes[hi].s > notes[lo].s) c += 0.3;
    }
    return c;
  }

  function handPos(notes, fing) {
    let sum = 0, cnt = 0;
    notes.forEach((n, i) => { if (fing[i] !== 'T') { sum += n.f - fing[i] + 1; cnt++; } });
    return cnt ? sum / cnt : (notes[0] ? notes[0].f : 1);
  }

  function genCands(item) {
    const notes = item.notes;
    const choices = notes.map(n => n.fm ? [n.fm] : [1, 2, 3, 4]);
    const res = []; const cur = [];
    (function rec(i) {
      if (i === notes.length) {
        let c = staticCost(notes, cur);
        if (c >= INF) return;
        if (item.chords) for (const ch of item.chords) {
          if (notes.every((n, k) => ch.map[n.s] && ch.map[n.s].finger === cur[k])) { c -= ch.exact ? 3 : 1.5; break; }
        }
        res.push({ fing: cur.slice(), cost: c, pos: handPos(notes, cur) });
        return;
      }
      for (const f of choices[i]) { cur.push(f); rec(i + 1); cur.pop(); }
    })(0);
    if (!res.length) { // 불가능한 조합이면 '한 프렛에 한 손가락' 기본값
      const minF = Math.min(...notes.map(n => n.f));
      const fing = notes.map(n => n.fm || Math.max(1, Math.min(4, n.f - minF + 1)));
      res.push({ fing, cost: 20, pos: handPos(notes, fing) });
    }
    res.sort((a, b) => a.cost - b.cost);
    return res.slice(0, 12);
  }

  function transCost(a, ca, b, cb) {
    let c = 0;
    const shift = Math.abs(ca.pos - cb.pos);
    let slideSame = false;
    const relaxed = (b.onset - a.onset) >= 960 || b.gapOpen;
    const quick = (b.onset - a.onset) <= 120;
    b.notes.forEach((y, yi) => {
      const fy = cb.fing[yi];
      a.notes.forEach((x, xi) => {
        const fx = ca.fing[xi];
        const linked = x.s === y.s && x._next === y.id;
        if (linked && x.slide === 'to') { if (fx === fy) slideSame = true; else c += 4; }
        if (linked && x.hp) {
          const ok = fy !== 'T' && fx !== 'T' && (y.f > x.f ? fy > fx : fy < fx);
          if (!ok) c += 8;
        }
        if (fx === fy && fx !== 'T') {
          if (x.s === y.s && x.f === y.f) return;
          if (linked && x.slide === 'to') return;
          if (shift >= 1) return; // 손 전체가 이동하면 같은 손가락이 따라가는 게 자연스러움
          if (x.f === y.f) c += 0.8; else c += 2.5 * (quick ? 1.5 : 1);
        } else if (x.s === y.s && x.f === y.f) c += 1;
      });
    });
    let sc = slideSame ? shift * 0.2 : shift <= 1 ? shift * 0.8 : shift * 1.0 + 1.2;
    if (relaxed) sc *= 0.5;
    return c + sc;
  }

  // 곡 전체 계산 → 각 음에 fa(자동 손가락) 저장
  function suggest(song) {
    const flat = flatBeats(song);
    // 다음 음 연결 정보
    flat.forEach(fb => fb.beat.notes.forEach(n => { const nx = nextOnString(song, fb.mi, fb.bi, n.s); n._next = nx ? nx.note.id : null; n.fa = null; }));
    // 마디별 코드 모양 힌트 (아르페지오도 코드 운지로)
    const measureUnion = song.measures.map(m => {
      const u = {}; let ok = true;
      m.beats.forEach(b => b.notes.forEach(n => { if (n.dead) return; if (u[n.s] !== undefined && u[n.s] !== n.f) ok = false; u[n.s] = n.f; }));
      return ok ? u : null;
    });
    const seq = [];
    let gapOpen = false;
    flat.forEach(fb => {
      const fretted = fb.beat.notes.filter(n => n.f > 0 && !n.dead);
      if (!fretted.length) { gapOpen = true; return; }
      const item = { fb, notes: fretted, onset: fb.onset, gapOpen, chords: [] };
      gapOpen = false;
      const u = measureUnion[fb.mi];
      const beatAll = fb.beat.notes.filter(n => !n.dead);
      for (const ch of CHORD_SHAPES) {
        const fits = beatAll.every(n => ch.map[n.s] && ch.map[n.s].f === n.f);
        if (!fits) continue;
        const unionFits = u && Object.keys(u).every(s => ch.map[s] && ch.map[s].f === u[s]);
        const exact = beatAll.length === Object.keys(ch.map).length;
        if (exact || (unionFits && fretted.length >= 1 && Object.keys(u).length >= 3)) item.chords.push({ map: ch.map, exact });
      }
      seq.push(item);
    });
    if (!seq.length) return;
    seq.forEach(it => it.cands = genCands(it));
    const dp = [seq[0].cands.map(c => ({ cost: c.cost, prev: -1 }))];
    for (let i = 1; i < seq.length; i++) {
      const row = [];
      seq[i].cands.forEach(cb => {
        let best = INF, arg = 0;
        seq[i - 1].cands.forEach((ca, j) => {
          const v = dp[i - 1][j].cost + transCost(seq[i - 1], ca, seq[i], cb);
          if (v < best) { best = v; arg = j; }
        });
        row.push({ cost: best + cb.cost, prev: arg });
      });
      dp.push(row);
    }
    let k = 0, last = dp[dp.length - 1];
    last.forEach((v, i) => { if (v.cost < last[k].cost) k = i; });
    for (let i = seq.length - 1; i >= 0; i--) {
      const cand = seq[i].cands[k];
      seq[i].notes.forEach((n, ni) => { n.fa = cand.fing[ni]; });
      k = dp[i][k].prev;
    }
    flat.forEach(fb => fb.beat.notes.forEach(n => { delete n._next; }));
  }

  return { suggest };
})();
