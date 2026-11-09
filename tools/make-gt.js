#!/usr/bin/env node
// ===== 정답 파일(ground truth) 만들기 / 채우기 =====
// 새 악보 PDF를 회귀 검사에 넣을 때 씀. 지금 인식 결과를 "snapshot"(아직 확인 안 함) 마디로 적어 둠.
//  → 사람이 원본 PDF와 마디를 하나씩 대조해서 맞게 고친 뒤 "status": "verified" 로 바꾸면 그 마디는 정확도에 들어감.
//  → 이미 verified 인 마디는 절대 덮어쓰지 않음.
//
//  node tools/make-gt.js <pdf> --out <파일.gt.json> --id <이름> --source <guitarpro|musescore|akbonara|scan|...> [--title 제목]
//  (기존 정답 파일이 있으면 verified 마디·meta 는 그대로 두고 나머지만 새로 채움)
'use strict';
const fs = require('fs'), path = require('path');
const E = require('../tests/regress/evaluate.js');
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const pdf = args[0], out = opt('--out');
if (!pdf || !out) { console.error('사용법: node tools/make-gt.js <pdf> --out <파일.gt.json> --id 이름 --source 출처'); process.exit(2); }

(async () => {
  const c = E.engine();
  const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
  const res = await c.P.importPdf(require(path.join(__dirname, '../lib/pdf.min.js')), new Uint8Array(fs.readFileSync(pdf)));
  const pms = E.songEvents(res.song);
  const gt = old || {
    format: 'tabmaker-gt/1', id: opt('--id') || path.basename(pdf, '.pdf'), title: opt('--title') || res.song.title,
    source: opt('--source') || res.source, pdf: path.relative(path.dirname(out), pdf),
    fields: ['dur', 'rest', 'type', 'value', 'dot', 'grace', 'notes'],
    provenance: '원본 PDF와 눈으로 대조한 마디만 verified. 나머지는 인식 결과를 그대로 적은 snapshot',
    meta: {}, measures: []
  };
  const verified = new Map(gt.measures.filter(m => m.status === 'verified').map(m => [m.n, m]));
  gt.measures = pms.map((pm, i) => {
    const n = i + 1;
    if (verified.has(n)) return verified.get(n);
    return { n, status: 'snapshot', hash: E.hash(E.sigOf(pm)), events: pm.events.map(e => { const o = { on: e.on, dur: e.dur, type: e.type, value: e.value, dot: e.dot }; if (e.tuplet) o.tuplet = e.tuplet; if (e.notes.length) o.notes = e.notes; if (e.tech.length) o.tech = e.tech; return o; }) };
  });
  // verified 인데 지금 인식 결과보다 뒤에 있는 마디(마디 수가 줄었을 때)도 버리지 않음
  verified.forEach((m, n) => { if (n > pms.length) gt.measures.push(m); });
  fs.writeFileSync(out, JSON.stringify(gt, null, 1) + '\n');
  console.log(`${out}: 마디 ${gt.measures.length} (verified ${verified.size}, snapshot ${gt.measures.length - verified.size})`);
})().catch(e => { console.error(e); process.exit(1); });
