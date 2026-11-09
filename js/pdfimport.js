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
  const SMUFL_STAC_A = 0xE4A2, SMUFL_STAC_B = 0xE4A3;
  let DBG = null, CUR_PAGE = 0; // 디버그: 쉼표 후보와 판단 이유 기록
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
    let images = 0; // 그림(사진·스캔) 개수
    let ctm = [1, 0, 0, 1, 0, 0], lw = 1; const st = []; const shapes = []; let pend = null;
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    // 3차 베지어 곡선: 끝점은 경로에, 곡선 위 중간점은 크기 계산용(ext)으로만 (점 개수 n 은 그대로)
    const bez = (cur, c1, c2, e) => {
      const p0 = cur[cur.length - 1] || c1; cur.curve = true; cur.ext = cur.ext || [];
      if (p0) for (const t of [0.15, 0.3, 0.5, 0.7, 0.85]) {
        const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        const q = [a * p0[0] + b * c1[0] + c * c2[0] + d * e[0], a * p0[1] + b * c1[1] + c * c2[1] + d * e[1]];
        cur.ext.push(q); (cur.seq = cur.seq || cur.slice()).push(q);
      }
      cur.push(e); (cur.seq = cur.seq || cur.slice(0, -1)).push(e);
    };
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
          if (op === O.moveTo) { if (cur.length) subs.push(cur); cur = [tp(coords[ci], coords[ci + 1])]; cur.seq = cur.slice(); ci += 2; }
          else if (op === O.lineTo) { const q = tp(coords[ci], coords[ci + 1]); cur.push(q); (cur.seq = cur.seq || cur.slice(0, -1)).push(q); ci += 2; }
          else if (op === O.curveTo) { bez(cur, tp(coords[ci], coords[ci + 1]), tp(coords[ci + 2], coords[ci + 3]), tp(coords[ci + 4], coords[ci + 5])); ci += 6; }
          else if (op === O.curveTo2) { const e = tp(coords[ci + 2], coords[ci + 3]); bez(cur, cur[cur.length - 1], tp(coords[ci], coords[ci + 1]), e); ci += 4; }
          else if (op === O.curveTo3) { const e = tp(coords[ci + 2], coords[ci + 3]); bez(cur, tp(coords[ci], coords[ci + 1]), e, e); ci += 4; }
          else if (op === O.rectangle) { const [x, y, w, h] = coords.slice(ci, ci + 4); ci += 4; if (cur.length) subs.push(cur); subs.push([tp(x, y), tp(x + w, y), tp(x + w, y + h), tp(x, y + h)]); cur = []; }
        }
        if (cur.length) subs.push(cur);
        pend = subs;
      } else if (paintOps.has(fn) && pend) {
        const kind = (fn === O.stroke || fn === O.closeStroke) ? 'S' : 'F';
        for (const s of pend) {
          // 곡선은 끝점만이 아니라 곡선 위의 점들까지 넣어 실제 크기(높이 등)를 잃지 않음
          const all = s.ext ? s.concat(s.ext) : s;
          const xs = all.map(p => p[0]), ys = all.map(p => p[1]), ey = s.map(p => p[1]);
          // eh = 끝점들만의 높이 (붙임줄처럼 한쪽으로 휜 곡선은 eh 가 거의 0)
          shapes.push({ kind, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), eh: Math.max(...ey) - Math.min(...ey), n: s.length, curve: !!s.curve, pts: s, poly: s.seq || s, lw: lw * Math.hypot(ctm[0], ctm[1]) });
        }
        pend = null;
      } else if (fn === O.endPath) pend = null;
      else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) images++;
    }
    shapes.forEach(s => { s.w = s.x1 - s.x0; s.h = s.y1 - s.y0; s.cx = (s.x0 + s.x1) / 2; s.cy = (s.y0 + s.y1) / 2; });
    return { texts, shapes, images };
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
    // 덧줄(짧은 줄)이 같은 높이에 여러 개 있어도 줄로 보지 않도록, 실제로 칠해진 길이 비율도 봄
    const full = rows.filter(r => r.x1 - r.x0 > 60 && r.len > (r.x1 - r.x0) * 0.4);
    // 숫자가 촘촘한 타브 줄은 숫자 뒤가 비어 있어 칠해진 비율이 낮음 → 양 끝이 다른 온전한 줄과 딱 맞으면 줄로 인정
    //  (덧줄은 시스템 왼쪽 끝(음자리표 자리)에서 시작하지 않으므로 섞이지 않음)
    const gappy = rows.filter(r => !full.includes(r) && r.x1 - r.x0 > 200 && r.len > (r.x1 - r.x0) * 0.08 && full.some(f => Math.abs(f.x0 - r.x0) < 1.5 && Math.abs(f.x1 - r.x1) < 1.5 && Math.abs(f.y - r.y) < 60));
    const long = full.concat(gappy).sort((a, b) => b.y - a.y); // 위→아래
    const staves = []; const used = new Set();
    for (let i = 0; i < long.length; i++) {
      if (used.has(i)) continue;
      // 이 줄부터 같은 간격으로 이어지는 줄들
      const group = [i];
      for (let j = i + 1; j < long.length && group.length < 7; j++) {
        if (used.has(j)) continue;
        const last = long[group[group.length - 1]];
        const gap = last.y - long[j].y;
        // 양 끝이 거의 같아야 같은 오선. 한 줄 끝부분만 조금 빠진 경우(겹치는 길이 85% 이상)도 허용
        const ov = Math.min(long[j].x1, long[i].x1) - Math.max(long[j].x0, long[i].x0), wide = Math.max(long[j].x1 - long[j].x0, long[i].x1 - long[i].x0);
        if ((Math.abs(long[j].x0 - long[i].x0) > 30 || Math.abs(long[j].x1 - long[i].x1) > 30) && ov < wide * 0.85) continue;
        if (group.length === 1) { if (gap > 2.5 && gap < 14) group.push(j); else if (gap >= 14) break; }
        else {
          const sp = long[group[0]].y - long[group[1]].y;
          if (Math.abs(gap - sp) < sp * 0.12) group.push(j); else if (gap > sp * 1.2) break;
        }
      }
      // 덧줄이 길게 이어진 줄(높은 음이 계속될 때)이 오선 바로 위/아래에 붙어 6줄처럼 보이는 경우:
      //  진짜 오선·타브 줄은 모두 시스템 왼쪽 끝에서 함께 시작하므로, 맨 위/아래 줄만 시작점이 다르면 그 줄은 뺌
      if (group.length === 6) {
        const xs0 = group.map(g => long[g].x0), mx = med(xs0);
        if (Math.abs(xs0[0] - mx) > 3 && xs0.slice(1).every(x => Math.abs(x - mx) <= 3)) group.shift();
        else if (Math.abs(xs0[5] - mx) > 3 && xs0.slice(0, 5).every(x => Math.abs(x - mx) <= 3)) group.pop();
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
    // 리듬을 어디서 읽을지: ① 타브 아래에 기둥·빔이 그려진 악보(Guitar Pro 등) → 타브 리듬
    // ② 아니면 바로 위 오선보가 이 기타의 오선보일 때만 오선보 리듬 (보컬 오선보 등 다른 악기면 쓰지 않음)
    const tr = findTabRhythm(tab, shapes, measures);
    if (ctx) ctx.rhythmSource = tr ? 'tab' : stdStaff ? 'std' : 'none';
    if (tr) readTabRhythm(measures, tab, tr, texts, shapes, bx);
    else if (stdStaff && stdMatchesTab(measures, stdStaff, texts, shapes)) readRhythm(measures, stdStaff, texts, shapes, bx, tab, ctx && ctx.ceil);
    else if (stdStaff && ctx) ctx.rhythmSource = 'other-staff';
    // 타브 안의 리듬 빗금(/) 개수: 오선보에서 찾은 빗금과 맞는지 확인용.
    //  오선보 리듬이 없으면 빗금 자리에 박을 만들고 길이는 간격으로 추측(확인 표시)
    const tsl = slashHeads(shapes, s => s.cy < tab.top - sp * 0.5 && s.cy > tab.bottom + sp * 0.5 && s.cx > tab.x0 && s.cx < tab.x1, sp * 0.75);
    measures.forEach(m => {
      const xs = tsl.filter(s => s.cx > m.x0 + 1 && s.cx < m.x1 - 1);
      if (!xs.length && !m.beats.some(b => b.slash)) return;
      m.tabSlashes = xs.length;
      if (!m.beats.some(b => b.slash) && (!ctx || ctx.rhythmSource !== 'std')) { xs.forEach(s => m.beats.push({ x: s.cx, notes: [], slash: true })); m.beats.sort((p, q) => p.x - q.x); }
    });
    readTechniques(measures, tab, stdStaff, texts, shapes);
    // 겹세로줄·도돌이표 사이의 좁은 빈칸(음·쉼표 없음)은 마디가 아님. 그 안의 박자표는 다음 마디로 넘김
    const out = [];
    measures.forEach((m, k) => {
      if (!m.beats.length && !m.rests.length && m.x1 - m.x0 < tab.sp * 6) { const nx = measures[k + 1]; if (nx && m.tsMark && !nx.tsMark) nx.tsMark = m.tsMark; if (nx && m.sysFirst) nx.sysFirst = true; return; }
      out.push(m);
    });
    return out;
  }

  // ---------- 3-1. 타브 아래 리듬(기둥·빔) 찾기 ----------
  // 타브 아래쪽에 아랫끝이 같은 높이(리듬 기준선)에 모인 세로선이 여러 개 있으면 "타브 리듬" 악보
  function findTabRhythm(tab, shapes, measures) {
    const sp = tab.sp;
    const vs = verticals2(shapes).filter(v => v.cx > tab.x0 && v.cx < tab.x1 && v.y0 < tab.bottom - sp * 0.4 && v.y0 > tab.bottom - sp * 6 && v.y1 < tab.top + sp * 0.5);
    if (vs.length < 3) return null;
    const cnt = new Map();
    // 기준선은 타브 가까이까지 올라오는 기둥(2분음표의 짧은 기둥 포함)으로만 정함 (아래 단 오선보의 높은 음 기둥이 섞이지 않도록)
    vs.filter(v => v.y1 > tab.bottom - sp * 2.2).forEach(v => { const k = Math.round(v.y0 * 2) / 2; cnt.set(k, (cnt.get(k) || 0) + 1); });
    if (!cnt.size) return null;
    const [yb, n] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    const beats = measures.reduce((a, m) => a + m.beats.length, 0);
    if (n < 3 || n < beats * 0.3) return null;
    // 꼬리(플래그)가 달린 기둥은 아랫끝이 기준선보다 조금 더 내려감
    return { yb, stems: vs.filter(v => v.y0 < yb + 0.8 && v.y0 > yb - sp * 0.4) };
  }
  // 짧은 세로선(기둥 조각)도 포함
  function verticals2(shapes) { return shapes.filter(s => !s.curve && s.w < 1.3 && s.h > 2 && (s.kind === 'S' || s.w < 1.3)); }
  // 오선보가 이 타브와 같은 악기인지: 오선보 음표머리/기둥이 타브 박 위치와 맞는 비율
  function stdMatchesTab(measures, st, texts, shapes) {
    const sp = st.sp;
    const xs = [];
    shapes.forEach(s => { if (s.kind === 'F' && s.curve && s.w > sp * 0.9 && s.w < sp * 1.8 && s.h > sp * 0.6 && s.h < sp * 1.5 && s.cy < st.top + sp * 6 && s.cy > st.bottom - sp * 6) xs.push(s.cx); });
    texts.forEach(t => { const c = t.str.charCodeAt(0); if (t.str.length === 1 && c >= 0xE0A0 && c <= 0xE0A9 && t.y < st.top + sp * 6 && t.y > st.bottom - sp * 6) xs.push(t.x + t.w / 2); });
    const beats = []; measures.forEach(m => m.beats.forEach(b => { if (!b.grace) beats.push(b.x); }));
    if (!beats.length) return true;
    if (!xs.length) return false;
    const hit = beats.filter(x => xs.some(h => Math.abs(h - x) < sp * 1.6)).length;
    return hit / beats.length >= 0.5;
  }
  // ---------- 3-2. 타브 아래 리듬 읽기 ----------
  // 기둥(긴 선) = 4분음표 이하, 빔 개수 = 8분/16분/32분, 짧은 기둥 조각 = 2분음표, 기둥 없음 = 온음표
  // 쉼표는 타브 안의 쉼표 기호, 점은 기둥 아랫끝 오른쪽 점
  function readTabRhythm(measures, tab, tr, texts, shapes, bx) {
    const sp = tab.sp, yb = tr.yb;
    const gcode = t => t.str.charCodeAt(0);
    const glyphs = texts.filter(t => t.str.length === 1 && gcode(t) >= 0xE000);
    const beams = shapes.filter(s => s.kind === 'F' && !s.curve && (s.n === 4 || s.n === 5) && s.w > 1.5 && s.h < sp * 0.7 && s.y0 > yb - sp * 0.6 && s.y1 < yb + sp * 2.2);
    const dotsV = shapes.filter(s => s.kind === 'F' && s.curve && s.w > 0.6 && s.w < sp * 0.5 && s.h > 0.6 && s.h < sp * 0.5 && Math.abs(s.w - s.h) < 0.5).map(s => ({ x: s.cx, y: s.cy }));
    const dots = glyphs.filter(t => gcode(t) === SMUFL_DOT).map(t => ({ x: t.x + t.w / 2, y: t.y })).concat(dotsV);
    // 점은 바로 왼쪽 기둥의 것: 다음 기둥보다 오른쪽 점은 세지 않음
    const nextStem = v => tr.stems.reduce((a, w) => w.cx > v.cx + 0.8 && w.cx < a ? w.cx : a, Infinity);
    const dotCount = (x, y0, y1, xmax = Infinity) => {
      const c = dots.filter(d => d.x > x && d.x < Math.min(x + sp * 1.3, xmax) && d.y > y0 && d.y < y1).sort((a, b) => a.x - b.x);
      if (!c.length) return 0;
      const second = dots.find(d => d.x > c[0].x + sp * 0.2 && d.x < c[0].x + sp * 1.0 && Math.abs(d.y - c[0].y) < sp * 0.3);
      return second ? 2 : 1;
    };
    const log = e => { if (DBG) DBG.push(Object.assign({ page: CUR_PAGE }, e)); };
    // 빔 한 조각이 어느 기둥(들)의 것인지.
    //  양 끝이 기둥을 덮으면(살짝 넘치면) 덮인 기둥 모두 = 이어진 빔.
    //  덮는 기둥이 없고 기둥 옆에 붙은 짧은 조각 = 부분 빔(한 기둥에만).
    //  두 기둥 사이에 꽉 낀 짧은 조각은 어느 쪽인지 모양만으로 모호 → 점이 없는 쪽(짧은 음) 우선, 그다음 왼쪽.
    const ownCache = new Map();
    const owner = b => {
      if (ownCache.has(b)) return ownCache.get(b);
      let res = tr.stems.filter(v => v.cx >= b.x0 - 0.15 && v.cx <= b.x1 + 0.15);
      if (!res.length) {
        const near = tr.stems.filter(v => v.cx > b.x0 - 0.7 && v.cx < b.x1 + 0.7).sort((a, c) => a.cx - c.cx);
        if (near.length === 1) res = near;
        else if (near.length >= 2) {
          const hasDot = v => dotCount(v.cx + 0.3, yb - sp * 0.6, yb + sp * 2.4, nextStem(v)) > 0;
          const nd = near.filter(v => !hasDot(v));
          res = [nd.length === 1 ? nd[0] : near[0]];
        }
      }
      ownCache.set(b, res); return res;
    };
    // 기둥 하나의 길이: 짧은 기둥=2분, 빔/꼬리 개수, 점
    function stemDur(v, bt) {
      const stub = v.y1 < tab.bottom - sp * 0.3 && v.h < sp * 1.6;
      if (stub) { bt.dur = 2; bt.measured = true; bt.ev = 'short-stem'; }
      else {
        // 이 기둥 아랫끝에 실제로 붙은 빔만 셈 (높이별로 1개씩)
        const lv = []; beams.forEach(b => { if (owner(b).indexOf(v) < 0) return; const y = b.cy; if (!lv.some(q => Math.abs(q - y) < b.h * 0.8)) lv.push(y); });
        let flags = lv.length;
        if (!flags) { const fg = glyphs.find(t => SMUFL_FLAG[gcode(t)] && Math.abs(t.x - v.cx) < 2.5 && Math.abs(t.y - yb) < sp * 3); if (fg) flags = SMUFL_FLAG[gcode(fg)]; }
        if (!flags) { const fs = shapes.filter(s => s.kind === 'F' && s.curve && s.x0 > v.cx - 1 && s.x0 < v.cx + 1.5 && s.w > sp * 0.4 && s.w < sp * 1.6 && s.h > sp * 0.8 && Math.abs(s.y0 - yb) < sp * 0.6); if (fs.length) flags = fs.reduce((a, s) => Math.max(a, s.h > sp * 2.6 ? 3 : s.h > sp * 1.8 ? 2 : 1), 0); }
        bt.dur = flags ? Math.min(32, 4 * Math.pow(2, flags)) : 4; bt.measured = true; bt.ev = flags ? 'beams:' + flags : 'stem';
      }
      const nd = dotCount(v.cx + 0.3, yb - sp * 0.6, yb + sp * 2.4, nextStem(v));
      bt.dot = nd === 2 ? 2 : nd === 1;
    }
    // 타브 안의 붙임줄 곡선 (납작한 곡선)
    const tieArcs = shapes.filter(s => s.curve && s.w > sp * 0.6 && s.h < sp * 1.2 && s.cy > tab.bottom - sp * 0.8 && s.cy < tab.top + sp * 0.5);
    // 박자표: 타브 줄 위의 박자표 글자 (오선보가 다른 악기여도 박자는 같음)
    const tsg = glyphs.filter(t => (SMUFL_TS[gcode(t)] !== undefined || gcode(t) === 0xE08A || gcode(t) === 0xE08B) && t.y > tab.bottom - sp && t.y < tab.top + sp);
    measures.forEach(m => {
      m.rhythmSource = 'tab';
      tsFromGlyphs(m, tsg);
      m.beats.forEach(bt => {
        if (bt.grace) { bt.dur = 8; return; }
        const v = tr.stems.filter(v => Math.abs(v.cx - bt.x) < sp * 0.7).sort((a, b) => Math.abs(a.cx - bt.x) - Math.abs(b.cx - bt.x))[0];
        bt.stem = v || null;
        if (!v) { bt.dur = 1; bt.measured = true; bt.ev = 'no-stem'; return; } // 기둥 없음 = 온음표
        stemDur(v, bt);
      });
      // 숫자 없는 기둥 = 앞 음이 붙임줄로 이어진 음 (쉼표 기둥은 제외).
      // 증거: 짝 없는 긴 기둥 + 그 위치에 쉼표 기호 없음 + 왼쪽에서 오는 붙임줄 곡선
      const used = new Set(m.beats.map(b => b.stem).filter(Boolean));
      const restX = glyphs.filter(t => SMUFL_REST[gcode(t)] && t.x > m.x0 - 1 && t.x < m.x1 && t.y > tab.bottom - sp && t.y < tab.top + sp).map(t => t.x + t.w / 2);
      tr.stems.filter(v => !used.has(v) && v.cx > m.x0 + 1.5 && v.cx < m.x1 - 1.5 && v.y1 > tab.bottom - sp * 1.2).forEach(v => {
        let why = null;
        if (restX.some(x => Math.abs(x - v.cx) < sp * 1.2)) why = 'rest-stem';
        else if (m.beats.some(b => !b.grace && Math.abs(b.x - v.cx) < sp * 0.7)) why = 'beat';
        else if (!m.beats.some(b => !b.grace && b.x < v.cx)) why = 'no-prev';
        else if (!tieArcs.some(c => c.x1 > v.cx - sp * 4 && c.x1 < v.cx + sp * 0.6 && c.x0 < v.cx - sp)) why = 'no-tie';
        if (!why) { const bt = { x: v.cx, notes: [], tieFromPrev: true, stem: v }; stemDur(v, bt); bt.ev += '+tie-stem'; m.beats.push(bt); }
        if (why !== 'rest-stem' && why !== 'beat') log({ x: v.cx, y: v.cy, method: 'tab-tied-stem', ok: !why, why });
      });
      m.beats.sort((p, q) => p.x - q.x);
      // 셋잇단: 리듬 아래/위의 "3" → 그 숫자 위에 걸친 빔에 붙은 박들
      texts.filter(t => /^[3]$/.test(t.str) && t.x > m.x0 && t.x < m.x1 && t.y < yb + sp * 0.5 && t.y > yb - sp * 4).forEach(t => {
        const cx = t.x + t.w / 2;
        const bm = beams.filter(b => b.x0 - 1 < cx && b.x1 + 1 > cx).sort((a, b) => a.cy - b.cy)[0];
        // 숫자 가운데에 가장 가까운 3개 (빔이 더 길게 이어져도 셋잇단은 그 3개뿐)
        const pool = bm ? m.beats.filter(b => b.stem && b.stem.cx > bm.x0 - 1 && b.stem.cx < bm.x1 + 1) : m.beats.filter(b => !b.grace);
        const cand = pool.sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx)).slice(0, 3);
        cand.forEach(b => b.trip = true);
      });
      // 스타카토·피킹 기호 (타브 위)
      glyphs.filter(t => (gcode(t) === SMUFL_STAC_A || gcode(t) === SMUFL_STAC_B) && t.x > m.x0 && t.x < m.x1 && t.y > tab.top && t.y < tab.top + sp * 4).forEach(t => {
        const b = m.beats.filter(b => !b.grace).sort((a, c) => Math.abs(a.x - t.x - t.w / 2) - Math.abs(c.x - t.x - t.w / 2))[0]; if (b && Math.abs(b.x - t.x - t.w / 2) < sp) b.stac = true;
      });
      glyphs.filter(t => (gcode(t) === 0xE610 || gcode(t) === 0xE612) && t.x > m.x0 - 2 && t.x < m.x1 && t.y > tab.top && t.y < tab.top + sp * 6).forEach(t => {
        const b = m.beats.filter(b => !b.grace).sort((a, c) => Math.abs(a.x - t.x - t.w / 2) - Math.abs(c.x - t.x - t.w / 2))[0]; if (b && Math.abs(b.x - t.x - t.w / 2) < sp * 1.2) b.srcPick = gcode(t) === 0xE610 ? 'd' : 'u';
      });
      // 쉼표: 타브 안의 쉼표 기호
      glyphs.filter(t => SMUFL_REST[gcode(t)] && t.x > m.x0 && t.x < m.x1 && t.y > tab.bottom - sp && t.y < tab.top + sp).forEach(t => {
        const x = t.x + t.w / 2;
        const nd = dotCount(t.x + t.w * 0.8, t.y - sp * 1.5, t.y + sp * 1.5);
        const r = { x, y: t.y, dur: SMUFL_REST[gcode(t)], dot: nd === 2 ? 2 : nd === 1, known: true, method: 'smufl-tab' };
        m.rests.push(r); log({ x, y: t.y, method: 'smufl-tab', ok: true, dur: r.dur, dot: r.dot });
      });
    });
  }

  // 박자표 글자(SMuFL)로 마디의 박자 읽기
  function tsFromGlyphs(m, tsg) {
    const gcode = t => t.str.charCodeAt(0);
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
  }

  // ---------- 4. 리듬 읽기 (오선보) ----------
  function readRhythm(measures, st, texts, shapes, bx, tab, ceil) {
    const sp = st.sp;
    // 위쪽에 다른 악기 오선이 있으면 그 중간까지만 봄 (다른 오선의 쉼표·음표를 섞지 않도록)
    const zoneTop = ceil ? Math.min(st.top + sp * 7, (st.top + ceil) / 2) : st.top + sp * 7, zoneBot = st.bottom - sp * 7;
    const inZone = s => s.y1 <= zoneTop && s.y0 >= zoneBot;
    const nearBar = x => bx.some(b => Math.abs(b - x) < 1.6);
    const stems = verticals(shapes).filter(v => inZone(v) && v.h > sp * 1.8 && v.h < sp * 14 && !nearBar(v.cx) && !(v.y0 <= st.bottom + 0.5 && v.y1 >= st.top - 0.5 && Math.abs(v.h - (st.top - st.bottom)) < 1));
    const beams = shapes.filter(s => s.kind === 'F' && !s.curve && (s.n === 4 || s.n === 5) && s.w > 2.5 && inZone(s) && s.h < sp * 9 && (() => { const th = beamThick(s); return th > sp * 0.2 && th < sp * 0.9; })());
    const glyphs = texts.filter(t => t.str.length === 1 && t.str.charCodeAt(0) >= 0xE000 && t.y < zoneTop && t.y > zoneBot);
    const gcode = t => t.str.charCodeAt(0);
    // 점(길이 점·스타카토 점 공통 후보): 그림 도형 또는 SMuFL 글자
    const isDot = s => s.kind === 'F' && s.curve && s.w > 1.1 && s.w < sp * 0.6 && s.h > 1.1 && s.h < sp * 0.6 && Math.abs(s.w - s.h) < 0.45;
    const dotPts = shapes.filter(s => isDot(s) && inZone(s)).map(s => ({ x: s.cx, y: s.cy, src: 'vector' }))
      .concat(glyphs.filter(t => gcode(t) === SMUFL_DOT).map(t => ({ x: t.x + t.w / 2, y: t.y, src: 'smufl' })));
    // 음표머리 (임시표·스타카토 판단용)
    // (비브라토 물결 조각처럼 납작한 도형은 머리가 아님: 높이/폭 비율로 거름)
    const heads = shapes.filter(s => s.kind === 'F' && s.curve && s.w > sp * 0.9 && s.w < sp * 1.7 && s.h > sp * 0.6 && s.h < sp * 1.4 && s.h > s.w * 0.55 && inZone(s)).map(s => ({ x0: s.x0, x1: s.x1, x: s.cx, y: s.cy }))
      .concat(glyphs.filter(t => SMUFL_HEAD[gcode(t)]).map(t => ({ x0: t.x, x1: t.x + t.w, x: t.x + t.w / 2, y: t.y })));
    // x0~x1 안의 가장 왼쪽 점에서 시작해 같은 높이로 바로 이어지는 점 개수 (최대 2)
    function dotsAfter(x0, x1, yLo, yHi, skip) {
      const c = dotPts.filter(d => d.x > x0 && d.x < x1 && d.y > yLo && d.y < yHi && !skip(d)).sort((a, b) => a.x - b.x);
      if (!c.length) return { n: 0 };
      let n = 1, last = c[0];
      while (n < 2) {
        const nx = dotPts.find(d => d.x > last.x + sp * 0.35 && d.x < last.x + sp * 1.3 && Math.abs(d.y - c[0].y) < sp * 0.35);
        if (!nx) break; n++; last = nx;
      }
      return { n, first: c[0] };
    }
    const graceStems = verticals(shapes).filter(v => inZone(v) && v.h > sp * 1.2 && v.h <= sp * 1.8);
    const log = e => { if (DBG) DBG.push(Object.assign({ page: CUR_PAGE }, e)); };
    // 박자표
    const tsg = glyphs.filter(t => SMUFL_TS[gcode(t)] !== undefined || gcode(t) === 0xE08A || gcode(t) === 0xE08B);
    const tsShapes = new Set();
    measures.forEach(m => {
      tsFromGlyphs(m, tsg);
      // 그림으로 된 박자표(Guitar Pro 등): 숫자 모양의 구멍 개수로 후보를 만들고, 마디 내용 길이로 최종 결정(importPdf)
      if (!m.tsMark) { const v = vecTimeSig(m, st, shapes, sp); if (v) { m.tsCand = v.cands; m.tsMark = 'vector'; v.shapes.forEach(s => tsShapes.add(s)); log({ x: v.x, y: st.top, method: 'timesig-vector', ok: true, digits: v.digits, cands: v.cands }); } }
      if (!m.tsMark) {
        const big = shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 && s.cx < m.x1 && s.h > sp * 1.6 && s.h < sp * 2.6 && s.w > sp * 1.3 && s.y0 >= st.bottom - 1 && s.y1 <= st.top + 1 && (!m.beats.length || s.cx < m.beats[0].x - sp));
        for (const a of big) for (const b of big) if (a !== b && Math.abs(a.x0 - b.x0) < 1.5 && a.cy > b.cy + sp * 1.5) m.tsMark = 'unknown';
      }
    });
    // 붙임줄/이음줄 후보: 가늘고 납작한 곡선
    const arcs = shapes.filter(s => s.kind === 'F' && s.curve && s.w > sp * 0.8 && s.h < sp * 2.2 && (s.w > s.h * 1.8 || (s.eh < sp * 0.35 && s.w > s.h * 1.2)) && s.cy < st.top + sp * 3 && s.cy > st.bottom - sp * 3);
    // 한 음(기둥·빔·꼬리·머리·점)의 길이 읽기. stem 을 주면 그 기둥을 씀
    function noteAt(x, stem) {
      let best = stem || null, bd = 1e9;
      if (!stem) {
        // 기둥은 음표머리의 오른쪽 끝(위로) 또는 왼쪽 끝(아래로)에 붙음. 머리가 보이면 그 머리에 붙은 기둥을 먼저 고름
        //  (16분음표처럼 촘촘하면 타브 숫자에서 가장 가까운 기둥이 옆 음의 것일 수 있음)
        const hs = heads.filter(h => Math.abs(h.x - x) < sp * 0.9);
        //  위로 난 기둥: 머리 오른쪽 끝 + 기둥 아랫끝이 머리 높이. 아래로 난 기둥: 머리 왼쪽 끝 + 기둥 윗끝이 머리 높이 (화음이면 맨 끝 머리)
        const att = stems.filter(v => hs.some(h => (Math.abs(v.cx - h.x1) < sp * 0.3 && Math.abs(v.y0 - h.y) < sp * 0.7) || (Math.abs(v.cx - h.x0) < sp * 0.3 && Math.abs(v.y1 - h.y) < sp * 0.7)));
        (att.length ? att : stems).forEach(v => { const d = Math.abs(v.cx - x); if (d < Math.max(5.5, sp * 1.4) && d < bd) { bd = d; best = v; } });
      }
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
            // 꼬리 개수: 꼬리를 세로로 자르면 꼬리마다 한 번씩 지나감 (높이는 글꼴마다 달라 보조로만)
            if (fs.length) flags = fs.reduce((a, s) => Math.max(a, flagCount(s, sp, shapes) || (s.h > sp * 4.4 ? 3 : s.h > sp * 3.3 ? 2 : 1)), 0);
          }
        }
      }
      // 머리 모양 (온/2분): 글자 기호, 또는 바깥 도형 안에 구멍(안쪽 도형)이 있으면 빈 머리
      const head = glyphs.filter(t => SMUFL_HEAD[gcode(t)] && Math.abs(t.x + t.w / 2 - x) < sp * 1.5).sort((a, b) => Math.abs(a.x + a.w / 2 - x) - Math.abs(b.x + b.w / 2 - x))[0];
      let headDur = head ? SMUFL_HEAD[gcode(head)] : null;
      if (!head) {
        const outer = shapes.filter(s => s.kind === 'F' && s.curve && Math.abs(s.cx - x) < sp * 1.6 && s.w > sp * 0.9 && s.w < sp * 2 && s.h > sp * 0.7 && s.h < sp * 1.5 && inZone(s));
        const hollow = outer.some(a => shapes.some(b => a !== b && b.kind === 'F' && b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1 && b.w < a.w * 0.9 && b.w > a.w * 0.4 && b.h > a.h * 0.3));
        if (hollow) headDur = 2;
      }
      const r = { stem: best, measured: !!best || !!head };
      if (flags > 0) r.dur = Math.min(32, 4 * Math.pow(2, flags));
      else if (best) r.dur = headDur === 2 ? 2 : 4;
      // 기둥 없는 빈 머리 = 온음표 (글자 기호는 모양 번호를 그대로)
      else r.dur = headDur === 1 ? 1 : headDur === 2 ? (head ? 2 : 1) : null; // 모르면 나중에 박자 합으로 결정
      // 점: 음표 오른쪽 같은 높이에 이어진 점 개수 (1 = 점, 2 = 겹점)
      // 다른 음표머리 바로 위/아래 점(스타카토)은 길이 점으로 세지 않음
      const others = heads.filter(h => Math.abs(h.x - x) > sp);
      const mine = heads.filter(h => Math.abs(h.x - x) < sp * 1.2), hy = mine.map(h => h.y);
      // 점의 높이: 이 음 머리 높이 근처 (덧줄 위 높은 음도 포함). 머리를 못 찾으면 오선 범위
      const yLo = mine.length ? Math.min(...hy) - sp * 0.8 : st.bottom - sp, yHi = mine.length ? Math.max(...hy) + sp * 0.8 : st.top + sp;
      // 다음 음표머리보다 오른쪽 점은 그 음의 것 (간격이 좁을 때 옆 음의 점을 가져오지 않도록)
      // 사이에 다른 기호(쉼표 등 점보다 큰 도형)가 있으면 그 너머의 점도 이 음의 것이 아님
      const nextHead = heads.filter(h => h.x > x + sp * 0.9).reduce((a, h) => Math.min(a, h.x0), Infinity);
      //  (비브라토 물결처럼 납작한 도형은 가로막는 기호가 아님)
      const block = shapes.filter(s => s.kind === 'F' && s.x0 > x + sp * 0.7 && s.x0 < x + sp * 3 && s.w > sp * 0.7 && s.h > sp * 0.3 && s.h > s.w * 0.6 && s.y1 > yLo - sp && s.y0 < yHi + sp && !beams.includes(s)).reduce((a, s) => Math.min(a, s.x0), Infinity);
      const nd = dotsAfter(x + sp * 0.9, Math.min(x + sp * 3, nextHead - sp * 0.1, block), yLo, yHi, d => others.some(h => Math.abs(h.x - d.x) < sp * 0.5));
      r.dot = nd.n === 2 ? 2 : nd.n === 1;
      // 화음 오른쪽에 머리마다 점이 하나씩 세로로 늘어서 있으면 점음표 (꾸밈음 등이 점 위에 겹쳐 그려져 위 검사가 막힌 경우)
      if (!nd.n && mine.length >= 2) {
        const hx = Math.max(...mine.map(h => h.x1));
        const col = dotPts.filter(d => d.x > hx + sp * 0.1 && d.x < hx + sp * 1.0 && mine.some(h => Math.abs(h.y - d.y) < sp * 0.8));
        if (col.length >= mine.length && new Set(col.map(d => Math.round(d.x))).size <= 2) r.dot = true;
      }
      // 스타카토: 이 음의 머리 바로 위나 아래(옆이 아님)에 있는 점
      const own = heads.filter(h => Math.abs(h.x - x) < sp);
      const stG = glyphs.some(t => (gcode(t) === SMUFL_STAC_A || gcode(t) === SMUFL_STAC_B) && Math.abs(t.x + t.w / 2 - x) < sp);
      const stS = own.length && dotPts.some(d => d.src === 'vector' && own.some(h => Math.abs(h.x - d.x) < sp * 0.5 && Math.abs(h.y - d.y) < sp * 2.2) && own.every(h => Math.abs(h.y - d.y) > sp * 0.6));
      r.stac = !!(stG || stS);
      return r;
    }
    // 리듬 빗금(슬래시): 오선 가운데의 기울어진 평행사변형 머리 + 기둥. "앞 화음을 이 리듬으로 다시 치기"
    //  타브 숫자가 없는 자리라 숫자로는 박이 생기지 않으므로 여기서 박을 만듦 (쉼표가 아님)
    const slashes = slashHeads(shapes, s => inZone(s) && s.cy > st.bottom + sp * 0.5 && s.cy < st.top - sp * 0.5, sp);
    // 빗금 머리는 납작한 사각형이라 빔으로 잘못 셀 수 있음 → 빔 목록에서 뺌
    for (let i = beams.length - 1; i >= 0; i--) if (slashes.some(h => Math.abs(h.x0 - beams[i].x0) < 0.05 && Math.abs(h.y0 - beams[i].y0) < 0.05)) beams.splice(i, 1);
    // 박마다 기둥/빔/꼬리
    measures.forEach(m => {
      m.beats.forEach(bt => {
        if (bt.grace) { bt.dur = 8; return; }
        Object.assign(bt, noteAt(bt.x));
      });
      slashes.filter(s => s.cx > m.x0 + 1 && s.cx < m.x1 - 1 && !m.beats.some(b => !b.grace && Math.abs(b.x - s.cx) < sp * 1.2)).forEach(s => {
        // 기둥은 머리 오른쪽 끝(위로) 또는 왼쪽 끝(아래로)에 붙어 있음. 옆 빗금의 기둥과 헷갈리지 않도록 직접 고름
        const v = stems.filter(v => (Math.abs(v.cx - s.x1) < 1 || Math.abs(v.cx - s.x0) < 1) && v.y0 < s.y1 + sp * 0.5 && v.y1 > s.y0 - sp * 0.5).sort((a, b) => Math.min(Math.abs(a.cx - s.x1), Math.abs(a.cx - s.x0)) - Math.min(Math.abs(b.cx - s.x1), Math.abs(b.cx - s.x0)))[0];
        const bt = Object.assign({ x: s.cx, notes: [], slash: true }, noteAt(s.cx, v || undefined));
        if (!v) { bt.dur = s.hollow ? 1 : null; bt.measured = !!s.hollow; } // 기둥 없는 빈 빗금 = 온음표
        else if (s.hollow && !(bt.dur > 4)) bt.dur = 2; // 기둥 + 빈 빗금 = 2분음표
        m.beats.push(bt);
        log({ x: s.cx, y: s.cy, method: 'slash', ok: true, dur: bt.dur, dot: bt.dot, hollow: !!s.hollow });
      });
      m.beats.sort((p, q) => p.x - q.x);
      // 타브 숫자 없이 오선보에만 있는 음 = 붙임줄로 이어진 음 (Guitar Pro는 이어진 음의 숫자를 생략하기도 함)
      // 증거 세 가지가 모두 있어야 넣음: 짝 없는 기둥 + 그 기둥의 음표머리 + 왼쪽 같은 높이 머리에서 오는 붙임줄
      const used = new Set(m.beats.map(b => b.stem).filter(Boolean));
      stems.filter(v => !used.has(v) && v.cx > m.x0 + 2 && v.cx < m.x1 - 2 && v.y0 < st.top + sp * 0.5 && v.y1 > st.bottom - sp * 0.5 && !m.beats.some(b => Math.abs(b.x - v.cx) < Math.max(5.5, sp * 1.4)))
        .forEach(v => {
          // 이 기둥에 붙은 음표머리들 (화음이면 여러 개)
          const sh = heads.filter(h => (Math.abs(h.x1 - v.cx) < sp * 0.4 || Math.abs(h.x0 - v.cx) < sp * 0.4) && h.y > v.y0 - sp * 0.8 && h.y < v.y1 + sp * 0.8);
          const hd = sh[0];
          let why = null;
          // 붙임줄: 같은 높이(같은 음)의 앞 머리에서 이 머리로 오는 곡선. 높이가 다르면 이음줄(슬러)이라 제외
          const tie = hd && arcs.find(c => sh.some(h2 => c.x1 > h2.x - sp * 2 && c.x1 < h2.x + sp * 0.6 && c.x0 < h2.x - sp * 0.8 && Math.abs(c.cy - h2.y) < sp * 1.6 &&
            (c.x0 < st.x0 + sp * 6 || heads.some(h => !sh.includes(h) && h.x > c.x0 - sp * 1.5 && h.x < c.x0 + sp * 0.8 && Math.abs(h.y - h2.y) < sp * 0.3))));
          if (!hd) why = 'no-head'; else if (!tie) why = 'no-tie';
          if (!why) m.beats.push(Object.assign({ x: hd.x, notes: [], tieFromPrev: true }, noteAt(hd.x, v)));
          log({ x: v.cx, y: v.cy, method: 'tied-stem', ok: !why, why });
        });
      m.beats.sort((p, q) => p.x - q.x);
      // 셋잇단: 박들 근처의 "3"
      texts.filter(t => t.str === '3' && t.x > m.x0 + 6 && t.x < m.x1 - 6 && t.y < zoneTop && t.y > zoneBot && t.y > tab.top + tab.sp * 0.8 && (t.y > st.top + sp * 0.5 || t.y < st.bottom - sp * 2.5)).forEach(t => {
        const cand = m.beats.filter(b => !b.grace).sort((a, b) => Math.abs(a.x - t.x) - Math.abs(b.x - t.x)).slice(0, 3);
        cand.forEach(b => b.trip = true);
      });
      // 셋잇단 숫자가 글자가 아니라 그림(도형)인 경우: 오선 밖의 작은 "3" 모양
      shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 + 3 && s.cx < m.x1 - 3 && s.w > sp * 0.6 && s.w < sp * 1.4 && s.h > sp * 0.9 && s.h < sp * 1.7 && inZone(s) && s.cy > tab.top + tab.sp * 0.8 && (s.cy > st.top + sp * 0.5 || s.cy < st.bottom - sp * 1.5) && isDigit3(s, sp, shapes)).forEach(s => {
        const cand = m.beats.filter(b => !b.grace).sort((a, b) => Math.abs(a.x - s.cx) - Math.abs(b.x - s.cx)).slice(0, 3);
        if (cand.length === 3) { cand.forEach(b => { b.trip = true; b.tripEv = 'vector-3'; }); log({ x: s.cx, y: s.cy, method: 'tuplet-3-vector', ok: true }); }
      });
      // 쉼표 ① 글자 기호(SMuFL 글꼴): 모양이 글자 번호로 정해져 있어 확실함
      glyphs.filter(t => SMUFL_REST[gcode(t)] && t.x > m.x0 && t.x < m.x1).forEach(t => {
        const nd = dotsAfter(t.x + t.w * 0.8, t.x + t.w + sp * 1.8, t.y - sp * 2, t.y + sp * 2, () => false);
        const r = { x: t.x + t.w / 2, y: t.y, dur: SMUFL_REST[gcode(t)], dot: nd.n === 2 ? 2 : nd.n === 1, known: true, method: 'smufl' };
        m.rests.push(r); log({ x: r.x, y: r.y, method: 'smufl', ok: true, dur: r.dur, dot: r.dot });
      });
      // 쉼표 ② 그림 기호(곡선 도형: 4/8/16/32분 쉼표). 글자 기호가 있어도 항상 확인하고, 겹치면 하나만 씀
      // 오른쪽부터 보면서 판단 (화음의 임시표는 여러 줄로 왼쪽에 겹쳐 놓이므로)
      const accs = [];
      const quarterRestLike = s => { const r = restShape(s, sp), hr = s.h / sp; return !r.flag && r.hooks >= 1 && hr > 2.2 && hr < 3.8 && s.w < sp * 1.3; };
      const restLike = s => { const r = restShape(s, sp); return r.flag && r.hooks >= 1 && !shapes.some(o => o !== s && o.kind === 'F' && o.x0 >= s.x0 && o.x1 <= s.x1 && o.y0 >= s.y0 && o.y1 <= s.y1 && o.w * o.h > s.w * s.h * 0.02); };
      shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 + 3 && s.cx < m.x1 - 3 && s.h > sp * 1.35 && s.h < sp * 4.6 && s.w > sp * 0.5 && s.w < sp * 1.8 && s.cy > st.bottom - sp * 2 && s.cy < st.top + sp * 2)
        .sort((p, q) => q.cx - p.cx).forEach(s => {
          let why = null;
          const inStaff = s.cy > st.bottom + sp * 0.4 && s.cy < st.top - sp * 0.4; // 쉼표는 오선 안쪽에만
          if (tsShapes.has(s)) why = 'timesig';
          else if (m.sysFirst && s.cx < st.x0 + sp * 5) why = 'clef';
          // 박자표 숫자: 첫 음보다 앞에서 같은 x에 위아래로 2칸쯤 떨어져 쌓인 비슷한 도형
          else if ((!m.beats.length || s.cx < m.beats[0].x - sp * 0.5) && shapes.some(o => o !== s && o.kind === 'F' && o.curve && Math.abs(o.cx - s.cx) < sp * 0.5 && Math.abs(o.w - s.w) < sp * 0.5 && Math.abs(Math.abs(o.cy - s.cy) - sp * 2) < sp * 0.6)) why = 'timesig';
          // 꼬리(깃발): 기둥 끝에 붙어 있음(꾸밈음 꼬리는 사선이 기둥을 가로지름). 옆 음표 기둥과 가깝기만 한 것은 꼬리가 아님
          else if (stems.concat(graceStems).some(v => v.cx > s.x0 - 1.6 && v.cx < s.cx && (Math.abs(s.y1 - v.y1) < sp * 0.45 || Math.abs(s.y0 - v.y0) < sp * 0.45))) why = 'flag';
          // 머리에 닿음 = 음표의 일부(꼬리 등). 단, 4분쉼표 모양이 머리 옆에 살짝 겹친 것(머리 가운데가 도형 밖)은 쉼표로 봄
          else if (heads.some(h => h.x1 > s.x0 - 0.5 && h.x0 < s.x1 + 0.5 && Math.abs(h.y - s.cy) < s.h / 2 + sp * 0.3) &&
            !(quarterRestLike(s) && heads.every(h => !(h.x1 > s.x0 - 0.5 && h.x0 < s.x1 + 0.5 && Math.abs(h.y - s.cy) < s.h / 2 + sp * 0.3) || h.x < s.x0 || h.x > s.x1))) why = 'touches-head';
          // 임시표(♯♭♮): 바로 오른쪽에 같은 높이의 음표머리, 또는 바로 오른쪽에 비슷한 크기의 임시표(화음)
          //  단, 모양이 꼬리 쉼표(왼쪽 위 동그라미 + 사선, 구멍 없음)이면 임시표로 보지 않음 (♯♭♮ 는 가는 획·구멍)
          else if (!restLike(s) && heads.some(h => h.x0 > s.x1 - sp * 0.4 && h.x0 < s.x1 + sp * 1.0 && Math.abs(h.y - s.cy) < sp * 1.1) ||
            accs.some(a => a.x0 > s.x0 + sp * 0.2 && a.x0 < s.x1 + sp * 0.8 && Math.abs(a.cy - s.cy) < sp * 3.5 && Math.abs(a.h / s.h - 1) < 0.2)) { why = 'accidental'; accs.push(s); }
          else if (!inStaff) why = 'ypos';
          // 안쪽에 구멍이 있는 도형 = 임시표(♯♭♮, 꾸밈음의 작은 임시표 포함). 쉼표에는 구멍이 없음
          else if (shapes.some(o => o !== s && o.kind === 'F' && o.x0 >= s.x0 && o.x1 <= s.x1 && o.y0 >= s.y0 && o.y1 <= s.y1 && o.w * o.h > s.w * s.h * 0.02)) why = 'hole';
          else if (m.rests.some(r => Math.abs(r.x - s.cx) < sp)) why = 'duplicate';
          // 이음줄·해머 곡선(가는 초승달 모양): 쉼표 모양 특징(갈고리)이 전혀 없고 칠한 면적이 작음
          else if (fillRatio(s) < 0.2 && restShape(s, sp).hooks === 0) why = 'thin-arc';
          const hr = s.h / sp;
          // 모양으로 종류 구분 (높이만으로는 4분/16분 쉼표가 글꼴에 따라 비슷함)
          //  꼬리 쉼표(8·16·32분): 맨 위에 왼쪽 동그라미 + 오른쪽 사선 끝이 나란히 있음, 동그라미 개수 = 꼬리 수
          //  4분쉼표: 맨 위는 사선 한 줄(동그라미 없음)
          const rs = restShape(s, sp);
          let dur, alt = null;
          if (rs.flag && rs.hooks >= 1 && rs.hooks <= 3) dur = 4 * Math.pow(2, rs.hooks);
          else if (!rs.flag && rs.hooks >= 1 && hr > 2.2 && hr < 3.8) dur = 4; // 4분쉼표: 위는 사선, 아래에 갈고리
          else { dur = hr <= 2.2 ? 8 : hr <= 3.4 ? 4 : 32; alt = hr <= 2.2 ? null : [16]; } // 모양이 애매할 때만 높이로 (후보 기록)
          if (!why) {
            const nd = dotsAfter(s.x1 + sp * 0.1, s.x1 + sp * 1.8, st.bottom - sp, st.top + sp, () => false);
            const r = { x: s.cx, y: s.cy, dur, dot: nd.n === 2 ? 2 : nd.n === 1, known: !alt, alt, method: 'vector-curve' };
            m.rests.push(r);
          }
          if (inStaff) log({ x: s.cx, y: s.cy, w: +(s.w / sp).toFixed(2), h: +hr.toFixed(2), n: s.n, hooks: rs.hooks, flagTop: rs.flag, method: 'vector-curve', ok: !why, why, dur, alt });
        });
      // 쉼표 ③ 그림 기호(납작한 사각형: 온쉼표는 줄에 매달리고, 2분쉼표는 줄 위에 앉음)
      shapes.filter(s => s.kind === 'F' && ((!s.curve && (s.n === 4 || s.n === 5)) || (s.curve && fillRatio(s) > 0.85)) && s.w > sp * 0.8 && s.w < sp * 1.9 && s.h > sp * 0.3 && s.h < sp * 0.75 && s.cx > m.x0 + 3 && s.cx < m.x1 - 3 && s.y0 > st.bottom - sp * 0.1 && s.y1 < st.top + sp * 0.1)
        .forEach(s => {
          const onLine = y => st.lines.some(l => Math.abs(l - y) < sp * 0.15);
          let why = null, dur = null;
          if (Math.abs(beamThick(s) - s.h) > 0.3) why = 'slanted';
          else if (stems.some(v => v.cx > s.x0 - 1.2 && v.cx < s.x1 + 1.2 && v.y0 < s.y1 + sp * 0.3 && v.y1 > s.y0 - sp * 0.3)) why = 'beam';
          else if (onLine(s.y1) && !onLine(s.y0)) dur = 1;
          else if (onLine(s.y0) && !onLine(s.y1)) dur = 2;
          else why = 'not-on-line';
          if (!why && m.rests.some(r => Math.abs(r.x - s.cx) < sp)) why = 'duplicate';
          if (!why) {
            const nd = dotsAfter(s.x1 + sp * 0.1, s.x1 + sp * 1.8, st.bottom - sp, st.top + sp, () => false);
            m.rests.push({ x: s.cx, y: s.cy, dur, dot: nd.n === 2 ? 2 : nd.n === 1, known: true, method: 'vector-rect' });
          }
          log({ x: s.cx, y: s.cy, w: +(s.w / sp).toFixed(2), h: +(s.h / sp).toFixed(2), method: 'vector-rect', ok: !why, why, dur });
        });
    });
  }
  // 도형 안쪽인지 (짝홀 규칙)
  function inPoly(P, x, y) {
    let c = false;
    for (let k = 0, l = P.length - 1; k < P.length; l = k++) { const xi = P[k][0], yi = P[k][1], xj = P[l][0], yj = P[l][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c;
  }
  // 도형 넓이 / 둘레 사각형 넓이 (사각형이면 1에 가까움)
  function fillRatio(s) {
    const P = s.poly || s.pts; let a = 0;
    for (let k = 0, l = P.length - 1; k < P.length; l = k++) a += (P[l][0] + P[k][0]) * (P[l][1] - P[k][1]);
    return s.w * s.h > 0 ? Math.abs(a / 2) / (s.w * s.h) : 0;
  }
  // 쉼표 모양 특징: 작은 격자로 칠해 보고 줄마다 칠해진 구간 수를 셈
  //  hooks = 왼쪽에 넓은 덩어리 + 오른쪽 사선이 따로 있는 줄 묶음 수 (꼬리 쉼표의 동그라미 개수)
  //  flag = 맨 위 20% 안에 이런 줄이 있음 (4분쉼표는 맨 위가 한 줄짜리 사선)
  function restShape(s, sp) {
    const P = s.poly || s.pts, res = sp / 20, W = Math.max(1, Math.ceil(s.w / res)), H = Math.max(1, Math.ceil(s.h / res));
    let hooks = 0, inGroup = false, flag = false, gap = 0;
    for (let j = H - 1; j >= 0; j--) {
      const y = s.y0 + (j + 0.5) * res; const runs = []; let st = -1;
      for (let i = 0; i <= W; i++) { const on = i < W && inPoly(P, s.x0 + (i + 0.5) * res, y); if (on && st < 0) st = i; if (!on && st >= 0) { runs.push([st, i]); st = -1; } }
      const two = runs.length >= 2 && runs[0][1] - runs[0][0] >= W * 0.25 && runs[0][0] <= W * 0.5;
      if (two && !inGroup) hooks++;
      if (two) { inGroup = true; gap = 0; } else if (++gap >= 5) inGroup = false; // 잠깐 끊긴 줄은 같은 덩어리로
      if (two && j >= H * 0.8) flag = true;
    }
    return { hooks, flag };
  }
  // 꼬리 도형을 세로선 몇 개로 잘라 지나가는 칠한 구간 수 (가장 많이 나온 값). 1~3 이 아니면 0 (모름)
  function flagCount(s, sp, all) {
    const P = s.poly || s.pts, res = sp / 20, cnt = {};
    // 같은 글자 안의 구멍(안쪽 도형)은 빼고 셈 (16분 꼬리는 바깥 윤곽 + 구멍으로 그려지기도 함)
    const holes = (all || []).filter(o => o !== s && o.kind === 'F' && o.x0 >= s.x0 - 0.2 && o.x1 <= s.x1 + 0.2 && o.y0 >= s.y0 - 0.2 && o.y1 <= s.y1 + 0.2 && o.w * o.h < s.w * s.h * 0.8).map(o => o.poly || o.pts);
    const inside = (x, y) => holes.reduce((c, H) => inPoly(H, x, y) ? !c : c, inPoly(P, x, y));
    [0.35, 0.5, 0.65].forEach(f => {
      const x = s.x0 + s.w * f; let n = 0, on = false;
      for (let y = s.y0 + res / 2; y < s.y1; y += res) { const c = inside(x, y); if (c && !on) n++; on = c; }
      cnt[n] = (cnt[n] || 0) + 1;
    });
    const best = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    return best >= 1 && best <= 3 ? best : 0;
  }
  // 그림으로 된 숫자 "3" 판단: 구멍 없음, 가운데 세로선이 칠한 곳을 3번 지남(위·가운데·아래 획),
  // 맨 위/아래가 꽉 찬 가로획이 아님(2·5·7 제외)
  function isDigit3(s, sp, all) {
    if (all.some(o => o !== s && o.kind === 'F' && o.x0 >= s.x0 && o.x1 <= s.x1 && o.y0 >= s.y0 && o.y1 <= s.y1 && o.w > s.w * 0.15 && o.h > s.h * 0.1)) return false;
    const P = s.poly || s.pts, res = s.h / 40;
    const vRuns = f => { const x = s.x0 + s.w * f; let n = 0, on = false; for (let y = s.y0 + res / 2; y < s.y1; y += res) { const c = inPoly(P, x, y); if (c && !on) n++; on = c; } return n; };
    const hFill = f => { const y = s.y0 + s.h * f; let k = 0; const N = 30; for (let i = 0; i < N; i++) if (inPoly(P, s.x0 + (i + 0.5) * s.w / N, y)) k++; return k / N; };
    return (vRuns(0.5) === 3 || vRuns(0.55) === 3) && hFill(0.06) < 0.72 && hFill(0.94) < 0.72;
  }
  // 기울어진 평행사변형(리듬 빗금 머리): 점 4개, 왼쪽 끝 점들과 오른쪽 끝 점들의 높이가 크게 다름
  //  안쪽에 같은 모양이 하나 더 있으면 빈 빗금(2분·온음표)
  function slashHeads(shapes, zone, sp) {
    const isSl = s => {
      if (s.kind !== 'F' || s.curve || s.n !== 4 || s.w < sp * 0.9 || s.w > sp * 2.2 || s.h < sp * 1.2 || s.h > sp * 2.6) return false;
      const P = s.pts, L = P.filter(p => p[0] < s.x0 + s.w * 0.25), R = P.filter(p => p[0] > s.x1 - s.w * 0.25);
      if (!L.length || !R.length) return false;
      const ly = L.reduce((a, p) => a + p[1], 0) / L.length, ry = R.reduce((a, p) => a + p[1], 0) / R.length;
      return ry - ly > s.h * 0.45; // 왼쪽 아래 → 오른쪽 위
    };
    // 기울어진 빔(두 음을 잇는 굵은 사선)도 같은 모양 → 양쪽 끝에 모두 기둥이 닿아 있으면 빔 (빗금은 한쪽 끝에만 기둥)
    const vs = shapes.filter(v => !v.curve && v.w < 1.3 && v.h > sp * 0.8);
    //  (기둥 끝이 그 자리의 사선 높이에 딱 닿아야 함: 옆 빗금의 기둥이 스쳐 지나가는 것은 세지 않음)
    const stemAt = (s, left) => {
      const x = left ? s.x0 : s.x1, P = s.pts.filter(p => Math.abs(p[0] - x) < s.w * 0.25), lo = Math.min(...P.map(p => p[1])), hi = Math.max(...P.map(p => p[1]));
      return vs.some(v => Math.abs(v.cx - x) < 1 && ((v.y0 > lo - 1 && v.y0 < hi + 1) || (v.y1 > lo - 1 && v.y1 < hi + 1)));
    };
    const c = shapes.filter(s => isSl(s) && zone(s) && !(stemAt(s, true) && stemAt(s, false)));
    const inner = new Set(c.filter(s => c.some(o => o !== s && o.x0 <= s.x0 + 0.1 && o.x1 >= s.x1 - 0.1 && o.y0 <= s.y0 + 0.1 && o.y1 >= s.y1 - 0.1 && o.w * o.h > s.w * s.h * 1.05)));
    return c.filter(s => !inner.has(s)).map(s => ({ x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1, cx: s.cx, cy: s.cy, hollow: [...inner].some(o => o.x0 >= s.x0 - 0.1 && o.x1 <= s.x1 + 0.1 && o.y0 >= s.y0 - 0.1 && o.y1 <= s.y1 + 0.1) }));
  }
  // 템포 기호의 기준 음표: "=" 왼쪽의 음표 도형. 꼬리가 있으면 8분, 빈 머리면 2분, 오른쪽에 점이 있으면 점음표
  //  꼬리 판단: 도형 위쪽 1/3 높이에서 기둥보다 넓게 칠해진 부분이 있는지 (4분음표는 기둥만)
  function tempoUnit(shapes, texts, eq) {
    const y0 = eq.y - eq.h * 0.6, y1 = eq.y + eq.h * 1.6;
    const near = shapes.filter(s => s.kind === 'F' && s.x1 <= eq.x + 0.5 && s.x0 > eq.x - eq.h * 2.2 && s.y0 > y0 && s.y1 < y1);
    const glyph = near.filter(s => s.h > eq.h * 0.6).sort((a, b) => b.x1 - a.x1)[0];
    const res = { unit: 4, dot: false };
    if (!glyph) {
      // 글자(SMuFL) 음표 기호
      const g = texts.find(t => t.str.length === 1 && Math.abs(t.y - eq.y) < 3 && t.x < eq.x && t.x > eq.x - 30 && /[\uE1D2-\uE1D9\u2669\u266A]/.test(t.str));
      if (g) { const c = g.str.charCodeAt(0); res.unit = c === 0xE1D3 || c === 0xE1D2 ? 2 : c === 0xE1D7 || c === 0xE1D8 || c === 0x266A ? 8 : 4; res.dot = texts.some(t => t.str.charCodeAt(0) === 0xE1E7 && t.x > g.x && t.x < eq.x); }
      return res;
    }
    const P = glyph.poly || glyph.pts, N = 30, M = 30;
    const at = (i, j) => inPoly(P, glyph.x0 + (i + 0.5) * glyph.w / N, glyph.y0 + (j + 0.5) * glyph.h / M);
    // 기둥 = 세로로 가장 길게 칠해진 열. 꼬리 = 머리보다 위(높이 35~90%)에서 기둥 오른쪽에 칠해진 부분
    let stemI = 0, bestC = -1;
    for (let i = 0; i < N; i++) { let c = 0; for (let j = 0; j < M; j++) if (at(i, j)) c++; if (c > bestC) { bestC = c; stemI = i; } }
    let flagCells = 0;
    for (let j = Math.floor(M * 0.35); j < Math.floor(M * 0.9); j++) for (let i = stemI + 3; i < N; i++) if (at(i, j)) flagCells++;
    const top = flagCells / (N * M * 0.55);
    const holes = shapes.filter(o => o !== glyph && o.kind === 'F' && o.x0 >= glyph.x0 && o.x1 <= glyph.x1 && o.y0 >= glyph.y0 && o.y1 <= glyph.y1 && o.y1 < glyph.y0 + glyph.h * 0.45);
    if (holes.length) res.unit = 2;
    else if (top > 0.03) res.unit = 8;
    res.dot = near.some(s => s !== glyph && s.x0 > glyph.x1 && s.w < eq.h * 0.35 && s.h < eq.h * 0.35 && Math.abs(s.w - s.h) < 0.6);
    return res;
  }
  // 그림(도형)으로 그린 박자표 숫자 읽기. 숫자 모양을 구멍으로 구분: 구멍 2개 = 8, 1개 = 0/4/6/9(구멍 위치), 0개 = 1/2/3/5/7
  //  0개짜리는 모양만으로 확실히 구분하지 않고 후보로 남김 → 마디 내용 길이와 맞는 후보를 고름
  function vecTimeSig(m, st, shapes, sp) {
    const firstX = m.beats.length ? Math.min(...m.beats.map(b => b.x)) : m.x1;
    const mid = (st.top + st.bottom) / 2;
    const big = shapes.filter(s => s.kind === 'F' && s.curve && s.cx > m.x0 && s.cx < firstX - sp * 0.8 && s.h > sp * 1.6 && s.h < sp * 2.6 && s.w > sp * 0.6 && s.w < sp * 2.2);
    const isInner = s => shapes.some(o => o !== s && o.kind === 'F' && o.x0 <= s.x0 && o.x1 >= s.x1 && o.y0 <= s.y0 && o.y1 >= s.y1 && o.w * o.h > s.w * s.h * 1.2);
    const up = big.filter(s => s.y0 >= mid - sp * 0.6 && s.y1 <= st.top + sp * 0.6 && !isInner(s)).sort((a, b) => a.x0 - b.x0);
    const lo = big.filter(s => s.y1 <= mid + sp * 0.6 && s.y0 >= st.bottom - sp * 0.6 && !isInner(s)).sort((a, b) => a.x0 - b.x0);
    if (!up.length || !lo.length || up.length > 2 || lo.length > 2) return null;
    // 위아래 숫자가 같은 자리(가로로 겹침)에 있어야 박자표
    const span = g => [Math.min(...g.map(s => s.x0)), Math.max(...g.map(s => s.x1))];
    const [ua, ub] = span(up), [la, lb] = span(lo);
    if (Math.min(ub, lb) - Math.max(ua, la) < Math.min(ub - ua, lb - la) * 0.5) return null;
    const digit = s => {
      const holes = shapes.filter(o => o !== s && o.kind === 'F' && o.x0 >= s.x0 - 0.1 && o.x1 <= s.x1 + 0.1 && o.y0 >= s.y0 - 0.1 && o.y1 <= s.y1 + 0.1 && o.w * o.h < s.w * s.h * 0.6 && o.w > s.w * 0.15);
      if (holes.length >= 2) return [8];
      if (holes.length === 1) {
        const h = holes[0], rel = (h.cy - s.y0) / s.h;
        if (!h.curve) return [4];
        if (h.h > s.h * 0.55) return [0];
        return rel < 0.45 ? [6] : rel > 0.55 ? [9] : [0, 4];
      }
      // 구멍 없는 숫자: 가로 획(맨 아래·맨 위가 꽉 참)과 가운데 세로선이 지나는 획 수로 구분
      const P = s.poly || s.pts, res = s.h / 40;
      const vRuns = f => { const x = s.x0 + s.w * f; let n = 0, on = false; for (let y = s.y0 + res / 2; y < s.y1; y += res) { const c = inPoly(P, x, y); if (c && !on) n++; on = c; } return n; };
      const hFill = f => { const y = s.y0 + s.h * f; let k = 0; const N = 30; for (let i = 0; i < N; i++) if (inPoly(P, s.x0 + (i + 0.5) * s.w / N, y)) k++; return k / N; };
      // 아래·위 25% 안에서 가장 넓게 칠해진 가로줄 (2는 아래, 5·7은 위에 꽉 찬 가로 획)
      const band = (a, b) => { let mx = 0; for (let f = a; f <= b; f += 0.025) mx = Math.max(mx, hFill(f)); return mx; };
      const vr = Math.max(vRuns(0.5), vRuns(0.55)), bot = band(0.03, 0.28), top = band(0.72, 0.97);
      if (s.w < s.h * 0.62 && vr <= 1) return [1];
      if (bot > 0.85 && top < 0.85) return [2];
      if (top > 0.85 && bot < 0.85) return vr >= 3 ? [5] : [7];
      if (vr === 3 && top < 0.85 && bot < 0.85) return [3];
      return [1, 2, 3, 5, 7];
    };
    const nums = g => { let out = ['']; g.forEach(s => { const d = digit(s); out = out.flatMap(p => d.map(x => p + x)); }); return out.map(Number).filter(n => n > 0); };
    const dens = nums(lo).filter(d => [1, 2, 4, 8, 16, 32].includes(d));
    // 흔한 박자표 순서 (모양으로 못 가른 후보끼리는 이 순서로 우선)
    const COMMON = [4, 3, 6, 2, 12, 5, 7, 9, 8, 1, 10, 11, 13, 14, 15, 16];
    const cands = []; nums(up).filter(n => n <= 16).sort((a, b) => COMMON.indexOf(a) - COMMON.indexOf(b)).forEach(n => dens.forEach(d => cands.push([n, d])));
    if (!cands.length) return null;
    return { cands, shapes: up.concat(lo), x: ua, digits: up.map(digit).map(d => d.join('|')).join(',') + '/' + lo.map(digit).map(d => d.join('|')).join(',') };
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
    // 해머/풀 ② 글자 없이 타브 숫자 위(또는 아래)에 그린 이음 곡선(슬러).
    //  곡선 양 끝이 같은 줄의 두 숫자 위에 있고 프렛이 다르면 해머/풀 (같은 프렛이면 붙임줄이라 제외)
    //  곡선이 숫자 여러 개에 걸치면 그 사이 음들도 모두 이어서 침 (예: 7 10 7 = 해머 + 풀)
    const strY = k => tab.top - k * sp;
    shapes.filter(c => c.kind === 'F' && c.curve && c.eh !== undefined && c.eh < sp * 0.35 && c.w > sp * 0.45 && c.w < sp * 12 && c.h < sp * 1.5 && c.h > 0.3 && c.cy > tab.bottom - sp * 1.2 && c.cy < tab.top + sp * 1.5).forEach(c => {
      for (let k = 0; k < 6; k++) {
        const y = strY(k);
        // 곡선이 이 줄 바로 위(0~1.2칸) 또는 바로 아래에 있어야 함
        if (!((c.y0 > y - sp * 0.1 && c.y0 < y + sp * 1.2) || (c.y1 < y + sp * 0.1 && c.y1 > y - sp * 1.2))) continue;
        const row = all.filter(n => n.s === k && !n.beat.grace).sort((a, b) => a.x - b.x);
        const a = row.filter(n => Math.abs(n.x - c.x0) < sp * 0.9).sort((p, q) => Math.abs(p.x - c.x0) - Math.abs(q.x - c.x0))[0];
        const b = row.filter(n => Math.abs(n.x - c.x1) < sp * 0.9).sort((p, q) => Math.abs(p.x - c.x1) - Math.abs(q.x - c.x1))[0];
        if (!a || !b || a === b) continue;
        const seg = row.filter(n => n.x >= a.x && n.x <= b.x);
        if (seg.every(n => n.f === a.f)) break; // 같은 프렛 = 붙임줄
        // 곡선 위에 "sl." 이 있으면 해머/풀이 아니라 이어지는 슬라이드
        const sl = texts.some(t => /^sl\.?$/i.test(t.str) && t.x + t.w / 2 > c.x0 - sp && t.x + t.w / 2 < c.x1 + sp && t.y > c.y0 - sp && t.y < tab.top + sp * 7);
        for (let i = 0; i + 1 < seg.length; i++) {
          if (seg[i + 1].f === seg[i].f || seg[i + 1].paren) continue;
          if (sl || seg[i].slide) seg[i].slide = 'to'; else seg[i].hp = true;
        }
        if (DBG) DBG.push({ page: CUR_PAGE, x: c.cx, y: c.cy, method: sl ? 'slur-slide' : 'slur-hp', ok: true, notes: seg.map(n => n.f).join('-') });
        break;
      }
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
  const dotMul = d => d === 2 ? 1.75 : d ? 1.5 : 1;
  const tk = b => (b.grace || !b.dur) ? 0 : TK[b.dur] * dotMul(b.dot) * (b.trip ? 2 / 3 : 1);
  const rtk = r => TK[r.dur] * dotMul(r.dot);
  // 간격으로 길이 추측: 악보 프로그램은 긴 음일수록 뒤에 빈 공간을 많이 둬요.
  // 간격^k 비율로 나누고, 실제 음표 길이로 반올림한 뒤 합이 딱 맞게 조정.
  const QV = [1920, 1440, 960, 720, 480, 360, 240, 180, 120, 60];
  const T2D = { 1920: [1, 0], 1440: [2, 1], 960: [2, 0], 720: [4, 1], 480: [4, 0], 360: [8, 1], 240: [8, 0], 180: [16, 1], 120: [16, 0], 60: [32, 0] };
  // 원본에서 확실히 읽은 쉼표(fixed)는 길이를 바꾸지 않고, 나머지 길이만 간격으로 나눔
  function quantizeBySpacing(items, m, cap) {
    const all = items.filter(it => !(it.b && it.b.grace));
    const isFixed = it => it.rest && it.rest.known;
    const allGaps = all.map((it, i) => (i + 1 < all.length ? all[i + 1].x : m.x1) - it.x);
    if (allGaps.length > 1) { const mx = Math.max(...allGaps.slice(0, -1)); allGaps[allGaps.length - 1] = Math.min(allGaps[allGaps.length - 1] * 0.85, mx * 2.2); }
    const real = all.filter(it => !isFixed(it));
    const gaps = all.map((it, i) => allGaps[i]).filter((g, i) => !isFixed(all[i]));
    cap -= all.filter(isFixed).reduce((a, it) => a + rtk(it.rest), 0);
    if (!real.length || cap < real.length * 60) return false;
    for (let i = 0; i < gaps.length; i++) gaps[i] = Math.max(1, gaps[i]);
    let best = null;
    for (const k of [1, 1.35, 1.7, 2.1]) {
      const w = gaps.map(g => Math.pow(g, k)), ws = w.reduce((a, b) => a + b, 0);
      const raw = w.map(v => v / ws * cap);
      const q = raw.map(r => QV.reduce((a, v) => Math.abs(Math.log(v / r)) < Math.abs(Math.log(a / r)) ? v : a, QV[0]));
      let diff = cap - q.reduce((a, b) => a + b, 0), guard = 0;
      while (diff !== 0 && guard++ < 300) {
        let mv = null;
        q.forEach((v, i) => {
          const j = QV.indexOf(v), nv = diff > 0 ? QV[j - 1] : QV[j + 1];
          if (!nv || Math.abs(nv - v) > Math.abs(diff)) return;
          const cost = Math.abs(Math.log(nv / raw[i])) - Math.abs(Math.log(v / raw[i]));
          if (!mv || cost < mv.cost) mv = { i, nv, cost };
        });
        if (!mv) break;
        diff -= mv.nv - q[mv.i]; q[mv.i] = mv.nv;
      }
      if (diff !== 0) continue;
      const err = q.reduce((a, v, i) => a + Math.abs(Math.log(v / raw[i])), 0) + new Set(q).size * 0.15;
      if (!best || err < best.err) best = { err, q };
    }
    if (!best) return false;
    real.forEach((it, i) => { const [d, dot] = T2D[best.q[i]]; const tgt = it.b || it.rest; tgt.dur = d; tgt.dot = !!dot; tgt.trip = false; });
    return true;
  }
  // 원칙: 원본에서 읽은 길이(기둥·빔·꼬리·점·확실한 쉼표)는 바꾸지 않는다.
  // 박자 합이 안 맞으면 고치지 않고 "확인 필요" 표시와 이유만 남긴다.
  // 바꾸는 경우는 (1) 리듬 정보가 아예 없는 마디(간격으로 추측), (2) 길이를 못 읽은 음,
  // (3) 모양이 애매한 쉼표(4분/16분 후보) 중 박자 합에 맞는 쪽 고르기 뿐이고, 모두 이유를 기록한다.
  const tickName = t => { const q = t / 480; return (Math.round(q * 100) / 100) + '박'; };
  function fitMeasure(m, cap, warnings, label) {
    const why = m.why = [];
    let items = m.beats.map(b => ({ x: b.x, b }));
    m.rests.forEach(r => {
      if (!m.beats.some(b => Math.abs(b.x - r.x) < 3)) items.push({ x: r.x, rest: r });
      else why.push('음표와 같은 자리에 있는 쉼표 1개는 다른 성부로 보고 뺐어요');
    });
    items.sort((a, b) => a.x - b.x);
    const sum = () => items.reduce((a, it) => a + (it.b ? tk(it.b) : rtk(it.rest)), 0);
    // 온쉼표 하나뿐인 마디 = 마디 전체를 쉼 (3/4 등에서도)
    if (items.length === 1 && items[0].rest && items[0].rest.dur === 1 && !items[0].rest.dot && cap !== 1920 && T2D[cap]) {
      const [d, dot] = T2D[cap]; items[0].rest.dur = d; items[0].rest.dot = !!dot;
    }
    let s = sum();
    const unkB = m.beats.filter(b => !b.grace && !b.dur);
    if (unkB.length && !m.beats.some(b => b.measured)) {
      // 오선보 리듬 정보가 없음(타브만 있는 악보 등): 간격으로 추측
      if (quantizeBySpacing(items, m, cap)) { m.spaced = true; why.push('오선보 리듬이 없어서 숫자 간격으로 길이를 추측했어요'); }
      else { unkB.forEach(b => { b.dur = 8; b.guessDur = true; }); why.push('오선보 리듬이 없어서 길이를 8분음표로 임시로 넣었어요'); }
      m.guessed = true; s = sum();
    } else if (unkB.length) {
      // 기둥을 못 찾은 음: 남은 길이를 똑같이 나눠서 딱 떨어질 때만 그 값, 아니면 8분 임시
      const each = (cap - s) / unkB.length;
      let d = [1, 2, 4, 8, 16, 32].find(d => Math.abs(TK[d] - each) < 1), dot = false;
      if (!d) { d = [1, 2, 4, 8, 16, 32].find(d => Math.abs(TK[d] * 1.5 - each) < 1); dot = !!d; }
      unkB.forEach(b => { b.dur = d || 8; b.dot = dot; b.guessDur = true; });
      why.push(`길이를 못 읽은 음 ${unkB.length}개는 ${d ? '남은 길이로 나눴어요' : '8분음표로 임시로 넣었어요'}`);
      m.guessed = true; s = sum();
    }
    // 모양이 애매한 쉼표: 기록된 후보 길이 중에서만 고름 (다른 음 길이는 그대로)
    const unc = items.filter(it => it.rest && it.rest.alt);
    if (s !== cap && unc.length && unc.length <= 6) {
      const opts = unc.map(it => [it.rest.dur, ...it.rest.alt]);
      const base = s - unc.reduce((a, it) => a + rtk(it.rest), 0);
      let best = null;
      const rec = (i, acc, pick, changes) => {
        if (i === unc.length) { if (acc === cap && (!best || changes < best.changes)) best = { pick: pick.slice(), changes }; return; }
        opts[i].forEach((d, k) => { pick.push(d); rec(i + 1, acc + TK[d] * dotMul(unc[i].rest.dot), pick, changes + (k ? 1 : 0)); pick.pop(); });
      };
      rec(0, base, [], 0);
      if (best && best.changes) {
        unc.forEach((it, i) => { it.rest.dur = best.pick[i]; });
        why.push('모양이 애매한 쉼표(4분/16분 등)의 길이를 박자 합에 맞는 쪽으로 골랐어요');
        m.guessed = true; s = sum();
      }
    }
    m.items = items;
    m.sum = s;
    if (s !== cap && m.beats.length) {
      why.push(`박자 합이 ${s > cap ? '넘쳐요' : '모자라요'} (${tickName(s)} / ${tickName(cap)}). 원본에서 읽은 길이는 그대로 두었어요`);
      warnings.push(label);
    }
  }

  // ---------- 메인 ----------
  async function importPdf(pdfjsLib, data, onProgress, opts) {
    DBG = opts && opts.debug ? [] : null;
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    let imgPages = 0;
    const sysList = []; const meta = { title: '', artist: '', bpm: 100, tuning: 'standard' };
    for (let p = 1; p <= doc.numPages; p++) {
      if (onProgress) onProgress(p, doc.numPages);
      const page = await doc.getPage(p); CUR_PAGE = p;
      const { texts, shapes, images } = await readPage(pdfjsLib, page);
      // 글자·선 없이 그림만 있는 쪽 = 스캔/사진 PDF로 추정
      if (images && shapes.length < 20 && texts.length < 5) imgPages++;
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
        // 템포: "=" 바로 뒤 숫자. "=" 는 조율 표시(①=E♭)에도 있으므로 숫자가 붙은 것만
        const nextNum = eq => texts.filter(t => Math.abs(t.y - eq.y) < 2 && t.x > eq.x && t.x < eq.x + 40 && /^\d{2,3}$/.test(t.str)).sort((a, b) => a.x - b.x)[0];
        const eq = texts.find(t => /^=\s*\d{2,3}/.test(t.str)) || texts.find(t => t.str === '=' && nextNum(t));
        if (eq) {
          const m1 = eq.str.match(/(\d{2,3})/), nx = nextNum(eq);
          const val = m1 ? +m1[1] : nx ? +nx.str : null;
          if (val) {
            // "=" 왼쪽의 음표 기호로 기준 음표(4분/8분/점4분) 판단 → 앱의 빠르기는 4분음표 기준으로 바꿈
            const u = tempoUnit(shapes, texts, eq);
            meta.tempo = { unit: u.unit, dot: u.dot, value: val };
            meta.bpm = Math.round(val * (4 / u.unit) * (u.dot ? 1.5 : 1));
          }
        }
        const tun = texts.map(t => t.str).join(' ');
        if (/drop\s*d/i.test(tun)) meta.tuning = 'dropD';
        else if (/drop\s*c/i.test(tun)) meta.tuning = 'dropC';
        else if (/(half|1\/2)\s*step\s*down|tune\s*down\s*(half|1\/2)|E♭|Eb\s*tuning|반음\s*(내림|다운)/i.test(tun)) meta.tuning = 'halfDown';
        else if (/(full|whole|1)\s*step\s*down|tune\s*down\s*(full|whole|1)\s*step|D\s*standard|온음\s*(내림|다운)/i.test(tun)) meta.tuning = 'wholeDown';
      }
      // 시스템별로 첫 번째 타브만 사용 (여러 악기가 있으면 맨 위 기타)
      const seen = [];
      tabs.forEach(tab => {
        const std = staves.filter(s => s.type === 'std' && s.bottom > tab.top && s.bottom - tab.top < tab.sp * 20 && s.x0 < tab.x0 + 30 && s.x1 > tab.x1 - 30).sort((a, b) => a.bottom - b.bottom)[0];
        // 오선보 바로 위 다른 오선(보컬 등)의 아래줄 높이
        const above = std && staves.filter(s => s !== std && s.type === 'std' && s.bottom > std.top + 1).sort((a, b) => a.bottom - b.bottom)[0];
        const ms = parseSystem(tab, std, texts, shapes, { ceil: above ? above.bottom : null });
        ms.forEach(m => { m.page = p; m.sysTop = std ? std.top : tab.top; m.sysBot = tab.bottom; });
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
    if (meta.tempo && (meta.tempo.unit !== 4 || meta.tempo.dot)) song.tempoMark = meta.tempo; // 원본 템포 표기 (예: ♪ = 154)
    song.view.perLine = 4;
    const allM = []; sysList.forEach(s => s.measures.forEach(m => allM.push(m)));
    if (!allM.length) throw new Error(imgPages ? 'SCANNED' : 'NO_TAB');
    // 박자표 결정
    const rawSum = m => m.beats.reduce((a, b) => a + tk(b), 0) + m.rests.filter(r => !m.beats.some(b => Math.abs(b.x - r.x) < 3)).reduce((a, r) => a + rtk(r), 0);
    let ts = null;
    // 그림 박자표: 숫자 모양 후보 중 이 마디 내용 길이와 맞는 것 (하나로 정해질 때만). 아니면 주변 마디로 추정 + 확인 표시
    allM.forEach(m => {
      if (m.tsMark !== 'vector') return;
      const r = rawSum(m), hit = m.tsCand.filter(c => c[0] * 1920 / c[1] === r);
      if (m.tsCand.length === 1) m.tsMark = m.tsCand[0];
      else if (hit.length === 1) m.tsMark = hit[0];
      else {
        // 이 마디 내용이 어떤 후보와도 안 맞음(인식 오류 가능) → 다음 박자표 전까지 뒤 마디들의 길이와 맞는 후보, 없으면 가장 흔한 후보
        const k0 = allM.indexOf(m), win = [];
        for (let k = k0 + 1; k < allM.length && k < k0 + 8 && !allM[k].tsMark; k++) win.push(rawSum(allM[k]));
        const score = c => win.filter(x => x === c[0] * 1920 / c[1]).length;
        const pick = m.tsCand.slice().sort((a, b) => score(b) - score(a))[0];
        m.tsMark = pick;
        m.tsWhy = `박자표 숫자를 모양만으로 확실히 못 읽어서 ${pick.join('/')}박자로 읽었어요 (다른 후보: ${m.tsCand.filter(c => c !== pick).slice(0, 4).map(c => c.join('/')).join(', ')})`;
      }
    });
    const firstMark = allM.find(m => Array.isArray(m.tsMark));
    const sums = allM.map(rawSum).filter(x => x > 0 && x % 240 === 0);
    const counts = {}; sums.forEach(x => counts[x] = (counts[x] || 0) + 1);
    const modeSum = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 1920;
    ts = firstMark ? firstMark.tsMark : (modeSum % 480 === 0 ? [modeSum / 480, 4] : [modeSum / 240, 8]);
    song.ts = ts;
    const warnings = [];
    let curTs = ts, prevNotes = null;
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
      if (m.tsWhy) { m.why.push(m.tsWhy); m.guessed = true; }
      // 오선보 빗금 수와 타브 빗금 수가 다르면 확인 필요
      if (m.tabSlashes != null) { const ns = m.beats.filter(b => b.slash).length; if (ns !== m.tabSlashes) { m.why.push(`빗금(리듬 슬래시) 개수가 오선보 ${ns}개, 타브 ${m.tabSlashes}개로 달라요`); m.guessed = true; } }
      if (DBG) DBG.push({ measure: i + 1, page: m.page, x0: m.x0, x1: m.x1, top: m.sysTop, bottom: m.sysBot, why: m.why });
      const nm = newMeasure();
      const prevTs = i === 0 ? null : (song.measures[i - 1] && measureTs(song, i - 1));
      if (i === 0) { song.ts = curTs; if (pickup) nm.ts = pickup; }
      else if (!prevTs || prevTs[0] !== curTs[0] || prevTs[1] !== curTs[1]) nm.ts = curTs.slice();
      if (m.guessed || warnings.includes(i + 1)) { nm.check = true; if (m.why.length) nm.checkWhy = m.why.slice(); }
      if (m.section) nm.section = m.section;
      m.items.forEach(it => {
        // dm = 원본에서 읽은 길이 → 편집기의 자동 리듬 맞춤이 몰래 바꾸지 않음
        if (it.rest) { const b = newBeat(it.rest.dur); b.dot = it.rest.dot === 2 ? 2 : !!it.rest.dot; if (!m.spaced) b.dm = true; nm.beats.push(b); return; }
        const src = it.b; const b = newBeat(src.dur || 8); b.dot = src.dot === 2 ? 2 : !!src.dot; b.trip = !!src.trip; if (src.grace) b.grace = true;
        if (!src.grace && src.measured && !src.guessDur && !m.spaced) b.dm = true;
        if (src.srcPick) b.pick = src.srcPick; // 원본에 적힌 피킹 기호(⊓ V)
        if (src.slash) {
          // 리듬 빗금: 바로 앞 화음(숫자)을 이 리듬으로 다시 침. 앞 화음이 없으면 빈 빗금으로 두고 확인 표시
          b.slash = true;
          if (prevNotes) prevNotes.forEach(p => { const nn = newNote(p.s, p.f); if (p.dead) nn.dead = true; b.notes.push(nn); });
          else { m.why.push('앞 화음이 없는 빗금이 있어요'); nm.check = true; nm.checkWhy = m.why.slice(); }
          nm.beats.push(b); return;
        }
        if (src.tieFromPrev) {
          // 오선보에서 찾은 이어진 음: 바로 앞 음을 붙임줄로 이어감
          if (prevNotes) prevNotes.forEach(p => { const nn = newNote(p.s, p.f); nn.tie = true; if (p.dead) nn.dead = true; b.notes.push(nn); });
          else m.why.push('앞 음이 없는 이어진 음은 쉼표로 두었어요');
          if (b.notes.length) prevNotes = b.notes;
          nm.beats.push(b); return;
        }
        src.notes.forEach(n => {
          const nn = newNote(n.s, n.f);
          if (n.dead) nn.dead = true; if (n.harm) nn.harm = true;
          if (n.slide) nn.slide = n.slide; if (n.hp) nn.hp = true; if (n.bend) nn.bend = { a: n.bend.a, ...(n.bend.r ? { r: true } : {}) };
          if (n.pm) nn.pm = true; if (n.lr) nn.lr = true;
          if (n.paren) nn._paren = true;
          if (src.stac) nn.stac = true;
          b.notes.push(nn);
        });
        if (b.notes.length && !b.grace) prevNotes = b.notes;
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
    return { song, warnings, systems: sysList.length, pages: doc.numPages, noStd: sysList.filter(s => !s.hasStd).length, debug: DBG || undefined };
  }

  // _test: 자동 테스트용 내부 함수 (앱에서는 쓰지 않음)
  return { importPdf, _test: { readPage, findStaves, parseSystem, readRhythm, fitMeasure, quantizeBySpacing, restShape, flagCount, isDigit3, fillRatio, findTabRhythm, readTabRhythm, slashHeads, vecTimeSig, tempoUnit } };
})();

if (typeof module !== 'undefined') module.exports = PdfImport;
