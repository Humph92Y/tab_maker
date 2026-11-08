// ===== PDF 악보 자동 인식 =====
// Guitar Pro / MuseScore 등으로 만든 "벡터 PDF"를 읽어서 악보로 바꿈.
// 1) 글자(프렛 숫자, X, (13), sl., H, P, full, P.M., 템포)와 선(타브 줄, 마디줄, 기둥, 빔)을 꺼냄
// 2) 6줄 = 타브, 5줄 = 오선보로 구분 → 숫자를 줄/마디/박에 배치
// 3) 오선보의 기둥·빔·꼬리·점·쉼표로 음표 길이를 읽고, "한 마디 박자 합" 규칙으로 보정
// pdfjsLib 는 pdf.js 라이브러리 (브라우저: window.pdfjsLib, 테스트: require)

const PdfImport = (() => {
  const SMUFL_REST = { 0xE4E3: 1, 0xE4E4: 2, 0xE4E5: 4, 0xE4E6: 8, 0xE4E7: 16, 0xE4E8: 32 };
  const SMUFL_FLAG = { 0xE240: 1, 0xE241: 1, 0xE242: 2, 0xE243: 2, 0xE244: 3, 0xE245: 3, 0xE246: 4, 0xE247: 4 };
  const SMUFL_HEAD = { 0xE0A2: 1, 0xE0A3: 2, 0xE0A4: 4, 0xE0A9: 4, 0xE0A8: 2, 0xE0A0: 1 };
  const SMUFL_DOT = 0xE1E7;
  const SMUFL_TS = { 0xE080: 0, 0xE081: 1, 0xE082: 2, 0xE083: 3, 0xE084: 4, 0xE085: 5, 0xE086: 6, 0xE087: 7, 0xE088: 8, 0xE089: 9 };

  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // ---------- 1. 페이지에서 글자/도형 꺼내기 ----------
  async function readPage(pdfjsLib, page) {
    const tc = await page.getTextContent();
    const texts = [];
    tc.items.forEach(it => {
      const str = it.str; if (!str || !str.trim()) return;
      const x = it.transform[4], y = it.transform[5], h = it.height || Math.abs(it.transform[3]), w = it.width;
      // 공백으로 붙어있는 글자는 나눠줌 ("10 12" 같은 경우)
      const parts = str.split(/(\s+)/); let off = 0; const cw = w / Math.max(1, str.length);
      parts.forEach(p => { if (p.trim()) texts.push({ str: p, x: x + off * cw, y, w: p.length * cw, h, font: it.fontName }); off += p.length; });
    });
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0], lw = 1; const st = []; const shapes = []; let pend = null;
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const paintOps = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke]);
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i], a = ops.argsArray[i];
      if (fn === O.save) st.push([ctm, lw]);
      else if (fn === O.restore) { const s = st.pop(); if (s) [ctm, lw] = s; }
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.setLineWidth) lw = a[0];
      else if (fn === O.constructPath) {
        const [pops, coords] = a; let ci = 0; const subs = []; let cur = [];
        for (const op of pops) {
          if (op === O.moveTo) { if (cur.length) subs.push(cur); cur = [tp(coords[ci], coords[ci + 1])]; ci += 2; }
          else if (op === O.lineTo) { cur.push(tp(coords[ci], coords[ci + 1])); ci += 2; }
          else if (op === O.curveTo) { cur.push(tp(coords[ci + 4], coords[ci + 5])); ci += 6; cur.curve = true; }
          else if (op === O.curveTo2 || op === O.curveTo3) { cur.push(tp(coords[ci + 2], coords[ci + 3])); ci += 4; cur.curve = true; }
          else if (op === O.rectangle) { const [x, y, w, h] = coords.slice(ci, ci + 4); ci += 4; if (cur.length) subs.push(cur); subs.push([tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)]); cur = []; }
        }
        if (cur.length) subs.push(cur);
        pend = subs;
      } else if (paintOps.has(fn) && pend) {
        const kind = (fn === O.stroke || fn === O.closeStroke) ? 'S' : 'F';
        for (const s of pend) {
          const xs = s.map(p => p[0]), ys = s.map(p => p[1]);
          shapes.push({ kind, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), n: s.length, curve: !!s.curve, pts: s, lw: lw * Math.hypot(ctm[0], ctm[1]) });
        }
        pend = null;
      } else if (fn === O.endPath) pend = null;
    }
    shapes.forEach(s => { s.w = s.x1 - s.x0; s.h = s.y1 - s.y0; s.cx = (s.x0 + s.x1) / 2; s.cy = (s.y0 + s.y1) / 2; });
    return { texts, shapes };
  }

  // ---------- 2. 줄(오선/타브) 찾기 ----------
  function findStaves(shapes) {
    const hs = shapes.filter(s => s.h < 1.2 && s.w > 6 && (s.kind === 'S' || s.h < 1.2) && !s.curve);
    // y 별로 묶기
    const rows = [];
    hs.sort((a, b) => a.cy - b.cy).forEach(s => {
      const r = rows.find(r => Math.abs(r.y - s.cy) < 0.35);
      if (r) { r.x0 = Math.min(r.x0, s.x0); r.x1 = Math.max(r.x1, s.x1); r.len += s.w; }
      else rows.push({ y: s.cy, x0: s.x0, x1: s.x1, len: s.w });
    });
    const long = rows.filter(r => r.x1 - r.x0 > 60).sort((a, b) => b.y - a.y); // 위→아래
    const staves = []; const used = new Set();
    for (let i = 0; i < long.length; i++) {
      if (used.has(i)) continue;
      // 이 줄부터 같은 간격으로 이어지는 줄들
      const group = [i];
      for (let j = i + 1; j < long.length && group.length < 7; j++) {
        if (used.has(j)) continue;
        const last = long[group[group.length - 1]];
        const gap = last.y - long[j].y;
        if (Math.abs(long[j].x0 - long[i].x0) > 30 || Math.abs(long[j].x1 - long[i].x1) > 30) continue;
        if (group.length === 1) { if (gap > 2.5 && gap < 14) group.push(j); else if (gap >= 14) break; }
        else {
          const sp = long[group[0]].y - long[group[1]].y;
          if (Math.abs(gap - sp) < sp * 0.12) group.push(j); else if (gap > sp * 1.2) break;
        }
      }
      if (group.length === 6 || group.length === 5) {
        group.forEach(g => used.add(g));
        const ls = group.map(g => long[g]);
        staves.push({ type: group.length === 6 ? 'tab' : 'std', lines: ls.map(l => l.y), top: ls[0].y, bottom: ls[ls.length - 1].y, sp: (ls[0].y - ls[ls.length - 1].y) / (ls.length - 1), x0: Math.min(...ls.map(l => l.x0)), x1: Math.max(...ls.map(l => l.x1)) });
      }
    }
    return staves.sort((a, b) => b.top - a.top);
  }

  function verticals(shapes) {
    return shapes.filter(s => !s.curve && s.w < 1.3 && s.h > 3 && (s.kind === 'S' || s.w < 1.3));
  }

  // ---------- 3. 한 타브 줄(시스템) 해석 ----------
  function parseSystem(tab, stdStaff, texts, shapes, ctx) {
    const sp = tab.sp, tol = sp * 0.55;
    const vs = verticals(shapes);
    // 마디줄: 타브 줄 위~아래를 거의 다 덮는 세로선
    let bars = vs.filter(v => v.y0 <= tab.bottom + sp * 0.3 && v.y1 >= tab.top - sp * 0.3 && v.cx > tab.x0 - 3 && v.cx < tab.x1 + 3).map(v => v.cx).sort((a, b) => a - b);
    const bx = []; bars.forEach(x => { if (!bx.length || x - bx[bx.length - 1] > 4) bx.push(x); else bx[bx.length - 1] = Math.max(bx[bx.length - 1], x); });
    if (!bx.length || bx[0] > tab.x0 + 8) bx.unshift(tab.x0);
    if (bx[bx.length - 1] < tab.x1 - 8) bx.push(tab.x1);
    // 프렛 숫자
    const fontHs = [];
    const notes = [];
    texts.forEach(t => {
      const m = t.str.match(/^(\(?)(\d{1,2}|[Xx×])(\)?)$/) || t.str.match(/^<(\d{1,2})>$/);
      if (!m) return;
      const cy = t.y + t.h * 0.35;
      if (cy > tab.top + tol || cy < tab.bottom - tol) return;
      if (t.x < tab.x0 - 2 || t.x > tab.x1 + 2) return;
      const s = Math.round((tab.top - cy) / sp);
      if (s < 0 || s > 5 || Math.abs((tab.top - s * sp) - cy) > tol) return;
      const harm = /^</.test(t.str);
      const raw = harm ? m[1] : m[2];
      const dead = /[Xx×]/.test(raw);
      notes.push({ s, f: dead ? 0 : +raw, dead, paren: !!(m[1] && m[3]), harm, x: t.x + t.w / 2, xl: t.x, xr: t.x + t.w, h: t.h });
      fontHs.push(t.h);
    });
    const normalH = med(fontHs);
    notes.forEach(n => n.grace = n.h < normalH * 0.82);
    // 마디 나누기 + 박 묶기
    const measures = [];
    for (let i = 0; i + 1 < bx.length; i++) {
      const a = bx[i], b = bx[i + 1];
      if (b - a < 12) continue;
      const ns = notes.filter(n => n.x > a && n.x < b).sort((p, q) => p.x - q.x);
      const beats = [];
      ns.forEach(n => {
        const bt = beats.find(bt => Math.abs(bt.x - n.x) < Math.max(3, sp * 0.45) && bt.grace === n.grace);
        if (bt && !bt.notes.some(o => o.s === n.s)) { bt.notes.push(n); bt.x = (bt.x * (bt.notes.length - 1) + n.x) / bt.notes.length; }
        else beats.push({ x: n.x, grace: n.grace, notes: [n] });
      });
      beats.sort((p, q) => p.x - q.x);
      measures.push({ x0: a, x1: b, beats, rests: [], tsMark: null, sysFirst: i === 0 });
    }
    if (stdStaff) readRhythm(measures, stdStaff, texts, shapes, bx, tab);
    readTechniques(measures, tab, stdStaff, texts, shapes);
    return measures;
  }

  // ---------- 4. 리듬 읽기 (오선보) ----------
  function readRhythm(measures, st, texts, shapes, bx, tab) {
    const sp = st.sp;
    const zoneTop = st.top + sp * 7, zoneBot = st.bottom - sp * 7;
    const inZone = s => s.y1 <= zoneTop && s.y0 >= zoneBot;
    const nearBar = x => bx.some(b => Math.abs(b - x) < 1.6);
    const stems = verticals(shapes).filter(v => inZone(v) && v.h > sp * 1.8 && v.h < sp * 14 && !nearBar(v.cx) && !(v.y0 <= st.bottom + 0.5 && v.y1 >= st.top - 0.5 && Math.abs(v.h - (st.top - st.bottom)) < 1));
    const beams = shapes.filter(s => s.kind === 'F' && !s.curve && (s.n === 4 || s.n === 5) && s.w > 2.5 && inZone(s) && s.h < sp * 9 && (() => { const th = beamThick(s); return th > sp * 0.2 && th < sp * 0.9; })());
    const glyphs = texts.filter(t => t.str.length === 1 && t.str.charCodeAt(0) >= 0xE000 && t.y < zoneTop && t.y > zoneBot);
    const gcode = t => t.str.charCodeAt(0);
    // 박자표
    const tsg = glyphs.filter(t => SMUFL_TS[gcode(t)] !== undefined || gcode(t) === 0xE08A || gcode(t) === 0xE08B);
    measures.forEach(m => {
      const own = tsg.filter(t => t.x > m.x0 - 2 && t.x < m.x1 && (!m.beats.length || t.x < m.beats[0].x));
      if (own.some(t => gcode(t) === 0xE08A)) m.tsMark = [4, 4];
      else if (own.some(t => gcode(t) === 0xE08B)) m.tsMark = [2, 2];
      else if (own.length >= 2) {
        const ys = own.slice().sort((a, b) => b.y - a.y);
        const topY = ys[0].y;
        const num = +ys.filter(t => Math.abs(t.y - topY) < 2).sort((a, b) => a.x - b.x).map(t => SMUFL_TS[gcode(t)]).join('');
        const den = +ys.filter(t => Math.abs(t.y - topY) >= 2).sort((a, b) => a.x - b.x).map(t => SMUFL_TS[gcode(t)]).join('');
        if (num && den) m.tsMark = [num, den];
      }
      // 그림으로 된 박자표: 같은 x에 위아래로 쌓인 큰 도형 두 개
      if (!m.tsMark) {
        const big = shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 && s.cx < m.x1 && s.h > sp * 1.6 && s.h < sp * 2.6 && s.w > sp * 1.3 && s.y0 >= st.bottom - 1 && s.y1 <= st.top + 1 && (!m.beats.length || s.cx < m.beats[0].x - sp));
        for (const a of big) for (const b of big) if (a !== b && Math.abs(a.x0 - b.x0) < 1.5 && a.cy > b.cy + sp * 1.5) m.tsMark = 'unknown';
      }
    });
    // 박마다 기둥/빔/꼬리
    measures.forEach(m => {
      m.beats.forEach(bt => {
        if (bt.grace) { bt.dur = 8; return; }
        let best = null, bd = 1e9;
        stems.forEach(v => { const d = Math.abs(v.cx - bt.x); if (d < Math.max(5.5, sp * 1.4) && d < bd) { bd = d; best = v; } });
        bt.stem = best;
        let flags = 0;
        if (best) {
          const lv = [];
          beams.forEach(b => {
            if (best.cx < b.x0 - 0.8 || best.cx > b.x1 + 0.8) return;
            if (b.y1 < best.y0 - sp * 0.8 || b.y0 > best.y1 + sp * 0.8) return;
            lv.push(b);
          });
          // 같은 높이 중복 제거
          const ys = []; lv.forEach(b => { const yAt = beamYAt(b, best.cx); if (!ys.some(y => Math.abs(y - yAt) < sp * 0.45)) ys.push(yAt); });
          flags = ys.length;
          if (!flags) {
            const fg = glyphs.find(t => SMUFL_FLAG[gcode(t)] && Math.abs(t.x - best.cx) < 2.5);
            if (fg) flags = SMUFL_FLAG[gcode(fg)];
            else {
              const fs = shapes.filter(s => s.kind === 'F' && s.curve && s.x0 > best.cx - 1 && s.x0 < best.cx + 1.5 && s.w > sp * 0.8 && s.w < sp * 2 && s.h > sp * 2 && (Math.abs(s.y1 - best.y1) < sp || Math.abs(s.y0 - best.y0) < sp));
              if (fs.length) flags = fs.reduce((a, s) => Math.max(a, s.h > sp * 4.4 ? 3 : s.h > sp * 3.3 ? 2 : 1), 0);
            }
          }
        }
        // 머리 모양 (온/2분)
        const head = glyphs.find(t => SMUFL_HEAD[gcode(t)] && Math.abs(t.x + t.w / 2 - bt.x) < sp * 1.5);
        let headDur = head ? SMUFL_HEAD[gcode(head)] : null;
        if (!head) {
          const hs = shapes.filter(s => s.kind === 'F' && s.curve && Math.abs(s.cx - bt.x) < sp * 1.6 && s.w > sp * 0.9 && s.w < sp * 2 && s.h > sp * 0.7 && s.h < sp * 1.5 && inZone(s));
          const hollow = hs.some(a => hs.some(b => a !== b && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1 && b.w < a.w * 0.85));
          if (hollow) headDur = 2;
        }
        if (flags > 0) bt.dur = Math.min(32, 4 * Math.pow(2, flags));
        else if (best) bt.dur = headDur === 2 ? 2 : 4;
        else bt.dur = headDur === 1 ? 1 : headDur === 2 ? 2 : null; // 모르면 나중에 박자 합으로 결정
        bt.measured = !!best || !!head;
        // 점
        const dotG = glyphs.find(t => gcode(t) === SMUFL_DOT && t.x > bt.x + sp * 0.6 && t.x < bt.x + sp * 3);
        const dotS = shapes.find(s => s.kind === 'F' && s.curve && s.w > 1.1 && s.w < sp * 0.6 && s.h > 1.1 && s.h < sp * 0.6 && Math.abs(s.w - s.h) < 0.45 && s.cx > bt.x + sp * 0.9 && s.cx < bt.x + sp * 3 && s.cy < st.top + sp && s.cy > st.bottom - sp);
        bt.dot = !!(dotG || dotS);
      });
      // 셋잇단: 박들 근처의 "3"
      texts.filter(t => t.str === '3' && t.x > m.x0 + 6 && t.x < m.x1 - 6 && t.y < zoneTop && t.y > zoneBot && t.y > tab.top + tab.sp * 0.8 && (t.y > st.top + sp * 0.5 || t.y < st.bottom - sp * 2.5)).forEach(t => {
        const cand = m.beats.filter(b => !b.grace).sort((a, b) => Math.abs(a.x - t.x) - Math.abs(b.x - t.x)).slice(0, 3);
        cand.forEach(b => b.trip = true);
      });
      // 쉼표 (글자 기호)
      glyphs.filter(t => SMUFL_REST[gcode(t)] && t.x > m.x0 && t.x < m.x1).forEach(t => {
        const dot = glyphs.some(d => gcode(d) === SMUFL_DOT && d.x > t.x + t.w * 0.8 && d.x < t.x + t.w + sp * 1.8 && Math.abs(d.y - t.y) < sp * 2);
        m.rests.push({ x: t.x + t.w / 2, dur: SMUFL_REST[gcode(t)], dot, known: true });
      });
      // 쉼표 (그림 기호): 기둥이 없는 큰 도형
      if (!glyphs.length) {
        shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 + 3 && s.cx < m.x1 - 3 && s.h > sp * 1.35 && s.h < sp * 6 && s.w > sp * 0.5 && s.w < sp * 1.5 && s.cy > st.bottom + sp * 0.4 && s.cy < st.top - sp * 0.4)
          .forEach(s => {
            if (m.beats.some(b => s.cx > b.x - sp * 2.6 && s.cx < b.x + sp * 0.9)) return; // 임시표(♯♭♮)는 음표 바로 왼쪽
            if (stems.some(v => Math.abs(v.cx - s.x0) < 1.6 || Math.abs(v.cx - s.x1) < 1.6)) return; // 꼬리
            if (m.sysFirst && s.cx < st.x0 + sp * 5) return;
            if (m.rests.some(r => Math.abs(r.x - s.cx) < sp)) return;
            m.rests.push({ x: s.cx, dur: s.h < sp * 2.2 ? 8 : s.h < sp * 3.2 ? 16 : 4, dot: false, known: false });
          });
      }
    });
  }
  function beamThick(b) {
    const x = b.cx, pts = b.pts; let lo = 1e9, hi = -1e9;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; if ((p[0] - x) * (q[0] - x) <= 0 && p[0] !== q[0]) { const y = p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]); lo = Math.min(lo, y); hi = Math.max(hi, y); } }
    return lo > hi ? b.h : hi - lo;
  }
  function beamYAt(b, x) {
    // 빔(사각형)의 x 위치에서 중간 높이
    const pts = b.pts; let lo = 1e9, hi = -1e9;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p[0] - x) * (q[0] - x) <= 0 && p[0] !== q[0]) { const y = p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0]); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    }
    return lo > hi ? b.cy : (lo + hi) / 2;
  }

  // ---------- 5. 주법 읽기 ----------
  function readTechniques(measures, tab, st, texts, shapes) {
    const sp = tab.sp;
    const all = []; measures.forEach(m => m.beats.forEach(b => b.notes.forEach(n => all.push(Object.assign(n, { beat: b })))));
    const above = t => t.y > tab.top - sp && t.y < tab.top + sp * 6;
    // 슬라이드: 타브 안의 비스듬한 선
    shapes.filter(s => !s.curve && s.w > sp * 0.3 && s.h > sp * 0.2 && s.h < sp * 1.3 && s.w < sp * 6 && s.cy < tab.top + sp * 0.4 && s.cy > tab.bottom - sp * 0.4 && (s.kind === 'S' || s.n <= 5)).forEach(s => {
      const str = Math.round((tab.top - s.cy) / sp);
      const left = all.filter(n => n.s === str && n.xr <= s.x0 + sp * 0.8 && n.xr > s.x0 - sp * 2.5).sort((a, b) => b.x - a.x)[0];
      const right = all.filter(n => n.s === str && n.xl >= s.x1 - sp * 0.8 && n.xl < s.x1 + sp * 2.5).sort((a, b) => a.x - b.x)[0];
      if (left && right) left.slide = 'to';
      else if (left) left.slide = 'out';
      else if (right) right.slide = 'in';
    });
    // 해머/풀
    texts.filter(t => (t.str === 'H' || t.str === 'P') && above(t)).forEach(t => {
      const cx = t.x + t.w / 2; let best = null, bg = 1e9;
      all.forEach(a => all.forEach(b => {
        if (a === b || a.s !== b.s || a.x >= cx || b.x <= cx) return;
        if (all.some(c => c.s === a.s && c.x > a.x && c.x < b.x)) return;
        const g = (b.x - a.x) + a.s * 0.01; if (g < bg) { bg = g; best = a; }
      }));
      if (best) best.hp = true;
    });
    // 벤딩
    const bendTxt = texts.filter(t => above(t) && /^(full|½|1\/2|1\/4|¼|1½|1 1\/2|2|3\/4)$/i.test(t.str) && t.y > tab.top);
    const bentCount = new Map();
    bendTxt.forEach(t => {
      const cand = all.filter(n => n.x < t.x + t.w * 0.5 && n.x > t.x - sp * 4).sort((a, b) => (b.x - a.x) || (a.s - b.s));
      const n = cand[0]; if (!n) return;
      const top = all.filter(o => o.beat === n.beat).sort((a, b) => a.s - b.s)[0];
      const a = /full/i.test(t.str) ? 1 : /1½|1 1\/2/.test(t.str) ? 1.5 : /^2$/.test(t.str) ? 2 : /1\/4|¼/.test(t.str) ? 0.5 : 0.5;
      const c = (bentCount.get(top) || 0) + 1; bentCount.set(top, c);
      top.bend = { a, r: c > 1 || undefined };
    });
    // P.M. / let ring 구간
    const spans = (re, prop) => texts.filter(t => re.test(t.str)).forEach(t => {
      if (!(t.y < tab.bottom + sp * 0 && t.y > tab.bottom - sp * 6) && !(t.y > tab.top && t.y < tab.top + sp * 8)) return;
      let end = t.x + t.w;
      const dashes = shapes.filter(s => s.h < 1 && !s.curve && Math.abs(s.cy - (t.y + t.h * 0.35)) < sp * 0.7 && s.x0 > t.x).sort((a, b) => a.x0 - b.x0);
      for (const d of dashes) { if (d.x0 - end < sp * 2.5) end = Math.max(end, d.x1); else break; }
      const endTick = verticals(shapes).find(v => Math.abs(v.cx - end) < 2 && Math.abs(v.cy - (t.y + t.h * 0.35)) < sp * 1.5);
      if (endTick) end = endTick.cx;
      all.forEach(n => { if (n.x >= t.x - 2 && n.x <= end + 2) n[prop] = true; });
    });
    spans(/^P\.?M\.?$/i, 'pm');
    spans(/^let\s*ring$/i, 'lr');
  }

  // ---------- 6. 박자 합 규칙으로 보정 ----------
  const TK = { 1: 1920, 2: 960, 4: 480, 8: 240, 16: 120, 32: 60 };
  const tk = b => (b.grace || !b.dur) ? 0 : TK[b.dur] * (b.dot ? 1.5 : 1) * (b.trip ? 2 / 3 : 1);
  function splitTicks(t) { // 남은 길이를 쉼표 길이들로
    const out = []; for (const d of [1, 2, 4, 8, 16, 32]) { while (t >= TK[d] - 1) { out.push(d); t -= TK[d]; } } return out;
  }
  function fitMeasure(m, cap, warnings, label) {
    let items = m.beats.map(b => ({ x: b.x, b }));
    // 박이 있는 위치의 쉼표는 무시, 나머지 쉼표 추가
    m.rests.forEach(r => { if (!m.beats.some(b => Math.abs(b.x - r.x) < 3)) items.push({ x: r.x, rest: r }); });
    items.sort((a, b) => a.x - b.x);
    const sum = () => items.reduce((a, it) => a + (it.b ? tk(it.b) : TK[it.rest.dur] * (it.rest.dot ? 1.5 : 1)), 0);
    let s = sum();
    // 길이를 모르는 박: 남은 길이를 나눠 가짐
    const unkB = m.beats.filter(b => !b.grace && !b.dur);
    if (unkB.length) {
      const known = s - items.filter(it => it.rest && !it.rest.known).reduce((a, it) => a + TK[it.rest.dur], 0);
      const each = (cap - known) / unkB.length;
      let d = [1, 2, 4, 8, 16, 32].find(d => Math.abs(TK[d] - each) < 1), dot = false;
      if (!d) { d = [1, 2, 4, 8, 16, 32].find(d => Math.abs(TK[d] * 1.5 - each) < 1); dot = !!d; }
      unkB.forEach(b => { b.dur = d || 8; b.dot = dot; });
      if (!d) m.guessed = true;
      s = sum();
    }
    // 모양을 모르는 쉼표는 남은 길이에 맞춰 조정
    const unk = items.filter(it => it.rest && !it.rest.known);
    if (s !== cap && unk.length) {
      const rem = cap - (s - unk.reduce((a, it) => a + TK[it.rest.dur], 0));
      if (rem > 0) {
        const each = rem / unk.length;
        const d = [1, 2, 4, 8, 16, 32].find(d => Math.abs(TK[d] - each) < 1) || [1, 2, 4, 8, 16, 32].find(d => TK[d] * 1.5 === each);
        if (d) unk.forEach(it => { it.rest.dur = d; it.rest.dot = TK[d] !== each; });
        s = sum();
      }
    }
    // 음악 규칙으로 고치기: 한두 개 음의 길이를 바꿔서 박자 합이 딱 맞으면 채택
    if (s !== cap && m.beats.length) {
      const alts = b => {
        const o = [];
        if (b.grace) return o;
        if (b.dur === 4) o.push({ dur: 2 }); if (b.dur === 2) o.push({ dur: 1 });
        if (!b.dot) o.push({ dot: true }); else o.push({ dot: false });
        if (b.dur >= 8) o.push({ dur: b.dur / 2 }), o.push({ dur: b.dur * 2 });
        return o;
      };
      const bs = m.beats.filter(b => !b.grace);
      const tryFix = (changes) => { const save = changes.map(([b]) => ({ b, dur: b.dur, dot: b.dot })); changes.forEach(([b, c]) => Object.assign(b, c)); if (sum() === cap) return true; save.forEach(v => { v.b.dur = v.dur; v.b.dot = v.dot; }); return false; };
      let fixed = false;
      outer: for (const b of bs) for (const c of alts(b)) if (tryFix([[b, c]])) { fixed = true; break outer; }
      if (!fixed && bs.length <= 24) {
        outer2: for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) for (const c1 of alts(bs[i])) for (const c2 of alts(bs[j])) if (tryFix([[bs[i], c1], [bs[j], c2]])) { fixed = true; break outer2; }
      }
      if (fixed) m.guessed = true;
      s = sum();
    }
    if (s < cap && m.beats.length) {
      // 오선보가 없거나 쉼표를 못 찾음: 가장 넓은 빈 곳에 쉼표
      const gaps = [];
      for (let i = 0; i < items.length; i++) gaps.push({ i, g: (i + 1 < items.length ? items[i + 1].x : m.x1) - items[i].x });
      gaps.sort((a, b) => b.g - a.g);
      const avg = gaps.reduce((a, g) => a + g.g, 0) / gaps.length;
      if (gaps[0] && gaps[0].g > avg * 1.4) {
        const pos = gaps[0].i; const restDurs = splitTicks(cap - s);
        const prev = items[pos];
        // 앞 음이 있으면 붙임줄로 이어진 음(악보에서 타브 숫자 없이 이어지는 음), 없으면 쉼표
        if (!prev.b) m.guessed = true;
        restDurs.reverse().forEach((d, k) => items.splice(pos + 1, 0, prev.b ? { x: prev.x + 1 + k, b: { dur: d, dot: false, notes: prev.b.notes.map(n => ({ s: n.s, f: n.f, dead: n.dead, tieFill: true })), x: prev.x + 1 + k } } : { x: prev.x + 1 + k, rest: { dur: d, dot: false } }));
      } else if (!m.beats.some(b => b.measured)) {
        // 리듬 정보가 아예 없으면 균등 분배
        m.guessed = true;
      } else m.guessed = true;
      s = sum();
    }
    m.items = items;
    m.sum = s;
    if (s !== cap && m.beats.length) warnings.push(label);
  }

  // ---------- 메인 ----------
  async function importPdf(pdfjsLib, data, onProgress) {
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    const sysList = []; const meta = { title: '', artist: '', bpm: 100, tuning: 'standard' };
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p, doc.numPages);
      const page = await doc.getPage(p);
      const { texts, shapes } = await readPage(pdfjsLib, page);
      const staves = findStaves(shapes);
      const tabs = staves.filter(s => s.type === 'tab');
      if (p === 1) {
        const firstTop = staves.length ? staves[0].top + staves[0].sp * 12 : 0;
        const head = texts.filter(t => t.y > firstTop && !/^\d+\/\d+$/.test(t.str) && t.str.charCodeAt(0) < 0xE000);
        const byH = head.slice().sort((a, b) => b.h - a.h);
        if (byH[0]) {
          const titleY = byH[0].y; meta.title = head.filter(t => Math.abs(t.y - titleY) < 1).sort((a, b) => a.x - b.x).map(t => t.str).join(' ');
          const below = head.filter(t => t.y < titleY - 2 && t.y > titleY - byH[0].h * 2.5 && Math.abs(t.x - byH[0].x) < 150).sort((a, b) => b.y - a.y);
          if (below[0]) meta.artist = head.filter(t => Math.abs(t.y - below[0].y) < 1 && Math.abs(t.x - byH[0].x) < 150).map(t => t.str).join(' ');
        }
        const eq = texts.find(t => t.str === '=' || /^=\s*\d/.test(t.str));
        if (eq) {
          const m1 = eq.str.match(/(\d{2,3})/);
          const nx = texts.filter(t => Math.abs(t.y - eq.y) < 2 && t.x > eq.x && t.x < eq.x + 40 && /^\d{2,3}$/.test(t.str)).sort((a, b) => a.x - b.x)[0];
          if (m1) meta.bpm = +m1[1]; else if (nx) meta.bpm = +nx.str;
        }
        const tun = texts.map(t => t.str).join(' ');
        if (/drop\s*d/i.test(tun)) meta.tuning = 'dropD';
        else if (/drop\s*c/i.test(tun)) meta.tuning = 'dropC';
        else if (/(half|1\/2)\s*step\s*down|E♭|Eb\s*tuning/i.test(tun)) meta.tuning = 'halfDown';
        else if (/(full|whole)\s*step\s*down|D\s*standard/i.test(tun)) meta.tuning = 'wholeDown';
      }
      // 시스템별로 첫 번째 타브만 사용 (여러 악기가 있으면 맨 위 기타)
      const seen = [];
      tabs.forEach(tab => {
        const std = staves.filter(s => s.type === 'std' && s.bottom > tab.top && s.bottom - tab.top < tab.sp * 20 && s.x0 < tab.x0 + 30 && s.x1 > tab.x1 - 30).sort((a, b) => a.bottom - b.bottom)[0];
        const ms = parseSystem(tab, std, texts, shapes, {});
        // 섹션 이름
        const secs = texts.filter(t => /^(intro|verse|chorus|bridge|solo|outro|pre-?chorus|interlude|break|ending|riff\s*\w*|[A-Z])$/i.test(t.str) && t.y > (std ? std.top : tab.top) + tab.sp * 2 && t.y < (std ? std.top : tab.top) + tab.sp * 9);
        secs.forEach(t => {
          if (t.str.length === 1) { const boxed = shapes.some(s => s.kind === 'S' && !s.curve && s.x0 < t.x && s.x1 > t.x + t.w && s.y0 < t.y && s.y1 > t.y + t.h * 0.6 && s.w < 30); if (!boxed) return; }
          const m = ms.find(m => t.x + t.w / 2 >= m.x0 - 10 && t.x < m.x1); if (m && !m.section) m.section = t.str;
        });
        if (seen.some(y => Math.abs(y - tab.top) < 1)) return; seen.push(tab.top);
        sysList.push({ page: p, measures: ms, hasStd: !!std });
      });
    }
    // 곡 만들기
    const song = newSong();
    song.title = meta.title || '불러온 악보'; song.artist = meta.artist; song.bpm = meta.bpm; song.tuning = meta.tuning;
    song.view.perLine = 4;
    const allM = []; sysList.forEach(s => s.measures.forEach(m => allM.push(m)));
    if (!allM.length) throw new Error('NO_TAB');
    // 박자표 결정
    const rawSum = m => m.beats.reduce((a, b) => a + tk(b), 0) + m.rests.filter(r => !m.beats.some(b => Math.abs(b.x - r.x) < 3)).reduce((a, r) => a + TK[r.dur] * (r.dot ? 1.5 : 1), 0);
    let ts = null;
    const firstMark = allM.find(m => Array.isArray(m.tsMark));
    const sums = allM.map(rawSum).filter(x => x > 0 && x % 240 === 0);
    const counts = {}; sums.forEach(x => counts[x] = (counts[x] || 0) + 1);
    const modeSum = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 1920;
    ts = firstMark ? firstMark.tsMark : (modeSum % 480 === 0 ? [modeSum / 480, 4] : [modeSum / 240, 8]);
    song.ts = ts;
    const warnings = [];
    let curTs = ts;
    song.measures = [];
    allM.forEach((m, i) => {
      if (Array.isArray(m.tsMark)) curTs = m.tsMark;
      else if (m.tsMark === 'unknown' || (i === 0 && !firstMark)) {
        // 그림으로 된 박자표: 다음 박자표 전까지 몇 마디의 박자 합 중 가장 흔한 값
        const win = [m]; for (let k = i + 1; k < allM.length && k < i + 6 && !allM[k].tsMark; k++) win.push(allM[k]);
        const cnt = {}; win.map(rawSum).filter(x => x > 0 && x % 240 === 0).forEach(x => cnt[x] = (cnt[x] || 0) + 1);
        const best = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a] || b - a)[0];
        if (best) curTs = best % 480 === 0 ? [best / 480, 4] : [best / 240, 8];
      }
      let cap = curTs[0] * 1920 / curTs[1];
      // 못갖춘마디(첫 마디가 짧음)
      let pickup = null;
      if (i === 0 && allM.length > 1) { const r = rawSum(m); if (r > 0 && r < cap && r % 240 === 0 && !m.rests.length) { pickup = r % 480 === 0 ? [r / 480, 4] : [r / 240, 8]; cap = r; } }
      fitMeasure(m, cap, warnings, i + 1);
      const nm = newMeasure();
      const prevTs = i === 0 ? null : (song.measures[i - 1] && measureTs(song, i - 1));
      if (i === 0) { song.ts = curTs; if (pickup) nm.ts = pickup; }
      else if (!prevTs || prevTs[0] !== curTs[0] || prevTs[1] !== curTs[1]) nm.ts = curTs.slice();
      if (m.guessed || warnings.includes(i + 1)) nm.check = true;
      if (m.section) nm.section = m.section;
      m.items.forEach(it => {
        if (it.rest) { const b = newBeat(it.rest.dur); b.dot = !!it.rest.dot; nm.beats.push(b); return; }
        const src = it.b; const b = newBeat(src.dur || 8); b.dot = !!src.dot; b.trip = !!src.trip; if (src.grace) b.grace = true;
        src.notes.forEach(n => {
          const nn = newNote(n.s, n.f);
          if (n.dead) nn.dead = true; if (n.harm) nn.harm = true;
          if (n.slide) nn.slide = n.slide; if (n.hp) nn.hp = true; if (n.bend) nn.bend = { a: n.bend.a, ...(n.bend.r ? { r: true } : {}) };
          if (n.pm) nn.pm = true; if (n.lr) nn.lr = true;
          if (n.paren) nn._paren = true;
          if (n.tieFill) nn.tie = true;
          b.notes.push(nn);
        });
        nm.beats.push(b);
      });
      song.measures.push(nm);
    });
    // 괄호 숫자: 앞 음과 같으면 붙임줄, 아니면 고스트
    song.measures.forEach((m, mi) => m.beats.forEach((b, bi) => b.notes.forEach(n => {
      if (!n._paren) return; delete n._paren;
      const p = prevOnString(song, mi, bi, n.s);
      if (p && p.note.f === n.f) n.tie = true; else n.ghost = true;
    })));
    return { song, warnings, systems: sysList.length, pages: doc.numPages, noStd: sysList.filter(s => !s.hasStd).length };
  }

  return { importPdf };
})();

if (typeof module !== 'undefined') module.exports = PdfImport;
