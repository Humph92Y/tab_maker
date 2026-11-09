// ===== PDF 인식 회귀 채점기 =====
// 정답 파일(ground truth)과 인식 결과를 음 하나하나 비교해서 점수를 냄.
//  - 정답 형식: tabmaker-gt/1 (아래 설명). 예전 형식(.truth.json, .rhythm.json)도 읽어서 바꿔 씀
//  - 점수: 쉼표 정밀도/재현율, 리듬 시작점(onset) 정밀도/재현율, 정확한 음 길이 비율, 프렛·기호·주법 일치, 마디 완전 일치
//  - 'verified' 마디(원본과 눈으로 확인했거나, 정답을 알고 만든 시험 악보)만 정확도에 셈
//  - 'snapshot' 마디(아직 확인 안 한 지금 결과)는 정확도에 넣지 않고 "바뀌었는지"만 봄
//
// 정답 형식 tabmaker-gt/1
// {
//   "format": "tabmaker-gt/1", "id": "aluminium", "title": "알루미늄", "source": "guitarpro",
//   "pdf": "pdfs/aluminium.pdf",            ← 정답 파일 기준 상대 경로
//   "fields": ["dur","type","value","dot"],  ← 정답에서 확인된 항목 (이것만 채점)
//   "meta": { "measures": 74, "ts": {"1":[6,8]}, "tempo": {"unit":8,"value":154,"bpm":77}, "tuning": "halfDown" },
//   "expect": "ok" | "unsupported",         ← 스캔처럼 아직 못 읽는 악보는 unsupported (점수는 그대로 보고)
//   "measures": [ { "n": 1, "status": "verified", "events": [
//       { "on": 0, "dur": 1440, "type": "note", "value": 2, "dot": 1, "tuplet": 0, "notes": ["1:5"], "tech": ["hp"] } ] } ]
// }
//  on/dur: 틱 (4분음표 = 480), 꾸밈음은 dur 0
//  type: note | rest | slash(리듬 빗금) | tie(붙임줄로 이어진 음) | grace(꾸밈음)
//   (fields 에 "tie" 가 없으면 정답의 note 와 인식의 tie 를 같은 것으로 봄: 붙임줄을 따로 확인하지 않은 정답)
//  notes: "줄:프렛" (줄 0 = 1번 줄)
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
// 다른 버전의 인식 코드와 비교할 때: TAB_ENGINE_ROOT=다른/checkout 폴더 (js/model.js, js/pdfimport.js 를 거기서 읽음)
const ENGINE_ROOT = process.env.TAB_ENGINE_ROOT || ROOT;
let ctx = null, pdfjs = null;
function engine() {
  if (ctx) return ctx;
  ctx = { console, Math, JSON, Set, Map, module: {}, require };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ENGINE_ROOT, 'js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(ENGINE_ROOT, 'js/pdfimport.js'), 'utf8') + ';this.P = PdfImport;', ctx);
  pdfjs = require(path.join(ROOT, 'lib/pdf.min.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'lib/pdf.worker.min.js');
  return ctx;
}

// ---------- 인식 결과 → 사건 목록 ----------
const TECH_KEYS = ['hp', 'slide', 'bend', 'vib', 'pm', 'dead', 'ghost', 'lr', 'harm', 'stac', 'acc'];
function songEvents(song) {
  const c = engine();
  return song.measures.map(m => {
    let t = 0; const evs = [];
    m.beats.forEach(b => {
      const d = c.beatTicks(b);
      const type = b.grace ? 'grace' : b.slash ? 'slash' : !b.notes.length ? 'rest' : b.notes.every(n => n.tie) ? 'tie' : 'note';
      const tech = new Set();
      b.notes.forEach(n => TECH_KEYS.forEach(k => { if (n[k]) tech.add(k); }));
      evs.push({ on: t, dur: d, type, value: b.dur, dot: b.dot === 2 ? 2 : b.dot ? 1 : 0, tuplet: b.trip ? 3 : 0,
        notes: b.notes.map(n => n.s + ':' + n.f).sort(), tech: [...tech].sort() });
      t += d;
    });
    return { events: evs, check: !!m.check };
  });
}

// ---------- 예전 정답 형식 바꾸기 ----------
// .truth.json (Verovio 시험 악보): measures = [[{d,k}]], k = "줄:프렛+..." 또는 "R"
function fromTruth(truth, id, pdf) {
  return {
    format: 'tabmaker-gt/1', id, title: id, source: 'verovio', pdf, fields: ['dur', 'rest', 'notes'],
    provenance: truth.source || 'Verovio 합성 시험 악보 (정답을 알고 만듦)',
    measures: truth.measures.map((evs, i) => {
      let t = 0;
      return { n: i + 1, status: 'verified', events: evs.map(e => { const o = { on: t, dur: e.d, type: e.k === 'R' ? 'rest' : 'note' }; if (e.k !== 'R') o.notes = e.k.split('+').sort(); t += e.d; return o; }) };
    })
  };
}
// .rhythm.json (실제 PDF에서 눈으로 확인한 리듬 기호): "8. /8 /16 R4 8g"
const TK = { 1: 1920, 2: 960, 4: 480, 8: 240, 16: 120, 32: 60 };
function parseSig(tok) {
  const m = tok.match(/^(\/)?(R)?(\d+)(\.{0,2})(3)?(g)?$/); if (!m) throw new Error('bad token ' + tok);
  const value = +m[3], dot = m[4].length, tuplet = m[5] ? 3 : 0, grace = !!m[6];
  let dur = TK[value]; if (dot === 2) dur *= 1.75; else if (dot) dur *= 1.5; if (tuplet) dur = dur * 2 / 3; if (grace) dur = 0;
  return { dur, type: grace ? 'grace' : m[1] ? 'slash' : m[2] ? 'rest' : 'note', value, dot, tuplet };
}
function sigToEvents(sig) {
  let t = 0;
  return sig.trim().split(/\s+/).map(tok => { const e = parseSig(tok); e.on = t; t += e.dur; return e; });
}
function fromRhythm(r, id, pdf) {
  return {
    format: 'tabmaker-gt/1', id, title: r.match, source: 'guitarpro', pdf, provenance: r.source,
    fields: ['dur', 'rest', 'type', 'value', 'dot', 'grace'],
    meta: { measures: r.measures, ts: r.ts, tempo: r.tempo, tuning: r.tuning },
    measures: Object.entries(r.rhythm).map(([n, sig]) => ({ n: +n, status: 'verified', sig, events: sigToEvents(sig) }))
  };
}

// ---------- 채점 ----------
const isRest = e => e.type === 'rest';
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function scoreMeasure(gm, pm, fields) {
  const F = new Set(fields);
  const g = gm.events.filter(e => e.type !== 'grace'), p = pm ? pm.events.filter(e => e.type !== 'grace') : [];
  const r = { gtRest: 0, pRest: 0, restTP: 0, gtOn: 0, pOn: 0, onTP: 0, gtEv: g.length, durOk: 0, notesN: 0, notesOk: 0, typeN: 0, typeOk: 0, techN: 0, techOk: 0, exact: true, diffs: [] };
  r.gtRest = g.filter(isRest).length; r.pRest = p.filter(isRest).length;
  r.gtOn = g.filter(e => !isRest(e)).length; r.pOn = p.filter(e => !isRest(e)).length;
  const used = new Set();
  g.forEach(e => {
    const k = p.findIndex((q, i) => !used.has(i) && q.on === e.on && isRest(q) === isRest(e));
    if (k < 0) { r.exact = false; r.diffs.push(`${e.on}: ${isRest(e) ? '쉼표' : '음'} 없음`); return; }
    used.add(k); const q = p[k];
    if (isRest(e)) r.restTP++; else r.onTP++;
    let ok = q.dur === e.dur;
    if (ok) r.durOk++; else r.diffs.push(`${e.on}: 길이 ${e.dur}→${q.dur}`);
    if (F.has('value') && e.value != null && q.value !== e.value) ok = false;
    if (F.has('dot') && e.dot != null && q.dot !== e.dot) { ok = false; r.diffs.push(`${e.on}: 점 ${e.dot}→${q.dot}`); }
    if (F.has('type') && !isRest(e)) { r.typeN++; if (q.type === e.type || (!F.has('tie') && e.type === 'note' && q.type === 'tie')) r.typeOk++; else { ok = false; r.diffs.push(`${e.on}: 기호 ${e.type}→${q.type}`); } }
    if (F.has('notes') && e.notes) { r.notesN++; if (sameSet(e.notes, q.notes)) r.notesOk++; else { ok = false; r.diffs.push(`${e.on}: 프렛 ${e.notes.join('+')}→${q.notes.join('+')}`); } }
    if (F.has('tech') && e.tech) { r.techN++; if (sameSet(e.tech, q.tech)) r.techOk++; else { ok = false; r.diffs.push(`${e.on}: 주법 ${e.tech.join(',')}→${q.tech.join(',')}`); } }
    if (!ok) r.exact = false;
  });
  if (used.size !== p.length) { r.exact = false; p.forEach((q, i) => { if (!used.has(i)) r.diffs.push(`${q.on}: 원본에 없는 ${isRest(q) ? '쉼표' : '음'}`); }); }
  if (F.has('grace')) { const gg = gm.events.filter(e => e.type === 'grace').length, pg = pm ? pm.events.filter(e => e.type === 'grace').length : 0; if (gg !== pg) { r.exact = false; r.diffs.push(`꾸밈음 ${gg}→${pg}`); } }
  return r;
}
const sigOf = pm => pm ? pm.events.map(e => `${e.on}/${e.dur}/${e.type}/${e.notes.join('+')}/${e.tech.join(',')}`).join(' ') : '';
const hash = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

async function evaluateDoc(gt, pdfPath, opts) {
  const c = engine();
  const out = { id: gt.id, title: gt.title, source: gt.source, expect: gt.expect || 'ok', detected: null, error: null, measures: 0, verified: 0, exact: 0, exactList: [], failList: [], silentWrong: [], metaFail: [], snapshot: {}, sums: null, checkCount: 0 };
  let res;
  try { res = await c.P.importPdf(pdfjs, new Uint8Array(fs.readFileSync(pdfPath)), null, opts); }
  catch (e) {
    // 못 읽은 악보도 점수에 넣음: 정답의 음·쉼표를 하나도 못 찾은 것으로 셈 (재현율 0%)
    out.error = String(e.message || e);
    const S = { gtRest: 0, pRest: 0, restTP: 0, gtOn: 0, pOn: 0, onTP: 0, gtEv: 0, durOk: 0, notesN: 0, notesOk: 0, typeN: 0, typeOk: 0, techN: 0, techOk: 0 };
    (gt.measures || []).filter(m => m.status !== 'snapshot').forEach(gm => { const r = scoreMeasure(gm, null, gt.fields || ['dur', 'rest']); Object.keys(S).forEach(k => S[k] += r[k]); out.verified++; out.failList.push(gm.n); });
    out.sums = S; out.current = {}; out.diffs = {}; out.metaChecks = 0;
    return out;
  }
  out.detected = res.source;
  const song = res.song, pms = songEvents(song);
  out.measures = pms.length; out.checkCount = pms.filter(m => m.check).length;
  const S = { gtRest: 0, pRest: 0, restTP: 0, gtOn: 0, pOn: 0, onTP: 0, gtEv: 0, durOk: 0, notesN: 0, notesOk: 0, typeN: 0, typeOk: 0, techN: 0, techOk: 0 };
  const diffs = {};
  (gt.measures || []).forEach(gm => {
    const pm = pms[gm.n - 1];
    if (gm.status === 'snapshot') { out.snapshot[gm.n] = gm.hash; return; }
    const r = scoreMeasure(gm, pm, gt.fields || ['dur', 'rest']);
    Object.keys(S).forEach(k => S[k] += r[k]);
    out.verified++;
    if (r.exact) { out.exact++; out.exactList.push(gm.n); }
    else { out.failList.push(gm.n); diffs[gm.n] = r.diffs.slice(0, 6); if (pm && !pm.check) out.silentWrong.push(gm.n); }
  });
  out.diffs = diffs;
  out.sums = S;
  // 지금 결과의 마디별 지문 (snapshot 마디가 바뀌었는지 보는 용도)
  out.current = {}; pms.forEach((pm, i) => out.current[i + 1] = hash(sigOf(pm)));
  // 박자표·템포·튜닝·마디 수
  const meta = gt.meta || {};
  if (meta.measures != null && meta.measures !== song.measures.length) out.metaFail.push(`마디 수 ${meta.measures}→${song.measures.length}`);
  if (meta.ts) Object.entries(meta.ts).forEach(([n, ts]) => { const got = n - 1 < song.measures.length ? Array.from(c.measureTs(song, n - 1)) : null; if (!got || got[0] !== ts[0] || got[1] !== ts[1]) out.metaFail.push(`${n}마디 박자표 ${ts.join('/')}→${got ? got.join('/') : '없음'}`); });
  if (meta.tempo) { if (song.bpm !== meta.tempo.bpm) out.metaFail.push(`빠르기 ${meta.tempo.bpm}→${song.bpm}`); const v = song.tempoMark ? song.tempoMark.value : song.bpm; if (v !== meta.tempo.value) out.metaFail.push(`템포 표기 ${meta.tempo.value}→${v}`); }
  if (meta.tuning && song.tuning !== meta.tuning) out.metaFail.push(`튜닝 ${meta.tuning}→${song.tuning}`);
  out.metaChecks = (meta.measures != null ? 1 : 0) + (meta.ts ? Object.keys(meta.ts).length : 0) + (meta.tempo ? 2 : 0) + (meta.tuning ? 1 : 0);
  return out;
}

// 비율 (분모 0이면 null)
const ratio = (a, b) => b ? a / b : null;
function metrics(d) {
  const S = d.sums || {};
  return {
    restP: ratio(S.restTP, S.pRest), restR: ratio(S.restTP, S.gtRest),
    onsetP: ratio(S.onTP, S.pOn), onsetR: ratio(S.onTP, S.gtOn),
    durAcc: ratio(S.durOk, S.gtEv), notesAcc: ratio(S.notesOk, S.notesN), typeAcc: ratio(S.typeOk, S.typeN), techAcc: ratio(S.techOk, S.techN),
    measureAcc: ratio(d.exact, d.verified),
  };
}

// ---------- 말뭉치(corpus) 읽기 ----------
// 폴더 안의 *.gt.json, *.truth.json(옆에 같은 이름 PDF), *.rhythm.json(match 로 PDF 찾기)
function loadCorpus(dir) {
  const docs = [];
  if (!dir || !fs.existsSync(dir)) return docs;
  const files = fs.readdirSync(dir).sort();
  files.filter(f => f.endsWith('.gt.json')).forEach(f => {
    const gt = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    docs.push({ gt, pdf: path.join(dir, gt.pdf), gtFile: path.join(dir, f) });
  });
  files.filter(f => f.endsWith('.truth.json')).forEach(f => {
    const pdf = path.join(dir, f.replace('.truth.json', '.pdf'));
    if (!fs.existsSync(pdf)) return;
    const id = path.basename(dir) + '/' + f.replace('.truth.json', '');
    docs.push({ gt: fromTruth(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), id, path.basename(pdf)), pdf });
  });
  return docs;
}

function readBaseline(dir) { const f = path.join(dir, 'baseline.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { docs: {} }; }
function baselineEntry(d) { return { measures: d.measures, verified: d.verified, exactList: d.exactList, metrics: metrics(d), metaFail: d.metaFail, checkCount: d.checkCount, current: d.current, error: d.error, detected: d.detected }; }

// 이전 결과와 비교: 좋아진 것 / 나빠진 것 (문서별)
const KEYS = ['restP', 'restR', 'onsetP', 'onsetR', 'durAcc', 'notesAcc', 'typeAcc', 'techAcc', 'measureAcc'];
function compare(d, base) {
  const now = metrics(d), out = { improved: [], regressed: [], newlyPass: [], newlyFail: [], snapshotChanged: [], metaNew: [], metaFixed: [], isNew: !base };
  if (!base) return out;
  KEYS.forEach(k => {
    const a = base.metrics[k], b = now[k];
    if (a == null || b == null) return;
    if (b > a + 1e-9) out.improved.push(k); else if (b < a - 1e-9) out.regressed.push(k);
  });
  const was = new Set(base.exactList), is = new Set(d.exactList);
  out.newlyFail = [...was].filter(n => !is.has(n) && d.failList.includes(n));
  out.newlyPass = [...is].filter(n => !was.has(n));
  out.metaNew = d.metaFail.filter(x => !(base.metaFail || []).includes(x));
  out.metaFixed = (base.metaFail || []).filter(x => !d.metaFail.includes(x));
  // 확인 안 된(snapshot) 마디: 지문이 바뀌었는지
  Object.entries(d.snapshot).forEach(([n, h]) => { if (d.current[n] !== h) out.snapshotChanged.push(+n); });
  if (!base.error && d.error) out.regressed.push('error');
  return out;
}

module.exports = { engine, songEvents, fromTruth, fromRhythm, sigToEvents, scoreMeasure, evaluateDoc, metrics, loadCorpus, readBaseline, baselineEntry, compare, hash, sigOf, KEYS };
