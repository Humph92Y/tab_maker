// ===== PDF 인식 수정 기록 (사용자가 켰을 때만, 이 기기에만) =====
// PDF로 불러온 직후의 인식 결과를 이 기기(브라우저 저장소)에 적어 두고,
// 사용자가 고친 뒤 "내보내기"를 누르면 [인식 결과 → 고친 결과]를 마디별로 비교한 파일을 만들어 줌.
//  - 기본은 꺼짐. 켜야만 기록함
//  - 인터넷으로 보내지 않음. 파일로 내보낸 것을 사용자가 직접 전달할 때만 밖으로 나감
//  - 곡 제목·가수·파일 이름은 기록하지 않음 (PDF 내용의 지문(SHA-256)만 기록 → 같은 PDF인지 구분용)
//  - 이 기록은 나중에 회귀 테스트 정답(tools/corrections-to-gt.js)이나 분류기 학습 자료 후보로 쓸 수 있음.
//    앱이 이 기록으로 스스로 배우지는 않음 (학습·모델 갱신 기능은 없음)
const OmrLog = (() => {
  const KEY_ON = 'gtab-omr-log-on', KEY = 'gtab-omr-log', MAX = 10;
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const put = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (e) { return false; } };
  const isOn = () => get(KEY_ON) === '1';
  const setOn = on => put(KEY_ON, on ? '1' : null);
  const list = () => { try { return JSON.parse(get(KEY) || '[]'); } catch (e) { return []; } };
  const save = l => put(KEY, JSON.stringify(l.slice(-MAX)));

  // 회귀 테스트 정답과 같은 모양의 사건 목록 (tests/regress/evaluate.js 의 songEvents 와 같은 규칙)
  function events(m) {
    let t = 0;
    return m.beats.map(b => {
      const d = beatTicks(b);
      const e = { on: t, dur: d, type: b.grace ? 'grace' : b.slash ? 'slash' : !b.notes.length ? 'rest' : b.notes.every(n => n.tie) ? 'tie' : 'note', value: b.dur, dot: b.dot === 2 ? 2 : b.dot ? 1 : 0 };
      if (b.trip) e.tuplet = 3;
      if (b.notes.length) e.notes = b.notes.map(n => n.s + ':' + n.f).sort();
      t += d; return e;
    });
  }
  async function sha256(buf) {
    try { const h = await crypto.subtle.digest('SHA-256', buf); return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, '0')).join(''); }
    catch (e) { return null; }
  }
  // PDF를 불러온 직후 호출. 켜져 있을 때만 기록하고 곡에 기록 번호를 붙임
  async function recordImport(song, pdfBytes, info) {
    if (!isOn()) return null;
    const id = 'omr-' + Date.now().toString(36);
    const entry = { id, time: new Date().toISOString(), docHash: await sha256(pdfBytes), source: info && info.source || null, pages: info && info.pages || null,
      measures: song.measures.map(m => ({ check: !!m.check, ev: events(m) })) };
    const l = list(); l.push(entry);
    if (!save(l)) return null; // 저장 공간이 모자라면 기록하지 않음
    song.omrRef = id;
    return id;
  }
  // 지금 곡과 불러올 때의 인식 결과를 비교 → 바뀐 마디만
  function diff(song) {
    const e = song && song.omrRef && list().find(x => x.id === song.omrRef);
    if (!e) return null;
    const out = [];
    const n = Math.max(e.measures.length, song.measures.length);
    for (let i = 0; i < n; i++) {
      const a = e.measures[i] ? e.measures[i].ev : [], b = song.measures[i] ? events(song.measures[i]) : [];
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ n: i + 1, flagged: !!(e.measures[i] && e.measures[i].check), recognized: a, corrected: b });
    }
    return { format: 'tabmaker-corrections/1', created: new Date().toISOString(), docHash: e.docHash, source: e.source, pages: e.pages, importedAt: e.time,
      note: '사용자가 PDF 인식 결과를 고친 마디. 마디 수가 바뀌었으면(마디 추가·삭제) 뒤쪽 번호가 밀릴 수 있음. 확인 후 회귀 테스트 정답으로 옮길 것',
      measures: e.measures.length, corrections: out };
  }
  const count = () => list().length;
  const clear = () => put(KEY, null);
  return { isOn, setOn, recordImport, diff, count, clear, events };
})();
if (typeof module !== 'undefined') module.exports = OmrLog;
