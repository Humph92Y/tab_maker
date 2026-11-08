// PDF 인식 정확도 테스트: 정답을 아는 시험 악보(tests/fixtures)를 불러와 한 음씩 비교
//  - 시험 악보는 직접 만든 MusicXML 을 Verovio 로 그려 PDF 로 만든 것 (저작권 문제 없음)
//  - 정답(.truth.json)은 그 MusicXML 의 음 길이 그대로
//  - 마디의 박자 합만 맞고 음 하나라도 길이가 다르면 틀린 것으로 셈
//  - 틀린 마디는 반드시 ⚠(확인 필요) 표시가 있어야 함 (조용히 틀리면 안 됨)
// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const DIR = path.join(__dirname, 'fixtures');
const pdfjs = require('../lib/pdf.min.js');
pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, '../lib/pdf.worker.min.js');
const ctx = { console, Math, JSON, module: {}, require, Set, Map };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(__dirname, '../js/pdfimport.js'), 'utf8') + ';this.P=PdfImport;', ctx);

const seq = evs => { let t = 0; return evs.map(e => { const o = { t, d: e.d, k: e.k }; t += e.d; return o; }); };
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith('.truth.json')).sort() : [];

async function check(f) {
  const truth = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const r = await ctx.P.importPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(DIR, f.replace('.truth.json', '.pdf')))));
  const res = { measures: 0, exact: 0, events: 0, eventsOk: 0, restT: 0, restP: 0, restTP: 0, silent: [] };
  truth.measures.forEach((tm, i) => {
    const want = seq(tm), im = r.song.measures[i];
    const got = im ? seq(im.beats.filter(b => !b.grace).map(b => ({ d: ctx.beatTicks(b), k: b.notes.length ? b.notes.map(n => n.s + ':' + n.f).sort().join('+') : 'R' }))) : [];
    let ok = 0; want.forEach(e => { if (got.some(g => g.t === e.t && g.d === e.d && g.k === e.k)) ok++; });
    const tr = want.filter(e => e.k === 'R'), gr = got.filter(e => e.k === 'R');
    res.restT += tr.length; res.restP += gr.length; res.restTP += tr.filter(e => gr.some(g => g.t === e.t && g.d === e.d)).length;
    res.measures++; res.events += want.length; res.eventsOk += ok;
    const exact = ok === want.length && got.length === want.length;
    if (exact) res.exact++; else if (!(im && im.check)) res.silent.push(i + 1);
  });
  return res;
}

const total = { measures: 0, exact: 0, events: 0, eventsOk: 0, restT: 0, restP: 0, restTP: 0 };
for (const f of files) {
  test('시험 악보 ' + f.replace('.truth.json', ''), async () => {
    const r = await check(f);
    Object.keys(total).forEach(k => total[k] += r[k]);
    // 조용히 틀린 마디가 없어야 함
    assert.deepStrictEqual(r.silent, [], '⚠ 표시 없이 틀린 마디: ' + r.silent.join(', '));
    // 지금 결과보다 나빠지면 실패 (현재: 모든 시험 악보가 마디 단위로 정확)
    assert.strictEqual(r.exact, r.measures, `정확한 마디 ${r.exact}/${r.measures}, 음 ${r.eventsOk}/${r.events}`);
    assert.strictEqual(r.restTP, r.restT, `쉼표 ${r.restTP}/${r.restT}`);
    assert.strictEqual(r.restP, r.restT, `없는 쉼표를 만들어냄: ${r.restP - r.restTP}개`);
  });
}

test('요약', { skip: !files.length }, () => {
  console.log(`# 인식 정확도: 마디 ${total.exact}/${total.measures}, 음 ${total.eventsOk}/${total.events}, 쉼표 재현율 ${total.restTP}/${total.restT}, 쉼표 정밀도 ${total.restTP}/${total.restP}`);
});

// 해머/풀: 글자(H/P) 없이 타브 숫자 위에 그린 이음 곡선만 있는 악보 (Verovio, 글꼴 2종)
for (const font of ['Leland', 'Bravura']) {
  const f = path.join(__dirname, 'fixtures-tech', `slur-${font}.pdf`);
  test('이음 곡선 = 해머/풀 (' + font + ')', { skip: !fs.existsSync(f) }, async () => {
    const r = await ctx.P.importPdf(pdfjs, new Uint8Array(fs.readFileSync(f)));
    const hp = r.song.measures.map(m => m.beats.map(b => b.notes.some(n => n.hp) ? 'h' : '-').join(''));
    // 1마디: 5→7(해머) 7→5(풀) 그다음 2분음표, 2마디: 3, 5→7(해머), 8
    assert.strictEqual(JSON.stringify(hp), JSON.stringify(['h-h--', '-h--']));
  });
}
