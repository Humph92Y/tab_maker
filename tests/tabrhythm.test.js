// 타브 아래에 리듬(기둥·빔)이 그려진 악보 테스트 (예: 위 오선보가 보컬인 밴드 악보)
// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { console, Math, JSON, Set, Map, module: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(__dirname, '../js/pdfimport.js'), 'utf8') + ';this.P = PdfImport;', ctx);
const { findTabRhythm, readTabRhythm } = ctx.P._test;

// 타브: 칸 간격 6, 아래줄 y=135 ~ 윗줄 y=165. 리듬 기준선(기둥 아랫끝) y=120
const SP = 6, YB = 120;
const TAB = { type: 'tab', lines: [165, 159, 153, 147, 141, 135], top: 165, bottom: 135, sp: SP, x0: 20, x1: 400 };
const S = (x0, y0, x1, y1, o = {}) => ({ kind: o.kind || 'S', x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, n: o.n || 2, curve: !!o.curve, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
const stem = x => S(x, YB, x, 133);            // 긴 기둥: 기준선 → 숫자 바로 아래
const stub = x => S(x, YB, x, YB + SP);        // 짧은 기둥(2분음표·2분쉼표)
const beam = (x0, x1, lv) => S(x0, YB + lv * 3, x1, YB + lv * 3 + 2, { kind: 'F', n: 4 }); // lv 0 = 맨 아래
const G = (code, x, y) => ({ str: String.fromCharCode(code), x, y, w: 4, h: 10 });
const DOT = (x) => G(0xE1E7, x, YB + 6);
const beat = (x, s = 2, f = 5) => ({ x, grace: false, notes: [{ s, f }] });
const M = (beats, o = {}) => Object.assign({ x0: 50, x1: 250, beats, rests: [], tsMark: null }, o);
const durs = m => m.beats.map(b => b.dur + (b.dot === 2 ? '..' : b.dot ? '.' : '')).join(' ');

function read(m, shapes, texts = []) {
  const tr = findTabRhythm(TAB, shapes, [m]);
  assert.ok(tr, '타브 리듬을 찾아야 함');
  readTabRhythm([m], TAB, tr, texts, shapes, [m.x0, m.x1]);
  return m;
}

test('2분쉼표 + [8분쉼표, 32분, 점16분] + [8분, 32분, 점16분] (Desert Eagle 4마디 모양)', () => {
  // 쉼표 기호는 타브 안에, 빔에 묶인 8분쉼표는 자기 기둥이 있음
  const shapes = [stub(72), stem(101), stem(110), stem(114), beam(100.8, 114.2, 0), beam(109.8, 114.2, 1), beam(110.2, 113.8, 2),
    stem(130), stem(140), stem(148), beam(129.8, 148.2, 0), beam(139.8, 148.2, 1), beam(140.2, 147.8, 2)];
  const texts = [G(0xE4E4, 68, 150), G(0xE4E6, 97, 150), DOT(116), DOT(150)];
  const m = read(M([beat(110), beat(114, 2, 7), beat(130, 1, 5), beat(140, 1, 7), beat(148, 1, 9)]), shapes, texts);
  assert.strictEqual(durs(m), '32 16. 8 32 16.');
  assert.deepStrictEqual(m.rests.map(r => r.dur), [2, 8]);
});

test('짧은 기둥 = 2분음표, 기둥 없음 = 온음표, 꼬리 글자 = 8분', () => {
  const m = read(M([beat(80), beat(160)]), [stub(80), stem(160), stem(200), stem(220)], [G(0xE241, 160, YB)]);
  assert.strictEqual(durs(m), '2 8');
  const m2 = read(M([beat(80)]), [stem(160), stem(200), stem(220)]);
  assert.strictEqual(durs(m2), '1');
});

test('숫자 없는 기둥 + 붙임줄 = 앞 음이 이어진 음 (새로 치지 않음)', () => {
  const tie = S(82, 137, 104, 139, { kind: 'F', curve: true, n: 9 });
  const m = read(M([beat(80), beat(130)]), [stem(80), stem(105), beam(104.8, 130.2, 0), stem(130), tie], [DOT(107)]);
  assert.strictEqual(m.beats.length, 3);
  assert.ok(m.beats[1].tieFromPrev);
  assert.strictEqual(durs(m), '4 8. 8');
});

test('숫자 없는 기둥이라도 쉼표 기둥이면 음을 만들지 않음', () => {
  const m = read(M([beat(80), beat(130)]), [stem(80), stem(105), stem(130), beam(104.8, 130.2, 0)], [G(0xE4E6, 102, 150)]);
  assert.strictEqual(m.beats.length, 2);
  assert.strictEqual(m.rests.length, 1);
});

test('셋잇단 숫자 3 은 가장 가까운 3개에만 (빔이 더 길어도)', () => {
  const xs = [100, 110, 120, 130, 140];
  const shapes = xs.map(stem).concat([beam(99.8, 140.2, 0), beam(99.8, 140.2, 1)]);
  const m = read(M(xs.map(x => beat(x))), shapes, [{ str: '3', x: 108, y: YB - 8, w: 4, h: 6 }]);
  assert.deepStrictEqual(m.beats.map(b => !!b.trip), [true, true, true, false, false]);
});

test('점은 바로 왼쪽 기둥의 것 (다음 기둥 너머로 넘어가지 않음)', () => {
  const m = read(M([beat(100), beat(104), beat(150)]), [stem(100), stem(104), stem(150), stem(200), beam(99.8, 104.2, 0), beam(99.8, 104.2, 1), beam(100.2, 103.8, 2)], [DOT(106)]);
  assert.strictEqual(durs(m).split(' ').slice(0, 2).join(' '), '32 16.');
});

test('원본 피킹 기호(⊓ V)와 스타카토 읽기', () => {
  const m = read(M([beat(100), beat(140)]), [stem(100), stem(140), stem(200)], [G(0xE610, 98, 175), G(0xE612, 138, 175), G(0xE4A2, 98, 168)]);
  assert.strictEqual(m.beats[0].srcPick, 'd');
  assert.strictEqual(m.beats[1].srcPick, 'u');
  assert.ok(m.beats[0].stac);
});
