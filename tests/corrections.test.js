// 사용자 수정 기록: 켰을 때만 기록, 고친 마디만 비교, 제목은 저장하지 않음
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

function load() {
  const store = {};
  const ctx = { console, Math, JSON, Date, module: {}, Array, Uint8Array, crypto: require('crypto').webcrypto,
    localStorage: { getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/model.js'), 'utf8') + ';\n' + fs.readFileSync(path.join(__dirname, '../js/corrections.js'), 'utf8') + ';this.L=OmrLog;', ctx);
  return { ctx, store };
}
function song(ctx) {
  const s = ctx.newSong(); s.title = '비밀 제목';
  const m = ctx.newMeasure(); m.beats = [];
  [4, 4, 4, 4].forEach((d, i) => { const b = ctx.newBeat(d); b.notes.push(ctx.newNote(0, i + 1)); m.beats.push(b); });
  s.measures = [m, ctx.newMeasure()];
  return s;
}

test('꺼져 있으면 아무것도 기록하지 않음', async () => {
  const { ctx, store } = load(); const s = song(ctx);
  assert.strictEqual(await ctx.L.recordImport(s, new Uint8Array([1, 2, 3]), {}), null);
  assert.strictEqual(s.omrRef, undefined);
  assert.deepStrictEqual(Object.keys(store), []);
});

test('켜면 기록하고, 고친 마디만 내보내며, 제목은 저장하지 않음', async () => {
  const { ctx, store } = load(); const s = song(ctx);
  ctx.L.setOn(true);
  const id = await ctx.L.recordImport(s, new Uint8Array([1, 2, 3]), { source: 'guitarpro', pages: 1 });
  assert.ok(id && s.omrRef === id);
  assert.ok(!store['gtab-omr-log'].includes('비밀 제목'));
  assert.strictEqual(ctx.L.diff(s).corrections.length, 0);
  // 1마디: 4분 두 개를 8분 + 쉼표로 고침
  const m = s.measures[0]; m.beats[1].dur = 8; const r = ctx.newBeat(8); m.beats.splice(2, 0, r);
  const d = ctx.L.diff(s);
  assert.strictEqual(d.format, 'tabmaker-corrections/1');
  assert.strictEqual(d.docHash, '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81'); // sha256(1,2,3)
  assert.strictEqual(d.corrections.length, 1);
  assert.strictEqual(d.corrections[0].n, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(d.corrections[0].corrected.map(e => [e.on, e.dur, e.type]))), [[0, 480, 'note'], [480, 240, 'note'], [720, 240, 'rest'], [960, 480, 'note'], [1440, 480, 'note']]);
  ctx.L.clear(); assert.strictEqual(ctx.L.count(), 0);
});
