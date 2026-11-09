// 전체 회귀 검사 (node --test): 인식 코드를 바꿔도 전에 맞던 마디·점수가 나빠지지 않았는지
//  - 저장소 안: tests/fixtures (Verovio 합성 시험 악보), tests/fixtures-scan (스캔 시험 악보)
//  - 실제 악보: TAB_REGRESS_DIR 폴더 (저작권 때문에 저장소 밖. 있을 때만)
//  자세한 표는: node tools/regress.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const E = require('./regress/evaluate.js');

const dirs = [path.join(__dirname, 'fixtures'), path.join(__dirname, 'fixtures-scan')];
if (process.env.TAB_REGRESS_DIR) dirs.push(process.env.TAB_REGRESS_DIR);

for (const dir of dirs) {
  const docs = E.loadCorpus(dir), base = E.readBaseline(dir);
  for (const doc of docs) {
    test(`회귀: ${doc.gt.id}`, async () => {
      const d = await E.evaluateDoc(doc.gt, doc.pdf), b = base.docs[d.id];
      assert.ok(b, `기준(baseline.json)에 없는 악보예요. node tools/regress.js --update 로 기준을 만드세요`);
      const c = E.compare(d, b);
      const msg = [];
      if (c.newlyFail.length) msg.push('전에 맞던 마디가 틀림: ' + c.newlyFail.map(n => `${n}마디(${(d.diffs[n] || []).join('; ')})`).join(' / '));
      if (c.regressed.length) msg.push('점수가 내려감: ' + c.regressed.join(', '));
      if (c.metaNew.length) msg.push('박자표·템포·튜닝: ' + c.metaNew.join(', '));
      if (d.expect !== 'unsupported') assert.deepStrictEqual(msg, [], msg.join('\n'));
      // ⚠ 표시 없이 틀린 마디는 늘어나면 안 됨
      assert.ok(d.expect === 'unsupported' || d.silentWrong.every(n => !(b.exactList || []).includes(n)), '⚠ 없이 틀린 마디: ' + d.silentWrong.join(','));
    });
  }
}
