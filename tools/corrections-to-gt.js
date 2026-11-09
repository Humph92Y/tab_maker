#!/usr/bin/env node
// ===== 사용자 수정 기록 → 회귀 테스트 정답 후보 =====
// 앱의 [📤 수정 기록 내보내기] 파일을 정답 파일(.gt.json)에 "review"(검토 대기) 마디로 넣음.
//  - review 마디는 채점에 들어가지 않음. 원본 PDF와 대조해 맞으면 "status": "verified" 로 바꿀 것
//  - verified 마디는 덮어쓰지 않음. 같은 PDF인지 docHash(SHA-256)로 확인
//  node tools/corrections-to-gt.js <수정기록.json> <정답.gt.json> [--pdf 원본.pdf]
'use strict';
const fs = require('fs'), crypto = require('crypto');
const [corrFile, gtFile] = process.argv.slice(2);
const pdfIdx = process.argv.indexOf('--pdf');
if (!corrFile || !gtFile) { console.error('사용법: node tools/corrections-to-gt.js <수정기록.json> <정답.gt.json> [--pdf 원본.pdf]'); process.exit(2); }
const corr = JSON.parse(fs.readFileSync(corrFile, 'utf8'));
if (corr.format !== 'tabmaker-corrections/1') { console.error('수정 기록 파일이 아니에요'); process.exit(2); }
const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
if (pdfIdx > 0) {
  const h = crypto.createHash('sha256').update(fs.readFileSync(process.argv[pdfIdx + 1])).digest('hex');
  if (corr.docHash && h !== corr.docHash) { console.error('다른 PDF의 수정 기록이에요 (지문이 달라요)'); process.exit(1); }
}
let added = 0, kept = 0;
corr.corrections.forEach(c => {
  let m = gt.measures.find(x => x.n === c.n);
  if (m && m.status === 'verified') { kept++; return; }
  const ev = c.corrected;
  if (!m) { m = { n: c.n }; gt.measures.push(m); }
  Object.assign(m, { status: 'review', by: 'user-correction', at: corr.created, events: ev });
  delete m.hash; added++;
});
gt.measures.sort((a, b) => a.n - b.n);
fs.writeFileSync(gtFile, JSON.stringify(gt, null, 1) + '\n');
console.log(`검토 대기(review)로 넣은 마디 ${added}개, 이미 verified 라서 그대로 둔 마디 ${kept}개`);
