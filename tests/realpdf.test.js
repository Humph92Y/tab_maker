// 실제 악보 PDF 회귀 테스트: 원본을 눈으로 확인한 마디의 리듬(길이·점·쉼표·빗금)이 그대로 나오는지
//  PDF는 저작권 때문에 저장소에 넣지 않음 → TAB_PDF_DIR 폴더에 해당 PDF가 있을 때만 실행
//  실행: TAB_PDF_DIR=/pdf/폴더 node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, Math, JSON, Set, Map, module: {}, require };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(root, 'js/pdfimport.js'), 'utf8') + ';this.P = PdfImport;', ctx);

const dir = process.env.TAB_PDF_DIR;
const truths = fs.readdirSync(path.join(__dirname, 'realpdf')).filter(f => f.endsWith('.rhythm.json'));
const sig = b => (b.slash ? '/' : '') + (b.notes.length ? '' : 'R') + b.dur + (b.dot === 2 ? '..' : b.dot ? '.' : '') + (b.trip ? '3' : '') + (b.grace ? 'g' : '');

for (const tf of truths) {
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'realpdf', tf), 'utf8'));
  const pdf = dir && fs.existsSync(dir) ? fs.readdirSync(dir).find(f => /\.pdf$/i.test(f) && f.normalize('NFC').includes(truth.match)) : null;
  test('실제 PDF 리듬: ' + truth.match, { skip: !pdf && 'TAB_PDF_DIR 에 PDF 없음' }, async () => {
    const pdfjs = require(path.join(root, 'lib/pdf.min.js'));
    pdfjs.GlobalWorkerOptions.workerSrc = path.join(root, 'lib/pdf.worker.min.js');
    const { song } = await ctx.P.importPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(dir, pdf))));
    assert.strictEqual(song.measures.length, truth.measures, '마디 수');
    Object.entries(truth.ts).forEach(([mi, ts]) => assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.measureTs(song, +mi - 1))), ts, `${mi}마디 박자표`));
    if (truth.tempo) { assert.strictEqual(song.bpm, truth.tempo.bpm, '빠르기(4분음표 기준)'); assert.strictEqual(song.tempoMark && song.tempoMark.value, truth.tempo.value, '원본 템포 표기'); }
    if (truth.tuning) assert.strictEqual(song.tuning, truth.tuning, '튜닝');
    const bad = [];
    Object.entries(truth.rhythm).forEach(([mi, want]) => { const got = song.measures[+mi - 1].beats.map(sig).join(' '); if (got !== want) bad.push(`${mi}마디\n  원본: ${want}\n  인식: ${got}`); });
    assert.deepStrictEqual(bad, [], bad.join('\n'));
    // 박자 합이 안 맞는 마디는 반드시 확인 필요(⚠) 표시
    song.measures.forEach((m, i) => { const fill = ctx.measureFill(m), cap = ctx.measureCapacity(ctx.measureTs(song, i)); if (m.beats.length && fill !== cap) assert.ok(m.check, `${i + 1}마디: 박자 합이 다른데 ⚠ 없음`); });
  });
}
