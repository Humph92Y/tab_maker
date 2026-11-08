// PDF 불러오기 리듬 인식 테스트 (외부 라이브러리 없이 Node 내장 테스트 사용)
// 실행: node --test tests/
// 실제 PDF로도 돌려보려면: TAB_PDF_DIR=/pdf/폴더 node --test tests/   (PDF는 저장소에 넣지 않음)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, Math, JSON, Set, Map, module: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(root, 'js/pdfimport.js'), 'utf8') + ';this.P = PdfImport;', ctx);
const { readRhythm, fitMeasure } = ctx.P._test;

// ---------- 가짜 악보 만들기 ----------
// 오선: 칸 간격 sp=5, 아래줄 y=200 ~ 윗줄 y=220 (PDF 좌표는 위로 갈수록 y가 커짐)
const SP = 5;
const ST = { type: 'std', lines: [220, 215, 210, 205, 200], top: 220, bottom: 200, sp: SP, x0: 20, x1: 400 };
const TAB = { type: 'tab', top: 160, bottom: 135, sp: SP, x0: 20, x1: 400 };
function shape(kind, x0, y0, x1, y1, o = {}) {
  const pts = o.pts || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { kind, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, n: o.n || pts.length, curve: !!o.curve, pts, lw: 1 };
}
const head = (x, y, hollow) => {
  const a = [shape('F', x - 3, y - 2.5, x + 3, y + 2.5, { curve: true, n: 21 })];
  if (hollow) a.push(shape('F', x - 2, y - 1.5, x + 2, y + 1.5, { curve: true, n: 9 }));
  return a;
};
const stemUp = (x, y) => shape('S', x + 3, y, x + 3, y + 18);             // 머리 오른쪽에서 위로
const flagUp = (x, y) => shape('F', x + 3, y + 7, x + 7.5, y + 18, { curve: true, n: 11 }); // 기둥 끝에 붙은 꼬리
const rest8 = (cx, cy = 210) => shape('F', cx - 2.5, cy - 4.4, cx + 2.5, cy + 4.4, { curve: true, n: 19 }); // 높이 1.75칸
const restQ = (cx, cy = 210) => shape('F', cx - 2.7, cy - 7.5, cx + 2.7, cy + 7.5, { curve: true, n: 35 }); // 높이 3칸
const sharp = (cx, cy) => shape('F', cx - 2.5, cy - 7, cx + 2.5, cy + 7, { curve: true, n: 59 });
const dot = (cx, cy) => shape('F', cx - 0.8, cy - 0.8, cx + 0.8, cy + 0.8, { curve: true, n: 5 });
const glyph = (code, x, y, w = 5) => ({ str: String.fromCharCode(code), x, y, w, h: 10, font: 'Bravura' });
const beat = (x, s = 2, f = 5) => ({ x, grace: false, notes: [{ s, f }] });
const quarter = (x, y = 205) => [...head(x, y), stemUp(x, y)];
const eighth = (x, y = 205) => [...quarter(x, y), flagUp(x, y)];
function measure(beats, o = {}) { return Object.assign({ x0: 50, x1: 250, beats, rests: [], tsMark: null, sysFirst: false }, o); }
function read(m, shapes, texts = []) { readRhythm([m], ST, texts, shapes, [m.x0, m.x1], TAB); return m; }
const ticks = it => it.b ? (it.b.grace ? 0 : { 1: 1920, 2: 960, 4: 480, 8: 240, 16: 120, 32: 60 }[it.b.dur] * (it.b.dot === 2 ? 1.75 : it.b.dot ? 1.5 : 1))
  : { 1: 1920, 2: 960, 4: 480, 8: 240, 16: 120, 32: 60 }[it.rest.dur] * (it.rest.dot === 2 ? 1.75 : it.rest.dot ? 1.5 : 1);

// ---------- 쉼표 인식 ----------
test('옆 음표 기둥에 가까운 8분쉼표도 쉼표로 인식 (예전에는 꼬리로 오해해서 버림)', () => {
  // 쉼표 왼쪽 끝이 앞 음표 기둥(x=103)과 1 이내지만, 기둥 끝(아래 200, 위 218)에 붙어 있지 않음
  const m = read(measure([beat(100), beat(130)]), [...quarter(100, 200), rest8(105.8), ...quarter(130)]);
  assert.strictEqual(m.rests.length, 1);
  assert.strictEqual(m.rests[0].dur, 8);
  assert.strictEqual(m.rests[0].method, 'vector-curve');
});

test('기둥 끝에 붙은 꼬리는 쉼표가 아님', () => {
  const m = read(measure([beat(100)]), eighth(100));
  assert.strictEqual(m.rests.length, 0);
  assert.strictEqual(m.beats[0].dur, 8);
});

test('음표머리 바로 왼쪽의 임시표(♯)는 쉼표가 아님', () => {
  const m = read(measure([beat(100)]), [sharp(93, 205), ...quarter(100)]);
  assert.strictEqual(m.rests.length, 0);
});

test('화음 앞에 겹쳐 놓인 임시표 두 줄도 쉼표가 아님', () => {
  // 오른쪽 ♯는 머리 바로 왼쪽, 왼쪽 ♯는 그 ♯ 바로 왼쪽(머리와는 멀리)
  const m = read(measure([beat(100)]), [sharp(93, 210), sharp(87.5, 203), ...quarter(100, 210), ...head(100, 200)]);
  assert.strictEqual(m.rests.length, 0);
});

test('SMuFL 글자가 하나라도 있어도 그림 쉼표를 계속 찾음 (예전에는 통째로 꺼짐)', () => {
  const texts = [glyph(0xE520, 180, 230)]; // 셈여림 등 다른 SMuFL 글자
  const m = read(measure([beat(100), beat(150)]), [...quarter(100), rest8(125), ...quarter(150)], texts);
  assert.strictEqual(m.rests.length, 1);
});

test('같은 자리에 SMuFL 쉼표와 그림 쉼표가 있으면 하나만 씀', () => {
  const texts = [glyph(0xE4E6, 122.5, 210)];
  const m = read(measure([beat(100), beat(150)]), [...quarter(100), rest8(125), ...quarter(150)], texts);
  assert.strictEqual(m.rests.length, 1);
  assert.strictEqual(m.rests[0].method, 'smufl');
});

test('4분쉼표 높이(약 3칸)는 4분으로 읽고, 비슷한 16분은 후보로 기록', () => {
  const m = read(measure([beat(100), beat(170)]), [...quarter(100), restQ(135), ...quarter(170)]);
  assert.strictEqual(m.rests.length, 1);
  assert.strictEqual(m.rests[0].dur, 4);
  assert.deepStrictEqual(Array.from(m.rests[0].alt), [16]);
  assert.strictEqual(m.rests[0].known, false);
});

test('사각형 쉼표: 줄에 매달리면 온쉼표, 줄 위에 앉으면 2분쉼표', () => {
  const whole = shape('F', 120, 212.5, 127, 215, { n: 4 }); // 윗변이 215 줄
  const half = shape('F', 180, 210, 187, 212.5, { n: 4 });  // 아랫변이 210 줄
  const m = read(measure([beat(100)]), [...quarter(100), whole, half]);
  const durs = m.rests.map(r => r.dur).sort();
  assert.deepStrictEqual(durs, [1, 2]);
});

test('그림 쉼표 오른쪽 점 = 점쉼표', () => {
  const m = read(measure([beat(100), beat(170)]), [...quarter(100), rest8(130), dot(135.5, 212.5), ...quarter(170)]);
  assert.strictEqual(m.rests.length, 1);
  assert.strictEqual(m.rests[0].dot, true);
});

// ---------- 점 / 겹점 / 스타카토 ----------
test('음표 오른쪽 점 1개 = 점음표, 2개 = 겹점음표', () => {
  const m1 = read(measure([beat(100)]), [...quarter(100), dot(108, 207.5)]);
  assert.strictEqual(m1.beats[0].dot, true);
  const m2 = read(measure([beat(100)]), [...quarter(100), dot(108, 207.5), dot(111.5, 207.5)]);
  assert.strictEqual(m2.beats[0].dot, 2);
});

test('음표머리 바로 위/아래 점 = 스타카토 (길이 점 아님)', () => {
  const m = read(measure([beat(100)]), [...quarter(100), dot(100, 199)]);
  assert.strictEqual(m.beats[0].stac, true);
  assert.strictEqual(m.beats[0].dot, false);
});

test('다음 음의 스타카토 점을 앞 음의 길이 점으로 세지 않음', () => {
  // 앞 음(100) 오른쪽 범위 안에 있지만, 다음 음(110) 머리 바로 아래 점
  const m = read(measure([beat(100), beat(110)]), [...quarter(100), ...quarter(110), dot(110, 199)]);
  assert.strictEqual(m.beats[0].dot, false);
  assert.strictEqual(m.beats[1].stac, true);
});

test('빈 머리 + 기둥 = 2분음표, 빈 머리 + 기둥 없음 = 온음표', () => {
  const m = read(measure([beat(100), beat(180)]), [...head(100, 205, true), stemUp(100, 205), ...head(180, 205, true)]);
  assert.strictEqual(m.beats[0].dur, 2);
  assert.strictEqual(m.beats[1].dur, 1);
});

// ---------- 붙임줄로 이어진 음 (타브 숫자 없음) ----------
test('타브 숫자 없는 오선보 음은 같은 높이 붙임줄이 있을 때만 이어진 음으로 넣음', () => {
  const tie = shape('F', 103, 201, 117, 202.5, { curve: true, n: 3 });
  const m = read(measure([beat(100)]), [...quarter(100), ...quarter(120), tie]);
  assert.strictEqual(m.beats.length, 2);
  assert.strictEqual(m.beats[1].tieFromPrev, true);
  assert.strictEqual(m.beats[1].dur, 4);
  const m2 = read(measure([beat(100)]), [...quarter(100), ...quarter(120)]); // 붙임줄 없음
  assert.strictEqual(m2.beats.length, 1);
  const slur = shape('F', 103, 201, 117, 202.5, { curve: true, n: 3 });
  const m3 = read(measure([beat(100)]), [...quarter(100, 205), ...quarter(120, 215), slur]); // 높이가 다름 = 이음줄
  assert.strictEqual(m3.beats.length, 1);
});

// ---------- fitMeasure: 원본 길이 보존 ----------
function fit(m, cap = 1920) { const w = []; fitMeasure(m, cap, w, 1); return { m, w }; }
const mb = (x, dur, dot = false) => ({ x, grace: false, notes: [{ s: 2, f: 5 }], dur, dot, measured: true });

test('박자가 넘쳐도 원본에서 읽은 길이는 바꾸지 않고 확인 필요로 표시', () => {
  const beats = [mb(60, 4), mb(100, 4), mb(140, 4), mb(180, 4), mb(220, 8)];
  const { m, w } = fit(measure(beats));
  assert.deepStrictEqual(beats.map(b => b.dur), [4, 4, 4, 4, 8]);
  assert.strictEqual(m.items.length, 5);
  assert.deepStrictEqual(Array.from(w), [1]);
  assert.ok(m.why.some(s => s.includes('넘쳐요')));
});

test('박자가 모자라도 없는 음(붙임줄 음)이나 쉼표를 지어내지 않음', () => {
  const beats = [mb(60, 8), mb(80, 8), mb(100, 8), mb(120, 8)];
  const { m, w } = fit(measure(beats));
  assert.strictEqual(m.items.length, 4);
  assert.ok(m.items.every(it => it.b && it.b.notes.every(n => !n.tie)));
  assert.deepStrictEqual(beats.map(b => b.dur), [8, 8, 8, 8]);
  assert.strictEqual(w.length, 1);
});

test('점이 빠진 것 같아도 다른 음 길이를 바꿔 맞추지 않음 (예전에는 1~2개 음을 바꿈)', () => {
  const beats = [mb(60, 4), mb(120, 8), mb(150, 2)]; // 원래 점4분이라면 4박
  fit(measure(beats));
  assert.deepStrictEqual(beats.map(b => [b.dur, b.dot]), [[4, false], [8, false], [2, false]]);
});

test('모양이 애매한 쉼표만 기록된 후보 안에서 박자 합에 맞게 고름', () => {
  const beats = [mb(60, 4), mb(100, 4), mb(140, 4), mb(200, 16)]; // 16분음표
  const m = measure(beats, { rests: [{ x: 180, dur: 4, alt: [16], dot: false, known: false }] });
  // 4+4+4+16분 = 3.25박 → 쉼표가 4분이면 4.25박(넘침), 16분이면 3.5박(모자람): 맞는 후보가 없으면 그대로 둠
  const r1 = fit(m);
  assert.strictEqual(m.rests[0].dur, 4);
  assert.strictEqual(r1.w.length, 1);
  // 4분 셋 + 점8분 + 쉼표: 쉼표가 16분일 때 딱 4박 → 16분으로 고름
  const beats2 = [mb(60, 4), mb(100, 4), mb(140, 4), mb(200, 8, true)];
  const m2 = measure(beats2, { rests: [{ x: 180, dur: 4, alt: [16], dot: false, known: false }] });
  const r2 = fit(m2);
  assert.strictEqual(m2.rests[0].dur, 16);
  assert.deepStrictEqual(beats2.map(b => [b.dur, b.dot]), [[4, false], [4, false], [4, false], [8, true]]);
  assert.strictEqual(r2.w.length, 0);
  assert.strictEqual(m2.guessed, true);
});

test('확실한 쉼표는 길이를 바꾸지 않음', () => {
  const beats = [mb(60, 4), mb(100, 4)];
  const m = measure(beats, { rests: [{ x: 150, dur: 8, dot: false, known: true }] });
  const { w } = fit(m);
  assert.strictEqual(m.rests[0].dur, 8);
  assert.strictEqual(w.length, 1);
});

test('리듬 정보가 전혀 없는 마디(타브만)는 간격으로 추측하고 추측 표시', () => {
  const beats = [60, 100, 140, 180].map(x => ({ x, grace: false, notes: [{ s: 1, f: 3 }] }));
  const { m, w } = fit(measure(beats));
  assert.strictEqual(m.spaced, true);
  assert.strictEqual(m.guessed, true);
  assert.strictEqual(m.items.reduce((a, it) => a + ticks(it), 0), 1920);
  assert.strictEqual(w.length, 0);
});

test('3/4 마디의 온쉼표 하나 = 마디 전체 쉼', () => {
  const m = measure([], { rests: [{ x: 150, dur: 1, dot: false, known: true }] });
  fit(m, 1440);
  assert.strictEqual(m.items.reduce((a, it) => a + ticks(it), 0), 1440);
});

// ---------- 실제 PDF (선택) ----------
const dir = process.env.TAB_PDF_DIR;
test('실제 PDF 불러오기 (TAB_PDF_DIR 이 있을 때만)', { skip: !dir }, async () => {
  const pdfjs = require(path.join(root, 'lib/pdf.min.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(root, 'lib/pdf.worker.min.js');
  for (const f of fs.readdirSync(dir).filter(f => /\.pdf$/i.test(f))) {
    const r = await ctx.P.importPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(dir, f))));
    const s = r.song;
    assert.ok(s.measures.length > 0, f);
    // 원본에서 읽은 길이는 dm 으로 표시되어 편집기 자동 맞춤이 바꾸지 않음
    assert.ok(s.measures.some(m => m.beats.some(b => b.dm)), f);
    // 박자가 안 맞는 마디는 모두 확인 필요 표시가 있어야 함
    s.measures.forEach((m, i) => {
      const fill = ctx.measureFill(m), cap = ctx.measureCapacity(ctx.measureTs(s, i));
      if (m.beats.length && fill !== cap && i > 0 && i < s.measures.length - 1) assert.ok(m.check, `${f} 마디 ${i + 1}`);
    });
  }
});
