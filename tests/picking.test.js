// 피킹 추천 테스트: 실제로 치는 음(어택)과 방향(⊓ 다운 / V 업)
// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const ctx = { console, Math, JSON };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/model.js'), 'utf8'), ctx);
const { newSong, newMeasure, newBeat, newNote, suggestPicking, pickPlan } = ctx;

// 악보 쓰기: 한 마디 = 문자열 배열. 예) '16:2/9' = 16분음표 2번줄 9프렛
//  '8.:..' 점, '8..:..' 겹점, '8t:..' 셋잇단, 'r8' 쉼표, 'g:..' 꾸밈음
//  음 뒤 표시: '~' 붙임줄(앞 음에서 이어짐), 'h' 다음 음으로 해머/풀, 's' 다음 음으로 슬라이드, 'x' 데드, '()' 고스트
//  화음은 '+' 로: '8:3/5+2/7'
function song(measures, o = {}) {
  const s = newSong(); s.ts = o.ts || [4, 4];
  s.measures = measures.map((ms, i) => {
    const m = newMeasure(); if (o.mts && o.mts[i]) m.ts = o.mts[i];
    m.beats = ms.map(tok => {
      if (tok.startsWith('r')) return newBeat(+tok.slice(1));
      const [d, ns] = tok.split(':');
      const grace = d === 'g';
      const b = newBeat(grace ? 8 : parseInt(d, 10));
      if (grace) b.grace = true;
      if (/\.\./.test(d)) b.dot = 2; else if (/\./.test(d)) b.dot = true;
      if (/t/.test(d)) b.trip = true;
      ns.split('+').forEach(nt => {
        const mm = nt.match(/^(\d)\/(\(?)(\d+)\)?([~hsx!]*)$/);
        const n = newNote(+mm[1], +mm[3]);
        if (mm[2]) n.ghost = true;
        if (mm[4].includes('~')) n.tie = true;
        if (mm[4].includes('h')) n.hp = true;
        if (mm[4].includes('s')) n.slide = 'to';
        if (mm[4].includes('x')) n.dead = true;
        if (mm[4].includes('!')) n.stac = true;
        b.notes.push(n);
      });
      return b;
    });
    return m;
  });
  return s;
}
// 결과를 "⊓ V - ..." 처럼 (어택 아님 = '-')
const dirs = (s, mode) => pickPlan(s, mode).map(e => e.dir ? (e.dir === 'd' ? 'D' : 'U') : '-').join(' ');
const attacks = (s) => pickPlan(s, 'rhythm').map(e => e.attack ? 1 : 0).join('');

test('질문의 예: 9 10 12 (12) 9 10 (10) 12 — 붙임줄 음은 치지 않고 차례도 넘기지 않음', () => {
  // 16분음표 8개 (한 박 반 + …) 로 가정한 리듬. 실제 원본 리듬은 데이터에 따라 달라짐
  const s = song([['16:2/9', '16:2/10', '16:2/12', '16:2/12~', '16:2/9', '16:2/10', '16:2/10~', '16:2/12', '4:2/7', '4:2/7']]);
  assert.strictEqual(attacks(s), '1110110111');
  // 박자 맞춤: 16분 칸 위치 그대로 (붙임줄 자리도 손은 계속 움직임)
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D - D U - U D D');
  // 무조건 번갈아: 치는 음끼리만 번갈아
  assert.strictEqual(dirs(s, 'strict'), 'D U D - U D - U D U');
});

test('8분음표 연속: ⊓ V ⊓ V …', () => {
  const s = song([['8:2/5', '8:2/7', '8:2/5', '8:2/7', '8:2/5', '8:2/7', '8:2/5', '8:2/7']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D U D U');
  assert.strictEqual(dirs(s, 'strict'), 'D U D U D U D U');
});

test('16분음표 연속: 1 e & a = ⊓ V ⊓ V', () => {
  const s = song([Array(16).fill('16:1/5')]);
  assert.strictEqual(dirs(s, 'rhythm'), Array(8).fill('D U').join(' '));
});

test('8분 + 16분 16분 (갤럽): ⊓ ⊓ V — 8분 뒤 16분은 박 안 위치로', () => {
  const s = song([['8:2/5', '16:2/7', '16:2/8', '8:2/5', '16:2/7', '16:2/8', '2:2/5']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D D U D D U D');
  assert.strictEqual(dirs(s, 'strict'), 'D U D U D U D');
});

test('점8분 + 16분: ⊓ V (16분은 박의 마지막 칸 = 업)', () => {
  const s = song([['8.:2/5', '16:2/7', '8.:2/5', '16:2/7', '2:2/5']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D');
});

test('쉼표: 기호를 붙이지 않고, 박자 맞춤에서는 손이 계속 움직여 다음 음이 업이 될 수 있음', () => {
  const s = song([['r8', '8:2/5', 'r8', '8:2/7', '4:2/5', '4:2/7']]);
  assert.strictEqual(dirs(s, 'rhythm'), '- U - U D D');
  assert.strictEqual(dirs(s, 'strict'), '- D - U D U');
  suggestPicking(s, 'rhythm');
  assert.strictEqual(s.measures[0].beats[0].pa, null);
});

test('당김음 (8분 4분 8분): 엇박의 음은 업', () => {
  const s = song([['8:2/5', '4:2/7', '8:2/5', '2:2/7']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U U D');
});

test('해머/풀 도착음은 치지 않음, 그 다음 음은 박 위치대로', () => {
  const s = song([['16:3/5h', '16:3/7', '16:3/5', '16:3/7', '4:3/5', '2:3/5']]);
  assert.strictEqual(attacks(s), '101111');
  assert.strictEqual(dirs(s, 'rhythm'), 'D - D U D D');
  assert.strictEqual(dirs(s, 'strict'), 'D - U D U D');
});

test('슬라이드(sl.)로 이어지는 도착음은 치지 않음, 그냥 슬라이드 인 음은 침', () => {
  const s = song([['8:2/5s', '8:2/7', '8:2/9', '8:2/7', '2:2/5']]);
  assert.strictEqual(attacks(s), '10111');
});

test('화음은 한 번의 어택 (음 개수만큼 번갈아 치지 않음)', () => {
  const s = song([['8:3/5+2/5+1/3', '8:3/5+2/5+1/3', '8:3/5+2/5+1/3', '8:3/5+2/5+1/3', '2:3/5+2/5']]);
  assert.strictEqual(dirs(s, 'strict'), 'D U D U D');
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D');
});

test('화음 중 일부만 붙임줄이면 새로 치는 음이 있으므로 어택', () => {
  const s = song([['2:3/5+2/7', '2:3/5~+2/9']]);
  assert.strictEqual(attacks(s), '11');
});

test('고스트·데드·스타카토 음도 치는 음', () => {
  const s = song([['8:2/(5)', '8:2/0x', '8:2/7!', '8:2/5', '2:2/5']]);
  assert.strictEqual(attacks(s), '11111');
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D');
});

test('마디를 넘어 이어지는 붙임줄: 다음 마디 첫 음은 치지 않음, 방향은 마디마다 리셋되지 않음 (번갈아)', () => {
  const s = song([['4:2/5', '4:2/5', '4:2/5', '8:2/5', '8:2/7'], ['8:2/7~', '8:2/5', '4:2/5', '2:2/5']]);
  assert.strictEqual(dirs(s, 'strict'), 'D U D U D - U D U');
  assert.strictEqual(dirs(s, 'rhythm'), 'D D D D U - U D D');
});

test('셋잇단 8분: 한 박에 ⊓ V ⊓', () => {
  const s = song([['8t:2/5', '8t:2/7', '8t:2/8', '8t:2/5', '8t:2/7', '8t:2/8', '2:2/5']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D D U D D');
});

test('6/8 박자: 점4분 한 박 안에서 8분 ⊓ V ⊓', () => {
  const s = song([['8:2/5', '8:2/7', '8:2/8', '8:2/5', '8:2/7', '8:2/8']], { ts: [6, 8] });
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D D U D');
});

test('못갖춘마디: 마지막 8분 하나로 시작하면 엇박 = 업', () => {
  const s = song([['8:2/5'], ['4:2/5', '4:2/7', '2:2/5']], { mts: [[1, 8], [4, 4]] });
  assert.strictEqual(dirs(s, 'rhythm'), 'U D D D');
});

test('같은 줄 반복 / 줄 바꾸기: 방향은 리듬으로 정함 (줄에 따라 바꾸지 않음)', () => {
  const s = song([['8:3/5', '8:2/5', '8:3/5', '8:2/5', '8:1/5', '8:1/5', '4:2/5']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D U D');
});

test('직접 입력한 피킹은 그대로, 추천은 pa 에만', () => {
  const s = song([['8:2/5', '8:2/7', '8:2/5', '8:2/7', '2:2/5']]);
  s.measures[0].beats[1].pick = 'd'; // 사용자가 일부러 다운
  suggestPicking(s, 'rhythm');
  assert.strictEqual(s.measures[0].beats[1].pick, 'd');
  assert.strictEqual(s.measures[0].beats[1].pa, 'u');
  // 번갈아 모드는 직접 입력한 방향 다음부터 반대로 이어감
  assert.strictEqual(dirs(s, 'strict'), 'D D U D U');
  suggestPicking(s, 'strict');
  assert.strictEqual(s.measures[0].beats[1].pick, 'd');
});

test('추천은 음표 길이·음을 바꾸지 않음', () => {
  const s = song([['8.:2/5', '16:2/7', 'r8', '8:2/5~', '2:2/5']]);
  const before = JSON.stringify(s.measures.map(m => m.beats.map(b => [b.dur, b.dot, b.notes.map(n => [n.s, n.f, !!n.tie])])));
  suggestPicking(s, 'rhythm'); suggestPicking(s, 'strict');
  const after = JSON.stringify(s.measures.map(m => m.beats.map(b => [b.dur, b.dot, b.notes.map(n => [n.s, n.f, !!n.tie])])));
  assert.strictEqual(after, before);
});

test('예전 문제 재현: 32분음표가 섞여도 8분 엇박은 업 (예전에는 모두 다운)', () => {
  // 5(32분)→7 해머, (7) 붙임줄, 쉼표, 7(32분)→9 해머, 쉼표, 7(16분)→9 슬라이드
  const s = song([['32:2/5h', '8..:2/7', '8:2/7~', 'r8', '32:2/7h', '8..:2/9', 'r8', '16:2/7s', '16.:2/9']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D - - - D - - U -');
});

test('예전 문제 재현: 마디 끝에 16분 한 쌍만 있어도 앞의 8분 엇박은 업 (예전에는 마디 전체가 16분 칸이 되어 모두 다운)', () => {
  const s = song([['8:2/5', '8:2/7', '8:2/5', '8:2/7', '8:2/5', '8:2/7', '16:2/5', '16:2/7', '8:2/5']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D U D U D U D');
});

test('예전 문제 재현: 치지 않는 붙임줄 음의 위치가 칸 크기를 바꾸지 않음', () => {
  const s = song([['8:2/5', '8:2/7', '8:2/5', '32:2/5~', '16.:2/5', '4:2/5', '4:2/7']]);
  assert.strictEqual(dirs(s, 'rhythm'), 'D U D - U D D');
});
