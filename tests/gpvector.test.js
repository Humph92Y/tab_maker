// Guitar Pro 식 "그림(도형)으로 그린 기호" 인식 테스트 (가짜 도형으로 확인)
//  - 리듬 빗금(슬래시): 쉼표가 아니라 "앞 화음을 이 리듬으로 다시 치기" 박
//  - 그림 박자표 숫자(6/8, 12/8): 구멍 개수·획 모양으로 읽기
//  - 템포 기호의 기준 음표(♪ = 154 → 4분음표 77)
//  - 숫자가 촘촘해 줄이 많이 끊긴 타브 줄 / 오선 위에 길게 이어진 덧줄
// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const root = path.join(__dirname, '..');
const ctx = { console, Math, JSON, Set, Map, module: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(root, 'js/pdfimport.js'), 'utf8') + ';this.P = PdfImport;', ctx);
const { readRhythm, fitMeasure, slashHeads, vecTimeSig, tempoUnit, findStaves } = ctx.P._test;
// 이 파일은 Guitar Pro 전용 규칙을 시험하므로 Guitar Pro 프로필로 실행
ctx.P._test.setProfile('guitarpro');

const SP = 5;
const ST = { type: 'std', lines: [220, 215, 210, 205, 200], top: 220, bottom: 200, sp: SP, x0: 20, x1: 400 };
const TAB = { type: 'tab', top: 160, bottom: 135, sp: SP, x0: 20, x1: 400 };
function shape(kind, x0, y0, x1, y1, o = {}) {
  const pts = o.pts || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return { kind, x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, n: o.n || pts.length, curve: !!o.curve, pts, poly: pts, lw: 1 };
}
const poly = (kind, pts, o = {}) => { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return shape(kind, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), Object.assign({ pts }, o)); };
// 빗금 머리: 왼쪽 아래 → 오른쪽 위로 기운 평행사변형 (Guitar Pro 와 같은 점 순서)
const slash = (x, y = 205) => poly('F', [[x, y], [x + 7, y + 8], [x + 7, y + 10], [x, y + 2]]);
const stemAt = (x, y0, y1) => shape('S', x, y0, x, y1);
const beam = (x0, x1, y) => shape('F', x0, y, x1, y + 2.5, { n: 4 });
const head = (x, y) => shape('F', x - 3, y - 2.5, x + 3, y + 2.5, { curve: true, n: 21 });
const dotS = (cx, cy) => shape('F', cx - 0.9, cy - 0.9, cx + 0.9, cy + 0.9, { curve: true, n: 5 });

test('기울어진 평행사변형 = 빗금, 납작한 직사각형(빔)은 빗금이 아님', () => {
  const r = slashHeads([slash(100), shape('F', 120, 205, 127, 215, { n: 4 }), beam(130, 150, 225)], () => true, SP);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(Math.round(r[0].cx), 104);
});

test('빗금은 쉼표가 아니라 박이 되고, 기둥·빔·점으로 길이를 읽음 (화음 8분점 + 빗금 8분 + 빗금 16분)', () => {
  // 화음(타브 숫자 x=100) 머리 + 기둥, 빗금 2개. 빔 하나는 셋 모두, 16분 빔은 마지막 빗금에만
  const shapes = [head(100, 207), stemAt(103, 207, 230), dotS(106, 209.5),
    slash(110), stemAt(117, 213, 230), slash(122), stemAt(129, 213, 230),
    beam(103, 129.5, 228), beam(125, 129.5, 224.5)];
  const m = { x0: 50, x1: 250, beats: [{ x: 100, grace: false, notes: [{ s: 2, f: 5 }] }], rests: [], tsMark: null, sysFirst: false };
  readRhythm([m], ST, [], shapes, [m.x0, m.x1], TAB);
  const sl = m.beats.filter(b => b.slash);
  assert.strictEqual(m.rests.length, 0, '빗금을 쉼표로 읽으면 안 됨');
  assert.strictEqual(sl.length, 2);
  assert.deepStrictEqual(m.beats.map(b => b.dur + (b.dot ? '.' : '')), ['8.', '8', '16']);
  fitMeasure(m, 720, [], 1);
  assert.strictEqual(m.sum, 720); // 점4분 1개 길이 (6/8의 반 마디)
});

// 숫자 도형: 바깥 윤곽 + 구멍(안쪽 도형)
const digit8 = (x, y) => [shape('F', x, y, x + 8, y + 10, { curve: true, n: 30 }), shape('F', x + 2, y + 1, x + 6, y + 4, { curve: true, n: 5 }), shape('F', x + 2, y + 6, x + 6, y + 9, { curve: true, n: 5 })];
const digit6 = (x, y) => [shape('F', x, y, x + 8, y + 10, { curve: true, n: 26 }), shape('F', x + 2.5, y + 1, x + 5.5, y + 4.5, { curve: true, n: 5 })];
// "1": 좁은 세로 획 + 아래 받침
const digit1 = (x, y) => [poly('F', [[x, y], [x + 6, y], [x + 6, y + 1], [x + 4, y + 1], [x + 4, y + 10], [x + 2, y + 10], [x + 2, y + 1], [x, y + 1]], { curve: true })];
// "2": 위는 둥근 머리(좁음), 사선, 아래는 꽉 찬 가로 획
const digit2 = (x, y) => [poly('F', [[x, y], [x + 8, y], [x + 8, y + 2], [x + 3, y + 2], [x + 8, y + 7], [x + 6, y + 10], [x + 2, y + 10], [x + 1, y + 8], [x + 3, y + 8], [x + 5, y + 7], [x, y + 2]], { curve: true })];
const tsMeasure = () => ({ x0: 30, x1: 250, beats: [{ x: 120, grace: false, notes: [] }], rests: [], sysFirst: false });

test('그림 박자표 6/8: 구멍 아래쪽 1개 = 6, 구멍 2개 = 8', () => {
  const v = vecTimeSig(tsMeasure(), ST, [...digit6(60, 210), ...digit8(60, 200)], SP);
  assert.ok(v);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v.cands)), [[6, 8]]);
});

test('그림 박자표 12/8: 구멍 없는 숫자는 획 모양으로 1과 2를 구분 (13/8 등으로 읽지 않음)', () => {
  const v = vecTimeSig(tsMeasure(), ST, [...digit1(56, 210), ...digit2(63, 210), ...digit8(59.5, 200)], SP);
  assert.ok(v);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v.cands)), [[12, 8]]);
});

test('음표 앞에 있지 않은 도형은 박자표가 아님', () => {
  const m = tsMeasure(); m.beats[0].x = 50; // 첫 음이 숫자보다 앞
  assert.strictEqual(vecTimeSig(m, ST, [...digit6(60, 210), ...digit8(60, 200)], SP), null);
});

test('템포 기호: 꼬리 달린 음표 = 8분음표 기준, 꼬리 없으면 4분음표', () => {
  const eq = { str: '=', x: 83, y: 698.5, w: 5, h: 11.7 };
  // 머리(왼쪽 아래) + 기둥 + 오른쪽으로 뻗은 꼬리 (Guitar Pro PDF 에서 뽑은 실제 모양)
  const eighthPts = [[75.9, 705.3], [74.7, 708.3], [74.3, 708.6], [74.2, 708.4], [74.2, 705.7], [74.2, 699.8], [73.3, 700.1], [70.7, 698], [72, 696.9], [74.6, 699.1], [74.6, 705.5], [76.5, 703], [76.8, 701.3], [76.5, 699.7], [76.7, 699.2], [77, 699.4], [77.3, 701.4], [75.9, 705.3]];
  const quarterPts = [[74.6, 708.6], [74.2, 708.6], [74.2, 699.8], [73.3, 700.1], [70.7, 698], [72, 696.9], [74.6, 699.1]];
  assert.strictEqual(tempoUnit([poly('F', eighthPts, { curve: true })], [], eq).unit, 8);
  assert.strictEqual(tempoUnit([poly('F', quarterPts, { curve: true })], [], eq).unit, 4);
});

const hline = (x0, x1, y) => shape('S', x0, y, x1, y);
test('숫자가 촘촘해 많이 끊긴 타브 줄도 줄로 인식 (양 끝이 다른 줄과 맞으면)', () => {
  const lines = [];
  [250, 243, 236, 229, 222, 215].forEach((y, i) => {
    if (i === 2 || i === 4) for (let x = 30; x < 560; x += 50) lines.push(hline(x, x + 7, y)); // 14%만 칠해짐
    else lines.push(hline(30, 560, y));
  });
  // 양 끝 짧은 조각 (시스템 시작·끝과 맞춤)
  lines.push(hline(553, 560, 236), hline(553, 560, 222));
  const st = findStaves(lines);
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].type, 'tab');
});

test('오선 바로 위에 길게 이어진 덧줄은 타브(6줄)로 착각하지 않음', () => {
  const lines = [220, 215, 210, 205, 200].map(y => hline(30, 560, y));
  for (let x = 62; x < 548; x += 10) lines.push(hline(x, x + 7, 225)); // 덧줄 줄 (시스템 왼쪽 끝에서 시작하지 않음)
  const st = findStaves(lines);
  assert.strictEqual(st.length, 1);
  assert.strictEqual(st[0].type, 'std');
});
