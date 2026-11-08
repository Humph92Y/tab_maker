// ===== 악보 그리기 (SVG) =====
const R = { numY: 14, pickY: 31, textY: 45, line0: 76, gap: 15 };
R.lineY = s => R.line0 + s * R.gap;
R.lastLine = R.line0 + 5 * R.gap;
R.stemTop = R.lastLine + 11;
R.stemBot = R.stemTop + 28;
R.height = R.stemBot + 24;
R.header = 46;

const FINGER_COLORS = { 1: '#1d6fe0', 2: '#14a04a', 3: '#e8730c', 4: '#9b30e8', T: '#6b7280' };
const FINGER_NAMES = { 1: '검지', 2: '중지', 3: '약지', 4: '새끼', T: '엄지' };

function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function beatWidth(b) { if (b.grace) return 24; const base = { 1: 66, 2: 54, 4: 44, 8: 36, 16: 31, 32: 28 }[b.dur]; const wide = b.notes.some(n => n.f >= 10 || n.harm || n.ghost || n.tie) ? 6 : 0; return (base + wide) * (b.dot === 2 ? 1.2 : b.dot ? 1.12 : 1); }
function bendLabel(a) { return a === 0.5 ? '½' : a === 1 ? 'full' : a === 1.5 ? '1½' : a === 2 ? '2' : a; }
function noteLabel(n) { if (n.dead) return 'x'; if (n.harm) return '<' + n.f + '>'; if (n.ghost || n.tie) return '(' + n.f + ')'; return String(n.f); }
function noteFinger(n, view) { if (n.fm) return n.fm; if (view.fingers && n.fa && n.f > 0) return n.fa; return null; }

function renderScore(el, song, st) {
  const print = !!st.print;
  const maxW = Math.max(260, (st.width || el.clientWidth) - 4);
  const tuning = TUNINGS[song.tuning].midi;
  const view = song.view;
  // 1) 마디별 자연 폭 계산
  const ms = song.measures.map((m, mi) => {
    const ts = measureTs(song, mi), prevTs = mi > 0 ? measureTs(song, mi - 1) : null;
    const showTs = mi === 0 || prevTs[0] !== ts[0] || prevTs[1] !== ts[1];
    const padL = 14 + (showTs ? 24 : 0);
    const bw = m.beats.map(beatWidth);
    const ghost = print ? 0 : 28;
    const w = Math.max(m.beats.length ? 0 : 130, padL + bw.reduce((a, b) => a + b, 0) + ghost + 8);
    return { m, mi, ts, showTs, padL, bw, ghost, w };
  });
  // 2) 줄바꿈
  const systems = []; let cur = [], sum = 0;
  const per = +view.perLine || 0;
  ms.forEach(mm => {
    const brk = mm.m.brk, full = per && cur.length >= per;
    if (cur.length && (brk || full || sum + mm.w > maxW - R.header)) { cur.forced = true; systems.push(cur); cur = []; sum = 0; }
    cur.push(mm); sum += mm.w;
  });
  if (cur.length) systems.push(cur);
  // 3) 위치 확정
  const notePos = {}, beatPos = {};
  systems.forEach((sys, si) => {
    const total = sys.reduce((a, b) => a + b.w, 0);
    const avail = maxW - R.header;
    const last = si === systems.length - 1;
    let scale;
    if (!last || total > avail) scale = avail / total;
    else if (per) scale = Math.max(1, avail * Math.min(1, sys.length / per) / total);
    else scale = Math.min(1.25, Math.max(1, avail / total * 0.8));
    let x = R.header;
    sys.forEach(mm => {
      mm.x = x; mm.sw = mm.w * scale;
      let bx = x + mm.padL * scale;
      mm.beatX = [];
      mm.m.beats.forEach((b, bi) => {
        const w = mm.bw[bi] * scale;
        const cx = bx + w * 0.42;
        mm.beatX.push({ x0: bx, w, cx });
        beatPos[b.id] = { si, x0: bx, w, cx, mi: mm.mi, bi };
        b.notes.forEach(n => notePos[n.id] = { si, x: cx, y: R.lineY(n.s), mi: mm.mi, bi });
        bx += w;
      });
      mm.ghostX = bx; mm.ghostW = Math.max(mm.ghost * scale, x + mm.sw - bx - 6 * scale);
      x += mm.sw;
    });
    sys.endX = x;
  });

  // 4) 그리기
  let html = '';
  const selNote = st.sel ? noteAt(song.measures[st.sel.mi]?.beats[st.sel.bi], st.sel.s) : null;
  systems.forEach((sys, si) => {
    let o = '';
    const W = maxW;
    // 줄 6개
    for (let s = 0; s < 6; s++) o += `<line x1="${R.header - 6}" x2="${sys.endX}" y1="${R.lineY(s)}" y2="${R.lineY(s)}" class="str"/>`;
    // 왼쪽 TAB 표시와 줄 이름
    for (let s = 0; s < 6; s++) o += `<text x="10" y="${R.lineY(s) + 3.5}" class="sname">${midiName(tuning[s], false)}</text>`;
    o += `<text x="${R.header - 18}" y="${R.lineY(1) + 5}" class="tabclef">T</text><text x="${R.header - 18}" y="${R.lineY(2) + 10}" class="tabclef">A</text><text x="${R.header - 18}" y="${R.lineY(4) + 0}" class="tabclef">B</text>`;
    o += `<line x1="${R.header - 6}" x2="${R.header - 6}" y1="${R.line0}" y2="${R.lastLine}" class="bar"/>`;
    // 재생 위치 표시
    o += `<rect class="playhead" x="0" y="${R.line0 - 10}" width="10" height="${R.stemBot - R.line0 + 14}" rx="4" style="display:none"/>`;

    sys.forEach(mm => {
      const m = mm.m, mi = mm.mi;
      const endX = mm.x + mm.sw;
      // 마디 번호 / 구간 이름 / 채움 상태
      const fill = measureFill(m), cap = measureCapacity(mm.ts);
      let cls = 'mnum';
      let tip = '';
      const prob = print ? null : measureProblem(song, mi);
      if (prob === 'over') { cls += ' over'; tip = '박자가 넘쳐요 · 눌러서 해결 방법 보기'; }
      else if (prob === 'under') { cls += ' under'; tip = '박자가 모자라요 · 눌러서 해결 방법 보기'; }
      else if (prob === 'check') { cls += ' under'; tip = '자동 인식한 마디예요. 원본과 한 번 확인해 주세요'; }
      o += `<text x="${mm.x + 3}" y="${R.numY}" class="${cls}" data-measure="${mi}">${mi + 1}${tip ? ' ⚠' : ''}<title>${tip || '마디 설정'}</title></text>`;
      if (m.section) o += `<text x="${mm.x + 26}" y="${R.numY}" class="section">${esc(m.section)}</text>`;
      if (!print) o += `<rect class="hit" x="${mm.x}" y="0" width="${Math.max(24, mm.sw * 0.4)}" height="20" data-measure="${mi}"/>`;
      if (mm.showTs) {
        const tx = mm.x + 15;
        o += `<text x="${tx}" y="${R.lineY(2) + 2}" class="tsig">${mm.ts[0]}</text><text x="${tx}" y="${R.lineY(5) - 1}" class="tsig">${mm.ts[1]}</text>`;
      }
      // 마디 줄
      const isLast = mi === song.measures.length - 1;
      if (isLast) o += `<line x1="${endX - 5}" x2="${endX - 5}" y1="${R.line0}" y2="${R.lastLine}" class="bar"/><line x1="${endX - 1.5}" x2="${endX - 1.5}" y1="${R.line0}" y2="${R.lastLine}" class="bar thick"/>`;
      else o += `<line x1="${endX}" x2="${endX}" y1="${R.line0}" y2="${R.lastLine}" class="bar"/>`;

      // 커서
      if (!print && st.sel && st.sel.mi === mi) {
        const bi = st.sel.bi;
        const col = bi < m.beats.length ? mm.beatX[bi] : { x0: mm.ghostX, w: mm.ghostW, cx: mm.ghostX + mm.ghostW * 0.42 };
        o += `<rect class="colsel" x="${col.x0 + 1}" y="${R.line0 - 8}" width="${col.w - 2}" height="${R.lastLine - R.line0 + 16}" rx="4"/>`;
        o += `<rect class="cursor" x="${col.cx - 12}" y="${R.lineY(st.sel.s) - 8}" width="24" height="16" rx="3"/>`;
      }
      if (!print) o += `<text x="${mm.ghostX + mm.ghostW * 0.42}" y="${R.lineY(5) + 24}" class="ghostplus">+</text>`;

      // 박마다 그리기
      let onset = 0;
      const rInfo = [];
      m.beats.forEach((b, bi) => {
        const { cx, x0, w } = mm.beatX[bi];
        const rest = isRest(b);
        if (!b.grace) rInfo.push({ b, cx, onset, rest });
        onset += beatTicks(b);
        // 피킹 표기
        const pk = b.pick || (view.picks ? b.pa : null);
        if (pk && !rest) o += pickGlyph(cx, R.pickY, pk, !!b.pick);
        // 팜뮤트 / 렛링 표시 (구간 시작에만 글자)
        const prevB = bi > 0 ? m.beats[bi - 1] : null;
        const pm = b.notes.some(n => n.pm), lr = b.notes.some(n => n.lr);
        if (pm) o += (prevB && prevB.notes.some(n => n.pm)) ? `<line x1="${x0 - 4}" x2="${cx + 6}" y1="${R.textY - 3}" y2="${R.textY - 3}" class="dash"/>` : `<text x="${cx - 8}" y="${R.textY}" class="tech">P.M.</text>`;
        if (lr) o += (prevB && prevB.notes.some(n => n.lr)) ? `<line x1="${x0 - 4}" x2="${cx + 6}" y1="${R.textY - 12}" y2="${R.textY - 12}" class="dash"/>` : `<text x="${cx - 8}" y="${R.textY - 9}" class="tech">let ring</text>`;
        b.notes.forEach(n => {
          const y = R.lineY(n.s);
          const lab = noteLabel(n);
          const tw = lab.length * (b.grace ? 5.6 : 7.4) + 4;
          const fg = noteFinger(n, view);
          const color = fg ? FINGER_COLORS[fg] : '#111';
          const isSel = selNote && selNote.id === n.id;
          const isFrom = st.mode && st.mode.from && st.mode.from.id === n.id;
          o += `<rect x="${cx - tw / 2}" y="${y - 7}" width="${tw}" height="14" class="nbg${isFrom ? ' from' : ''}"/>`;
          if (fg && view.fingers !== undefined) o += `<rect x="${cx - tw / 2 - 1}" y="${y - 8}" width="${tw + 2}" height="16" rx="4" fill="${color}" fill-opacity="0.13"/>`;
          o += `<text x="${cx}" y="${y + 4.5}" class="fret${isSel ? ' sel' : ''}${b.grace ? ' grace' : ''}" fill="${color}">${esc(lab)}</text>`;
          if (view.fingerNums && fg) o += `<text x="${cx - tw / 2 - 2}" y="${y - 3}" class="fnum" fill="${color}">${fg}</text>`;
          if (view.names && !n.dead) o += `<text x="${cx + tw / 2 + 1}" y="${y + 3}" class="nname">${midiName(tuning[n.s] + n.f, false)}</text>`;
          if (n.acc) o += `<text x="${cx}" y="${R.line0 - 13}" class="tech mid">&gt;</text>`;
          if (n.vib) o += vibrato(cx + 4, R.line0 - 6, Math.max(16, w * 0.8));
          if (n.bend) o += bendGlyph(cx + tw / 2 - 1, y, n.bend);
          if (n.slide === 'in') o += `<line x1="${cx - tw / 2 - 12}" y1="${y + 5}" x2="${cx - tw / 2 - 2}" y2="${y - 1}" class="slide"/>`;
          if (n.slide === 'out') o += `<line x1="${cx + tw / 2 + 2}" y1="${y - 1}" x2="${cx + tw / 2 + 12}" y2="${y + 5}" class="slide"/>`;
        });
        // 클릭 영역
        if (!print) {
          for (let s = 0; s < 6; s++) o += `<rect class="hit" x="${x0}" y="${R.lineY(s) - R.gap / 2}" width="${w}" height="${R.gap}" data-col="${mi},${bi},${s}"/>`;
          o += `<rect class="hit" x="${x0}" y="${R.stemTop - 4}" width="${w}" height="${R.height - R.stemTop}" data-rhythm="${mi},${bi}"><title>음표 길이 바꾸기</title></rect>`;
          o += `<rect class="hit" x="${x0}" y="${R.pickY - 11}" width="${w}" height="16" data-pick="${mi},${bi}"><title>피킹 ⊓/V 바꾸기</title></rect>`;
        }
      });
      if (!print) m.beats.forEach((b, bi) => { const bx0 = mm.beatX[bi].x0; o += `<rect class="ins" x="${bx0 - 4}" y="${R.line0 - 7}" width="8" height="${R.lastLine - R.line0 + 14}" data-ins="${mi},${bi}"><title>여기에 새 칸 끼워넣기</title></rect>`; });
      if (!print) for (let s = 0; s < 6; s++) o += `<rect class="hit ghost" x="${mm.ghostX}" y="${R.lineY(s) - R.gap / 2}" width="${mm.ghostW}" height="${R.gap}" data-col="${mi},${m.beats.length},${s}"><title>여기를 눌러 새 음 추가</title></rect>`;
      o += rhythm(rInfo, mm.ts);
      // 입력 중인 숫자
      if (!print && st.sel && st.sel.mi === mi && st.pending) {
        const bi = st.sel.bi;
        const cx = bi < m.beats.length ? mm.beatX[bi].cx : mm.ghostX + mm.ghostW * 0.42;
        o += `<rect x="${cx - 12}" y="${R.lineY(st.sel.s) - 8}" width="24" height="16" rx="3" class="pendbg"/><text x="${cx}" y="${R.lineY(st.sel.s) + 4.5}" class="fret pend">${st.pending}</text>`;
      }
    });
    // 연결선(슬라이드, 해머/풀, 붙임줄)
    sys.forEach(mm => mm.m.beats.forEach((b, bi) => b.notes.forEach(n => {
      const a = notePos[n.id];
      const nx = (n.slide === 'to' || n.hp) ? nextOnString(song, mm.mi, bi, n.s) : null;
      if (nx) {
        const bp = notePos[nx.note.id];
        const x2 = bp.si === si ? bp.x : sys.endX + 4;
        if (n.slide === 'to') {
          const up = nx.note.f > n.f;
          o += `<line x1="${a.x + 8}" y1="${a.y + (up ? 4 : -4)}" x2="${x2 - 8}" y2="${a.y + (up ? -4 : 4)}" class="slide"/>`;
        }
        if (n.hp) {
          const mx = (a.x + x2) / 2;
          o += `<path d="M${a.x + 4},${a.y - 8} Q${mx},${a.y - 17} ${x2 - 4},${a.y - 8}" class="arc"/>`;
          o += `<text x="${mx}" y="${a.y - 15}" class="tech mid small">${nx.note.f > n.f ? 'H' : 'P'}</text>`;
        }
      }
      if (n.tie) {
        const p = prevOnString(song, mm.mi, bi, n.s);
        if (p) {
          const pp = notePos[p.note.id];
          const x1 = pp.si === si ? pp.x : R.header - 4;
          o += `<path d="M${x1 + 4},${a.y + 7} Q${(x1 + a.x) / 2},${a.y + 15} ${a.x - 6},${a.y + 7}" class="arc"/>`;
        }
      }
    })));
    // 이전 줄에서 넘어오는 연결선
    html += `<svg class="system" data-si="${si}" width="${W}" height="${R.height}" viewBox="0 0 ${W} ${R.height}" xmlns="http://www.w3.org/2000/svg">${o}</svg>`;
  });
  el.innerHTML = html;
  const msys = {}; systems.forEach((sys, si) => sys.forEach(mm => { msys[mm.mi] = si; }));
  return { beatPos, notePos, systems: systems.length, msys };
}

function pickGlyph(x, y, p, manual) {
  const c = manual ? 'pick man' : 'pick auto';
  if (p === 'd') return `<path class="${c}" d="M${x - 5},${y + 4} V${y - 5} H${x + 5} V${y + 4}"/><rect class="${c} fill" x="${x - 5}" y="${y - 6}" width="10" height="3"/>`;
  return `<path class="${c}" d="M${x - 4.5},${y - 5} L${x},${y + 5} L${x + 4.5},${y - 5}"/>`;
}

function vibrato(x, y, len) {
  let d = `M${x},${y}`; const step = 4;
  for (let i = 0; i < len / step; i++) d += ` l${step / 2},${i % 2 ? 3 : -3} l${step / 2},${i % 2 ? -3 : 3}`;
  return `<path d="${d}" class="vib"/>`;
}

function bendGlyph(x, y, bend) {
  const top = R.line0 - 14;
  let o = `<path d="M${x},${y - 2} Q${x + 10},${y - 2} ${x + 10},${top + 6}" class="bend"/><path d="M${x + 6.5},${top + 7} L${x + 10},${top} L${x + 13.5},${top + 7} Z" class="arrow"/>`;
  o += `<text x="${x + 10}" y="${top - 3}" class="tech mid small">${bendLabel(bend.a)}</text>`;
  if (bend.r) o += `<path d="M${x + 12},${top + 2} Q${x + 20},${top + 2} ${x + 21},${y - 8}" class="bend dashed"/><path d="M${x + 17.5},${y - 14} L${x + 21},${y - 7} L${x + 24.5},${y - 14} Z" class="arrow"/>`;
  return o;
}

// 리듬(음표 길이) 표기: 줄 아래 기둥/꼬리/빔
function rhythm(info, ts) {
  let o = '';
  const groupT = (ts[1] === 8 && ts[0] % 3 === 0) ? 720 : 480;
  const T = R.stemTop, B = R.stemBot;
  const flagsOf = d => d >= 8 ? Math.log2(d) - 2 : 0;
  // 빔 그룹 찾기
  const groups = []; let g = [];
  info.forEach((it, i) => {
    const f = flagsOf(it.b.dur);
    const grp = Math.floor((it.onset + 0.001) / groupT);
    if (f > 0 && g.length && g[g.length - 1].grp === grp && g[g.length - 1].f > 0) { g.push({ ...it, f, grp }); }
    else { if (g.length) groups.push(g); g = [{ ...it, f, grp }]; }
  });
  if (g.length) groups.push(g);
  // 음이 하나도 없는 덩어리(쉼표만)는 따로따로 그림
  for (let i = groups.length - 1; i >= 0; i--) if (groups[i].length > 1 && !groups[i].some(x => !x.rest)) groups.splice(i, 1, ...groups[i].map(x => [x]));
  groups.forEach(gr => {
    // 같은 박 안의 쉼표도 빔으로 함께 묶음 (Guitar Pro 표기와 같게): 쉼표는 위에, 기둥은 쉼표 아래부터
    if (gr.length >= 2 && gr.every(x => x.f > 0) && gr.some(x => !x.rest)) {
      gr.forEach(x => { x.inBeam = true; if (x.rest) { o += restGlyph(x.cx, T + 10, x.b.dur); o += `<line x1="${x.cx}" x2="${x.cx}" y1="${T + 20}" y2="${B}" class="stem"/>`; } else o += `<line x1="${x.cx}" x2="${x.cx}" y1="${T}" y2="${B}" class="stem"/>`; });
      o += `<line x1="${gr[0].cx}" x2="${gr[gr.length - 1].cx}" y1="${B - 1.5}" y2="${B - 1.5}" class="beam"/>`;
      for (let L = 2; L <= 3; L++) {
        const y = B - 1.5 - (L - 1) * 5;
        gr.forEach((x, i) => {
          if (x.f < L) return;
          const nx = gr[i + 1];
          if (nx && nx.f >= L) o += `<line x1="${x.cx}" x2="${nx.cx}" y1="${y}" y2="${y}" class="beam"/>`;
          else if (!(gr[i - 1] && gr[i - 1].f >= L)) { const dir = nx ? 1 : -1; o += `<line x1="${x.cx}" x2="${x.cx + dir * 8}" y1="${y}" y2="${y}" class="beam"/>`; }
        });
      }
    } else gr.forEach(x => o += single(x));
    gr.forEach(x => { if (x.b.dot) { const dy = x.rest && !x.inBeam ? T + 14 : B - 6; o += `<circle cx="${x.cx + 5}" cy="${dy}" r="1.7" class="dot"/>`; if (x.b.dot === 2) o += `<circle cx="${x.cx + 10}" cy="${dy}" r="1.7" class="dot"/>`; } });
  });
  // 셋잇단
  let run = [];
  const flushTrip = () => { for (let i = 0; i < run.length; i += 3) { const ch = run.slice(i, i + 3); const mx = (ch[0].cx + ch[ch.length - 1].cx) / 2; o += `<text x="${mx}" y="${B + 13}" class="trip">3</text>`; if (ch.length > 1) o += `<path d="M${ch[0].cx},${B + 6} v3 H${mx - 5} M${mx + 5},${B + 9} H${ch[ch.length - 1].cx} v-3" class="tbr"/>`; } run = []; };
  info.forEach(it => { if (it.b.trip) run.push(it); else flushTrip(); });
  flushTrip();
  return o;

  function single(x) {
    const cx = x.cx, d = x.b.dur;
    if (x.rest) return restGlyph(cx, T + 14, d);
    if (d === 1) return '';
    if (d === 2) return `<line x1="${cx}" x2="${cx}" y1="${T + 14}" y2="${B}" class="stem"/>`;
    let s = `<line x1="${cx}" x2="${cx}" y1="${T}" y2="${B}" class="stem"/>`;
    for (let L = 0; L < flagsOf(d); L++) s += `<path d="M${cx},${B - L * 5} q5,-2 7,-8" class="flag"/>`;
    return s;
  }
}

function restGlyph(x, y, d) {
  if (d === 1) return `<rect x="${x - 5}" y="${y - 4}" width="10" height="4" class="rest"/>`;
  if (d === 2) return `<rect x="${x - 5}" y="${y}" width="10" height="4" class="rest"/>`;
  if (d === 4) return `<path d="M${x - 2},${y - 9} l5,5 l-4,4 l4,5 q-5,-2 -4,3" class="restl"/>`;
  const n = Math.log2(d) - 2; let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${x - 2 - i * 1.5}" cy="${y - 5 + i * 5}" r="2" class="rest"/><path d="M${x - 2 - i * 1.5},${y - 4 + i * 5} q3,1 5,-1" class="restl"/>`;
  s += `<path d="M${x + 3},${y - 5} L${x - 2 - (n - 1) * 1.5},${y + 6 + (n - 1) * 3}" class="restl"/>`;
  return s;
}
