#!/usr/bin/env node
// ===== PDF 인식 전체 회귀 검사 =====
// 인식 코드를 고칠 때마다 "전체"를 돌려서, 악보(PDF)마다 좋아진 점과 나빠진 점을 따로 보여줌.
//
//  node tools/regress.js                 저장소 안의 시험 악보 + TAB_REGRESS_DIR 의 실제 악보
//  node tools/regress.js --dir 폴더       다른 말뭉치 폴더 추가 (여러 번 가능)
//  node tools/regress.js --update        지금 결과를 새 기준(baseline.json)으로 저장 (나빠진 것이 없을 때만)
//  node tools/regress.js --update --force 나빠진 것이 있어도 저장 (이유를 꼭 기록할 것)
//  node tools/regress.js --json 파일      결과를 JSON 으로 저장
//  node tools/regress.js --only 이름      id 에 이 글자가 들어간 악보만 (빠른 확인용. 최종 확인은 꼭 전체로)
//
// 저작권이 있는 실제 악보 PDF와 그 정답은 저장소에 넣지 않고 TAB_REGRESS_DIR 폴더에 둠.
// 끝날 때 나빠진 것이 하나라도 있으면 종료 코드 1.
'use strict';
const fs = require('fs'), path = require('path');
const E = require('../tests/regress/evaluate.js');

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const vals = n => args.flatMap((a, i) => a === n && args[i + 1] ? [args[i + 1]] : []);
const ROOT = path.join(__dirname, '..');
const dirs = [path.join(ROOT, 'tests/fixtures'), path.join(ROOT, 'tests/fixtures-scan')];
if (process.env.TAB_REGRESS_DIR) dirs.push(process.env.TAB_REGRESS_DIR);
dirs.push(...vals('--dir'));
const only = vals('--only')[0];

const pct = v => v == null ? '   -  ' : (v * 100).toFixed(1).padStart(5) + '%';
const delta = (a, b) => a == null || b == null ? '' : Math.abs(b - a) < 1e-9 ? '' : ` (${b > a ? '+' : ''}${((b - a) * 100).toFixed(1)})`;

async function main() {
  const report = { time: new Date().toISOString(), corpora: [] };
  let regressions = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const docs = E.loadCorpus(dir).filter(d => !only || d.gt.id.includes(only));
    if (!docs.length) continue;
    const base = E.readBaseline(dir), next = { updated: new Date().toISOString(), docs: Object.assign({}, base.docs) };
    const cr = { dir, docs: [] };
    console.log(`\n=== ${path.relative(ROOT, dir) || dir} (${docs.length}개 악보) ===`);
    // 출처별 합계
    const bySrc = {};
    for (const doc of docs) {
      const d = await E.evaluateDoc(doc.gt, doc.pdf);
      const b = base.docs[d.id], cmp = E.compare(d, b), m = E.metrics(d), bm = b ? b.metrics : {};
      const unsupported = d.expect === 'unsupported';
      const bad = !unsupported && (cmp.newlyFail.length || cmp.regressed.length || cmp.metaNew.length);
      if (bad) regressions++;
      const s = bySrc[d.source] = bySrc[d.source] || { docs: 0, sums: {}, verified: 0, exact: 0 };
      s.docs++; s.verified += d.verified; s.exact += d.exact; if (d.sums) Object.entries(d.sums).forEach(([k, v]) => s.sums[k] = (s.sums[k] || 0) + v);
      const tag = d.error ? `오류: ${d.error}` : `마디 ${d.measures}개, ⚠ ${d.checkCount}개`;
      console.log(`\n▶ ${d.id}  [${d.source}${d.detected && d.detected !== d.source ? ' / 감지: ' + d.detected : ''}]${unsupported ? ' (아직 지원 안 함)' : ''}  ${tag}`);
      if (d.verified) {
        console.log(`   확인된 마디 완전 일치 ${d.exact}/${d.verified} = ${pct(m.measureAcc)}${delta(bm.measureAcc, m.measureAcc)}`);
        console.log(`   쉼표   정밀도 ${pct(m.restP)}${delta(bm.restP, m.restP)}  재현율 ${pct(m.restR)}${delta(bm.restR, m.restR)}   (정답 쉼표 ${d.sums.gtRest}, 찾은 쉼표 ${d.sums.pRest})`);
        console.log(`   시작점 정밀도 ${pct(m.onsetP)}${delta(bm.onsetP, m.onsetP)}  재현율 ${pct(m.onsetR)}${delta(bm.onsetR, m.onsetR)}   길이 정확 ${pct(m.durAcc)}${delta(bm.durAcc, m.durAcc)}` +
          (m.notesAcc != null ? `   프렛 ${pct(m.notesAcc)}${delta(bm.notesAcc, m.notesAcc)}` : '') + (m.typeAcc != null ? `   기호 ${pct(m.typeAcc)}${delta(bm.typeAcc, m.typeAcc)}` : '') + (m.techAcc != null ? `   주법 ${pct(m.techAcc)}` : ''));
      }
      if (d.metaChecks) console.log(`   박자표·템포·튜닝 ${d.metaChecks - d.metaFail.length}/${d.metaChecks}${d.metaFail.length ? '  ✗ ' + d.metaFail.join(', ') : ''}`);
      if (Object.keys(d.snapshot).length) console.log(`   확인 안 된 마디(지문 비교) ${Object.keys(d.snapshot).length}개, 바뀐 마디: ${cmp.snapshotChanged.length ? cmp.snapshotChanged.join(', ') : '없음'}`);
      if (d.silentWrong.length) console.log(`   ⚠ 표시 없이 틀린 마디: ${d.silentWrong.join(', ')}`);
      if (cmp.isNew) console.log('   (기준 없음: 처음 검사)');
      if (cmp.improved.length || cmp.newlyPass.length || cmp.metaFixed.length) console.log(`   ✅ 좋아짐: ${[...cmp.improved, ...(cmp.newlyPass.length ? ['새로 맞은 마디 ' + cmp.newlyPass.join(',')] : []), ...cmp.metaFixed].join(' / ')}`);
      if (cmp.regressed.length || cmp.newlyFail.length || cmp.metaNew.length) console.log(`   ❌ 나빠짐: ${[...cmp.regressed, ...(cmp.newlyFail.length ? ['전에 맞던 마디 ' + cmp.newlyFail.join(',')] : []), ...cmp.metaNew].join(' / ')}`);
      cmp.newlyFail.forEach(n => console.log(`      ${n}마디: ${(d.diffs[n] || []).join('; ')}`));
      if (flag('--verbose')) d.failList.forEach(n => console.log(`      ${n}마디: ${(d.diffs[n] || []).join('; ')}`));
      cr.docs.push({ id: d.id, source: d.source, detected: d.detected, error: d.error, metrics: m, verified: d.verified, exact: d.exact, failList: d.failList, silentWrong: d.silentWrong, metaFail: d.metaFail, compare: cmp, checkCount: d.checkCount });
      next.docs[d.id] = E.baselineEntry(d);
    }
    console.log('\n--- 출처별 합계 ---');
    Object.entries(bySrc).forEach(([src, s]) => {
      const m = E.metrics({ sums: s.sums, exact: s.exact, verified: s.verified });
      console.log(`${src.padEnd(10)} 악보 ${s.docs}  마디 ${s.exact}/${s.verified}  쉼표 P ${pct(m.restP)} R ${pct(m.restR)}  시작점 P ${pct(m.onsetP)} R ${pct(m.onsetR)}  길이 ${pct(m.durAcc)}`);
    });
    report.corpora.push(cr);
    if (flag('--update')) {
      if (regressions && !flag('--force')) console.log('\n나빠진 것이 있어 기준을 저장하지 않았어요 (--force 로 강제)');
      else if (only) console.log('\n--only 로 일부만 검사해서 기준을 저장하지 않았어요');
      else { fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify(next, null, 1) + '\n'); console.log(`\n기준 저장: ${path.join(dir, 'baseline.json')}`); }
    }
  }
  if (vals('--json')[0]) fs.writeFileSync(vals('--json')[0], JSON.stringify(report, null, 1));
  console.log(regressions ? `\n❌ 나빠진 악보 ${regressions}개 — 위 내용을 확인하세요` : '\n✅ 나빠진 악보 없음');
  process.exit(regressions ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
