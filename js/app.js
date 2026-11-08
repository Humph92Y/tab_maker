// ===== 편집기 동작 (클릭, 키보드, 메뉴) =====
let song;
let sel = { mi: 0, bi: 0, s: 0 };
let pending = '';
let mode = null; // {type:'slide'|'hp', from: note, fromPos}
let inputDur = 8;
let undoStack = [], redoStack = [];
let printMode = false;
let layout = null;
let popupInfo = null;

const $ = id => document.getElementById(id);
const scoreEl = $('score');

// ---------- 저장/복원 ----------
function autosave() { try { localStorage.setItem('gtab-autosave', JSON.stringify(song)); } catch (e) { } }
function loadAutosave() {
  try { const t = localStorage.getItem('gtab-autosave'); if (t) { const s = JSON.parse(t); if (s && s.measures) return fixSong(s); } } catch (e) { }
  return null;
}
function fixSong(s) {
  const d = newSong();
  s.view = Object.assign(d.view, s.view || {});
  ['bpm', 'ts', 'tuning', 'tone', 'title', 'artist'].forEach(k => { if (s[k] === undefined) s[k] = d[k]; });
  s.fx = Object.assign(d.fx, s.fx || {});
  if (!TUNINGS[s.tuning]) s.tuning = 'standard';
  if (!s.measures || !s.measures.length) s.measures = [newMeasure()];
  return s;
}

function snapshot() { undoStack.push(JSON.stringify(song)); if (undoStack.length > 300) undoStack.shift(); redoStack = []; }
function mutate(fn) { snapshot(); fn(); changed(); }
function undo() { if (!undoStack.length) return status('더 이상 되돌릴 것이 없어요'); redoStack.push(JSON.stringify(song)); song = JSON.parse(undoStack.pop()); clampSel(); changed(true); status('되돌렸어요 (Ctrl+Z)'); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(song)); song = JSON.parse(redoStack.pop()); clampSel(); changed(true); status('다시 실행했어요'); }

function changed(syncUi) {
  if (song.view.fingers) Fingering.suggest(song);
  if (song.view.picks) suggestPicking(song);
  autosave();
  teachCache = null;
  if (syncUi) { syncToolbar(); lastMi = sel.mi; }
  render();
  if (popupInfo) reopenPopup();
}

function clampSel() {
  sel.mi = Math.max(0, Math.min(sel.mi, song.measures.length - 1));
  sel.bi = Math.max(0, Math.min(sel.bi, song.measures[sel.mi].beats.length));
  sel.s = Math.max(0, Math.min(5, sel.s));
}

// ---------- 그리기 ----------
let lastMi = 0;
function render() {
  if (lastMi !== sel.mi) { const prev = lastMi; lastMi = sel.mi; if (autoFitLeft(prev)) return; }
  const z = printMode ? 1 : touchZoom();
  layout = renderScore(scoreEl, song, { sel, pending, mode: mode && { from: mode.from }, print: printMode, width: printMode ? 760 : scoreEl.clientWidth / z });
  if (z !== 1) scoreEl.querySelectorAll('svg.system').forEach(v => { v.style.width = (+v.getAttribute('width') * z) + 'px'; v.style.height = (+v.getAttribute('height') * z) + 'px'; });
  renderTeacher();
  keepCursorVisible();
  updateDurButtons();
  updateLegend();
  updateMeasureInfo();
}

function curBeat() { return song.measures[sel.mi].beats[sel.bi]; }
function curNote() { return noteAt(curBeat(), sel.s); }

// ---------- 상태 메시지 ----------
let statusTimer;
function status(msg, warn) {
  const el = $('status'); el.textContent = msg; el.className = warn ? 'warn' : '';
  clearTimeout(statusTimer); statusTimer = setTimeout(() => { if (!mode) { el.textContent = ''; el.className = ''; } }, 5000);
}

function updateMeasureInfo() {
  const m = song.measures[sel.mi]; if (!m) return;
  const ts = measureTs(song, sel.mi), cap = measureCapacity(ts), fill = measureFill(m);
  const unit = 1920 / ts[1];
  const fmt = v => (Math.round(v / unit * 100) / 100);
  const prob = measureProblem(song, sel.mi);
  $('minfo').textContent = `${sel.mi + 1}번째 마디 · ${fmt(fill)} / ${ts[0]}박 채움` + (fill > cap ? ' (넘침! 눌러서 해결)' : prob === 'under' ? ' (모자람 · 눌러서 해결)' : fill === cap ? ' ✓' : '');
  $('minfo').className = prob ? 'warn' : '';
}

// ---------- 음 입력 ----------
function commitPending() {
  if (!pending) return false;
  const f = parseInt(pending, 10); pending = '';
  if (f > 24) { status('프렛은 0~24까지만 입력할 수 있어요', true); render(); return false; }
  mutate(() => {
    const m = song.measures[sel.mi];
    if (sel.bi >= m.beats.length || sel.bi === 0) { m.beats.push(newBeat(inputDur)); sel.bi = m.beats.length - 1; }
    const b = m.beats[sel.bi];
    const ex = noteAt(b, sel.s);
    if (ex) { ex.f = f; } else b.notes.push(newNote(sel.s, f));
  });
  previewAt(sel.mi, sel.bi, sel.s);
  return true;
}

function previewAt(mi, bi, s) {
  const n = noteAt(song.measures[mi].beats[bi], s);
  if (n && !Player.isPlaying() && $('previewOn').checked) Player.preview(noteMidi(song, n), song.tone, song.fx, song.bpm);
}

function moveRight() {
  const m = song.measures[sel.mi];
  if (sel.bi < m.beats.length) sel.bi++;
  else if (sel.mi < song.measures.length - 1) { sel.mi++; sel.bi = 0; }
}
function moveLeft() {
  if (sel.bi > 0) sel.bi--;
  else if (sel.mi > 0) { sel.mi--; sel.bi = Math.max(0, song.measures[sel.mi].beats.length - 1); }
}

function deleteNote() {
  const b = curBeat(); const n = curNote();
  if (!n) return status('지울 숫자가 없어요');
  mutate(() => { b.notes = b.notes.filter(x => x !== n); });
  closePopup();
  status('삭제했어요 (빈 칸은 쉼표가 돼요. 칸을 아예 없애려면 Shift+Delete)');
}
function deleteBeat() {
  const m = song.measures[sel.mi]; if (sel.bi >= m.beats.length) return;
  mutate(() => { m.beats.splice(sel.bi, 1); clampSel(); });
  closePopup(); status('칸을 삭제했어요');
}
function insertBeat() {
  const m = song.measures[sel.mi];
  mutate(() => { m.beats.splice(sel.bi, 0, newBeat(inputDur)); });
  status('새 칸을 끼워 넣었어요. 숫자를 입력하고 Enter (그냥 두면 쉼표)');
}

function splitMeasure() {
  mutate(() => {
    const m = song.measures[sel.mi];
    if (sel.bi >= m.beats.length || sel.bi === 0) {
      song.measures.splice(sel.mi + 1, 0, newMeasure()); sel.mi++; sel.bi = 0;
      status('새 마디를 만들었어요');
    } else {
      const nm = newMeasure(); nm.beats = m.beats.splice(sel.bi);
      song.measures.splice(sel.mi + 1, 0, nm); sel.mi++; sel.bi = 0;
      status('여기서 마디를 나눴어요');
    }
  });
}

// 주법 토글
function toggleNote(prop, val) {
  const n = curNote(); if (!n) return status('먼저 숫자(프렛)를 클릭해서 선택하세요', true);
  mutate(() => {
    if (prop === 'bend') {
      const order = [{ a: 1 }, { a: 0.5 }, { a: 1.5 }, { a: 1, r: true }, null];
      if (val !== undefined) n.bend = val;
      else { const i = n.bend ? order.findIndex(o => o && o.a === n.bend.a && !!o.r === !!n.bend.r) : -1; n.bend = order[(i + 1) % order.length]; }
      if (!n.bend) delete n.bend;
      status(n.bend ? `벤딩: ${bendLabel(n.bend.a)}${n.bend.r ? ' 후 릴리즈' : ''} (B를 다시 누르면 바뀌어요)` : '벤딩 해제');
    } else if (prop === 'slide') { n.slide = n.slide === val ? undefined : val; if (!n.slide) delete n.slide; }
    else { n[prop] = !n[prop]; if (!n[prop]) delete n[prop]; }
  });
}

function startLink(type) {
  const n = curNote();
  const name = type === 'slide' ? '슬라이드' : '해머온/풀오프';
  if (n && ((type === 'slide' && n.slide === 'to') || (type === 'hp' && n.hp))) {
    mutate(() => { if (type === 'slide') delete n.slide; else delete n.hp; });
    status(name + ' 연결을 해제했어요'); return;
  }
  if (n) { linkNext(type, sel.mi, sel.bi, n); return; }
  mode = { type, from: null, pos: null };
  closePopup();
  status(n ? `${name}: 이어질 다음 숫자를 클릭하세요 (Esc = 취소)` : `${name}: 시작할 숫자를 클릭하세요 (Esc = 취소)`);
  $('status').className = 'mode';
  render();
}
// 같은 줄의 "바로 다음" 숫자와 바로 연결 (클릭 안 해도 됨)
function linkNext(type, mi, bi, n) {
  const nx = nextOnString(song, mi, bi, n.s);
  const name = type === 'slide' ? '슬라이드' : '해머온/풀오프';
  if (!nx) { status(`${n.s + 1}번 줄에 이어질 다음 숫자가 없어요. ${name}는 같은 줄의 다음 숫자와 연결돼요`, true); return; }
  if (type === 'hp' && nx.note.f === n.f) { status('같은 프렛끼리는 해머/풀이 안 돼요. 붙임줄(tie)을 써보세요', true); return; }
  mutate(() => { if (type === 'slide') { n.slide = 'to'; delete n.hp; } else { n.hp = true; if (n.slide === 'to') delete n.slide; } });
  const kind = type === 'slide' ? '슬라이드' : (nx.note.f > n.f ? '해머온' : '풀오프');
  status(`✓ ${n.s + 1}번 줄 ${n.f} → ${nx.note.f} ${kind}로 연결했어요 (${nx.mi !== mi ? (nx.mi + 1) + '번째 마디의 ' : ''}같은 줄 다음 숫자)`);
}
// 같은 줄의 "바로 앞" 숫자에서 이 숫자로 연결
function linkPrev(type, mi, bi, n) {
  const pv = prevOnString(song, mi, bi, n.s);
  if (!pv) { status(`${n.s + 1}번 줄에서 이 숫자 앞에 숫자가 없어요`, true); return; }
  linkNext(type, pv.mi, pv.bi, pv.note);
}
function linkInfo(mi, bi, n) {
  const nx = nextOnString(song, mi, bi, n.s), pv = prevOnString(song, mi, bi, n.s);
  const parts = [];
  if (pv && (pv.note.slide === 'to' || pv.note.hp)) parts.push(`← 앞 ${pv.note.f}에서 ${pv.note.slide === 'to' ? '슬라이드' : (n.f > pv.note.f ? '해머온' : '풀오프')}로 들어옴`);
  if (nx && (n.slide === 'to' || n.hp)) parts.push(`→ 다음 ${nx.note.f}로 ${n.slide === 'to' ? '슬라이드' : (nx.note.f > n.f ? '해머온' : '풀오프')}`);
  return { nx, pv, text: parts.join(' · ') };
}
function completeLink(mi, bi, s) {
  const target = noteAt(song.measures[mi].beats[bi], s);
  if (!target) return;
  if (!mode.from) { mode.from = target; mode.pos = { mi, bi, s }; status('이제 이어질 다음 숫자를 클릭하세요 (Esc = 취소)'); $('status').className = 'mode'; render(); return; }
  const p = mode.pos;
  if (s !== p.s) { status('슬라이드/해머/풀은 같은 줄 위에서만 이어져요. 같은 줄의 숫자를 눌러주세요', true); return; }
  const nx = nextOnString(song, p.mi, p.bi, p.s);
  if (!nx || nx.note.id !== target.id) { status('같은 줄의 "바로 다음" 숫자를 눌러주세요', true); return; }
  const type = mode.type, from = song.measures[p.mi].beats[p.bi].notes.find(x => x.id === mode.from.id);
  mode = null;
  mutate(() => {
    if (type === 'slide') { from.slide = 'to'; delete from.hp; }
    else { from.hp = true; if (from.slide === 'to') delete from.slide; }
  });
  status(type === 'slide' ? `슬라이드로 연결했어요 (${from.f} → ${target.f})` : `${target.f > from.f ? '해머온' : '풀오프'}으로 연결했어요`);
  if (from.f === target.f && type === 'hp') status('같은 프렛끼리는 해머/풀이 안 돼요. 붙임줄(tie)을 써보세요', true);
}

function setDur(d) {
  inputDur = d;
  const b = curBeat();
  if (b) mutate(() => { b.dur = d; b.dm = true; }); else render();
}
function changeDur(dir) {
  const b = curBeat(); const i = DUR_LIST.indexOf(b ? b.dur : inputDur);
  const ni = Math.max(0, Math.min(DUR_LIST.length - 1, i + dir));
  setDur(DUR_LIST[ni]);
}
function toggleBeat(prop) {
  const b = curBeat(); if (!b) return status('먼저 음(칸)을 선택하세요', true);
  mutate(() => { b[prop] = prop === 'dot' && b.dot === 2 ? true : !b[prop]; if (prop === 'dot' || prop === 'trip') b.dm = true; });
}
function setPick(p) {
  const b = curBeat(); if (!b) return;
  mutate(() => { b.pick = b.pick === p ? null : p; });
}
// 쉼표 넣기: 커서 위치(앞)에 쉼표 칸을 끼워 넣고 커서는 그 다음으로
function insertRest(dur) {
  if (pending) commitPending(); pending = '';
  const d = dur || inputDur;
  const m = song.measures[sel.mi];
  mutate(() => { const nb = newBeat(d); if (dur) nb.dm = true; m.beats.splice(Math.min(sel.bi, m.beats.length), 0, nb); sel.bi++; afterFill(); });
  status(`${DUR_LABEL[d].replace('음표', '쉼표')}를 넣었어요`);
}
function makeRest() { const b = curBeat(); if (!b) return insertRest(); mutate(() => { b.notes = []; }); status('이 칸을 쉼표로 바꿨어요'); }
// 마디가 꽉 찼고 커서가 마디 끝이면 다음 마디로 (옵션)
function afterFill() {
  if (!$('autoNext').checked) return;
  const m = song.measures[sel.mi];
  if (sel.bi < m.beats.length) return;
  if (measureFill(m) < measureCapacity(measureTs(song, sel.mi))) return;
  if (sel.mi === song.measures.length - 1) song.measures.push(newMeasure());
  sel.mi++; sel.bi = 0;
}

// ---------- 리듬 자동 맞춤 / 후보 ----------
let teachCache = null;
let popCands = [];
function keepsManual(m, c) { return m.beats.every((b, i) => !b.dm || b.grace || c.ticks[i] === beatTicks(b)); }
// 마디를 떠날 때 박자가 안 맞으면 (직접 정한 길이는 그대로 두고) 자동으로 맞춤
function autoFitLeft(prev) {
  const el = $('autoFit'); if (!el || !el.checked || Player.isPlaying()) return false;
  const m = song.measures[prev]; if (!m || !m.beats.some(b => !b.grace)) return false;
  if (measureFill(m) === measureCapacity(measureTs(song, prev))) return false;
  if (m.beats.every(b => b.grace || b.dm)) return false;
  const c = rhythmCandidates(song, prev).find(x => keepsManual(m, x));
  if (!c) return false;
  snapshot(); applyTicks(m, c.ticks); changed();
  status(`✨ ${prev + 1}번째 마디의 음표 길이를 자동으로 맞췄어요. 마음에 안 들면 숫자 아래(리듬)를 눌러 다른 후보를 고르세요`);
  return true;
}
const REST_ICON = { 1: '𝄻', 2: '𝄼', 4: '𝄽', 8: '𝄾', 16: '𝄿', 32: '𝅀' };
function tickIcon(t, rest) {
  const v = TICK_TO_DUR[t]; if (!v) return '?';
  return `<span class="ri">${rest ? REST_ICON[v[0]] : durIcon(v[0])}${v[1] ? '.' : ''}${v[2] ? '<sup>3</sup>' : ''}</span>`;
}
function ticksIcons(m, ticks) { return m.beats.map((b, i) => b.grace ? '' : tickIcon(ticks[i], isRest(b))).join(''); }
let showCands = false;
function candHtml() {
  const m = song.measures[sel.mi]; popCands = rhythmCandidates(song, sel.mi);
  if (!popCands.length) return '';
  if (!showCands) return `<div class="prow">${btn(`🎵 마디 전체 리듬 후보 보기 (${popCands.length}개) ▾`, 'togcands')}</div>`;
  const cur = m.beats.map(beatTicks).join(',');
  let h = `<div class="ph2">🎵 리듬 후보 ${btn('숨기기 ▴', 'togcands')} <span class="muted">— ▶로 들어보고 마음에 들면 적용</span></div><div class="cands">`;
  popCands.forEach((c, i) => {
    const on = c.ticks.join(',') === cur;
    h += `<div class="cand ${on ? 'on' : ''}"><span class="cl">${i + 1}. ${esc(c.label)}${on ? ' (지금)' : ''}</span><span class="cicons">${ticksIcons(m, c.ticks)}</span>${btn('▶', 'candplay:' + i, false, '이 리듬으로 들어보기')}${on ? '' : btn('적용', 'cand:' + i)}</div>`;
  });
  return h + `</div>`;
}
// ⚠ 문제 진단 + 해결 버튼
function diagHtml(mi) {
  const prob = measureProblem(song, mi); if (!prob) return '';
  const m = song.measures[mi], ts = measureTs(song, mi), cap = measureCapacity(ts), fill = measureFill(m);
  const unit = 1920 / ts[1], bn = v => Math.round(v / unit * 100) / 100;
  const unitName = { 2: '2분음표', 4: '4분음표', 8: '8분음표', 16: '16분음표' }[ts[1]] || '박';
  let h = `<div class="diag ${prob}">`;
  if (prob === 'over' || prob === 'under') {
    popCands = rhythmCandidates(song, mi);
    const best = popCands.find(c => keepsManual(m, c)) || popCands[0];
    h += `<div class="dt">⚠ ${prob === 'over' ? '박자가 넘쳐요' : '박자가 모자라요'}</div>`;
    h += `<div class="dx">이 마디는 <b>${ts[0]}/${ts[1]}박자</b>라서 ${unitName} <b>${ts[0]}개</b> 길이만큼 들어가요. 그런데 지금 음표 길이를 다 더하면 <b>${bn(fill)}개</b> 길이라서 <b>${bn(Math.abs(fill - cap))}개</b>만큼 ${prob === 'over' ? '넘쳐요' : '모자라요'}.</div>`;
    h += `<div class="dx muted">${prob === 'over' ? '흔한 원인: 음표 길이(♪, ♩)가 실제보다 길게 들어갔거나, 다음 마디의 숫자가 이 마디에 같이 들어왔어요.' : '흔한 원인: 음표가 실제보다 짧게 들어갔거나, 쉼표가 빠졌어요. 노래 첫 마디(못갖춘마디)라면 원래 짧을 수도 있어요.'}</div>`;
    h += `<div class="fixes">`;
    if (best) h += `<div class="fix"><button data-act="fix:fit" class="primary">🔧 해결: 리듬 자동 맞춤</button> <span class="cicons">${ticksIcons(m, best.ticks)}</span> <span class="muted">(${esc(best.label)})</span></div>`;
    if (prob === 'over') {
      const k = overflowCount(mi);
      if (k > 0 && k < m.beats.length) h += `<div class="fix"><button data-act="fix:move">🔧 해결: 넘치는 뒤쪽 ${k}칸을 다음 마디로 옮기기</button> <span class="muted">(지금 길이 그대로 두고 마디만 나눠요)</span></div>`;
    } else {
      h += `<div class="fix"><button data-act="fix:rest">🔧 해결: 마디 끝에 쉼표 넣기</button> <span class="muted">(${splitRestTicks(cap - fill).map(t => tickIcon(t, true)).join('')} 남은 길이만큼 쉬기)</span></div>`;
      h += `<div class="fix"><button data-act="fix:ok">이대로 둘게요</button> <span class="muted">(첫 마디/마지막 마디처럼 원래 짧은 마디)</span></div>`;
    }
    h += `</div>`;
    if (popCands.length > 1) h += `<div class="dx muted">다른 리듬을 원하면 아래 후보에서 골라도 돼요.</div>` + candHtml();
  } else if (prob === 'check') {
    h += `<div class="dt">🔍 PDF에서 자동으로 읽은 마디예요</div><div class="dx">박자 합은 맞췄지만, 일부 음표 길이는 추측했어요. ▶로 들어보고 원본과 비교한 뒤 괜찮으면 확인을 눌러 주세요.</div>`;
    h += `<div class="fixes"><div class="fix"><button data-act="fix:checked" class="primary">✓ 확인 완료</button> ${btn('▶ 이 마디 듣기', 'loopm')}</div></div>` + candHtml();
  }
  return h + `</div>`;
}
function overflowCount(mi) {
  const m = song.measures[mi], cap = measureCapacity(measureTs(song, mi));
  let t = 0, i = 0; for (; i < m.beats.length; i++) { t += beatTicks(m.beats[i]); if (t > cap) break; }
  return m.beats.length - i;
}
function doFix(kind) {
  const mi = sel.mi, m = song.measures[mi], cap = measureCapacity(measureTs(song, mi));
  if (kind === 'fit') {
    const c = rhythmCandidates(song, mi); const best = c.find(x => keepsManual(m, x)) || c[0];
    if (!best) return status('자동으로 맞출 수 있는 리듬을 찾지 못했어요. 음표 길이를 직접 골라 주세요', true);
    mutate(() => { applyTicks(m, best.ticks); delete m.check; }); status('✓ 리듬을 맞췄어요. ▶로 들어보세요');
  } else if (kind === 'move') {
    const k = overflowCount(mi);
    mutate(() => { const tail = m.beats.splice(m.beats.length - k, k); const nm = newMeasure(); nm.beats = tail; song.measures.splice(mi + 1, 0, nm); lastMi = sel.mi; });
    status(`✓ 넘치던 ${k}칸을 새 마디로 옮겼어요`);
  } else if (kind === 'rest') {
    mutate(() => { splitRestTicks(cap - measureFill(m)).forEach(t => { const b = newBeat(8); setBeatTicks(b, t); b.dm = true; m.beats.push(b); }); });
    status('✓ 마디 끝에 쉼표를 넣었어요');
  } else if (kind === 'ok') { mutate(() => { m.okUnder = true; }); status('이 마디는 짧은 마디로 둘게요'); }
  else if (kind === 'checked') { mutate(() => { delete m.check; }); status('확인 완료!'); }
}
function playMeasure(sng, mi, loop) {
  if (Player.isPlaying()) Player.stop();
  Player.play(sng, { from: mi, to: mi, speed: loop ? 0.7 : (+$('speed').value || 100) / 100, metronome: true, countIn: false, loop: !!loop }, onPlayStop);
  $('bPlay').textContent = '■ 정지'; $('bPlay').classList.add('on');
  cancelAnimationFrame(rafId); tick();
  status(loop ? `🔁 ${mi + 1}번째 마디를 70% 속도로 반복해요 (Space = 정지)` : '▶ 미리 듣는 중');
}

// ---------- 한 박 리듬 패턴 ----------
// 악보에서 빔(가로 막대)으로 묶인 덩어리 하나 = 보통 1박. 그 모양을 골라서 한 번에 적용.
const BEAT_PATTERNS = [
  { p: [480], n: '♩', c: '하나' },
  { p: [240, 240], n: '♪♪', c: '하나 앤' },
  { p: [240, 120, 120], n: '♪♬', c: '하나 앤아' },
  { p: [120, 120, 240], n: '♬♪', c: '하나이 앤' },
  { p: [120, 120, 120, 120], n: '♬♬', c: '하나이앤아' },
  { p: [360, 120], n: '♪.♬', c: '하나—아' },
  { p: [120, 360], n: '♬♪.', c: '하나이—' },
  { p: [120, 240, 120], n: '♬♪♬', c: '하나이—아' },
  { p: [60, 420], n: '32분+겹점8분', c: '(톡)하나——' },
  { p: [240, 60, 180], n: '♪+32분+점16분', c: '하나 —앤아' },
  { p: [-240, 60, 180], n: '𝄾+32분+점16분', c: '(쉼) —앤아' },
  { p: [180, 60, 240], n: '점16+32+♪', c: '하나— 앤' },
  { p: [-240, 240], n: '𝄾♪', c: '(쉼) 앤' },
  { p: [-240, 120, 120], n: '𝄾♬', c: '(쉼) 앤아' },
  { p: [240, -240], n: '♪𝄾', c: '하나 (쉼)' },
  { p: [160, 160, 160], n: '♪♪♪³', c: '트리플' },
];
function patScaled(pt) {
  const ts = measureTs(song, sel.mi); const k = (1920 / ts[1]) / 480;
  const out = pt.p.map(v => Math.sign(v) * Math.abs(v) * k);
  return out.every(v => TICK_TO_DUR[Math.abs(v)]) ? out : null;
}
function patIcon(arr) { return arr.map(v => tickIcon(Math.abs(v), v < 0)).join(''); }
function patHtml() {
  const ts = measureTs(song, sel.mi); const unitName = { 4: '4분음표', 8: '8분음표', 2: '2분음표', 16: '16분음표' }[ts[1]] || '1박';
  let h = `<div class="pat"><div class="ph2">🥁 한 박 리듬 <span class="muted">— 악보에서 가로 막대로 묶인 한 덩어리(=${unitName} 1박)를 골라요. 이 칸부터 숫자 개수만큼 적용돼요</span></div><div class="patbtns">`;
  BEAT_PATTERNS.forEach((pt, i) => { const sc = patScaled(pt); if (!sc) return; h += `<button data-act="pat:${i}" class="patb" title="${pt.c}"><span class="cicons">${patIcon(sc)}</span><small>${pt.c}</small></button>`; });
  return h + `</div></div>`;
}
function applyBeatPattern(i) {
  const sc = patScaled(BEAT_PATTERNS[i]); if (!sc) return;
  if (pending) commitPending(); pending = '';
  const m = song.measures[sel.mi];
  mutate(() => {
    let bi = Math.min(sel.bi, m.beats.length);
    sc.forEach(v => {
      let b = m.beats[bi];
      while (b && b.grace) { bi++; b = m.beats[bi]; }
      if (v < 0) { // 쉼표 자리: 지금 칸이 쉼표면 그대로, 아니면 쉼표 칸을 끼워 넣음
        if (!b || !isRest(b)) { b = newBeat(8); m.beats.splice(bi, 0, b); }
      } else if (!b) { b = newBeat(8); m.beats.push(b); }
      setBeatTicks(b, Math.abs(v)); b.dm = true; bi++;
    });
    sel.bi = Math.min(bi, m.beats.length);
  });
  const fill = measureFill(m), cap = measureCapacity(measureTs(song, sel.mi));
  status(`✓ 1박 적용: ${BEAT_PATTERNS[i].c}. ${fill === cap ? '이 마디가 꽉 찼어요 ✓' : fill < cap ? '다음 칸을 누르고 다음 박 모양을 고르세요' : '⚠ 마디가 넘쳐요. 마디 번호를 눌러 확인하세요'}`);
}

// ---------- 선생님 설명 ----------
const COUNT_WORDS = ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열하나', '열둘'];
function countWord(t, unit) {
  const n = Math.floor(t / unit), f = (t % unit) / unit;
  if (f < 0.01) return COUNT_WORDS[n] || String(n + 1);
  if (Math.abs(f - 0.5) < 0.01) return '앤';
  if (Math.abs(f - 0.25) < 0.01) return '이';
  if (Math.abs(f - 0.75) < 0.01) return '아';
  if (Math.abs(f - 1 / 3) < 0.02) return '트';
  if (Math.abs(f - 2 / 3) < 0.02) return '렛';
  return '·';
}
const FN = { 1: '검지(1)', 2: '중지(2)', 3: '약지(3)', 4: '새끼(4)', T: '엄지(T)' };
function teachData() {
  if (teachCache) return teachCache;
  const c = cloneSong(song); Fingering.suggest(c); suggestPicking(c);
  return teachCache = c;
}
function teachHtml(mi) {
  const m = song.measures[mi], ts = measureTs(song, mi), unit = 1920 / ts[1];
  const unitName = { 2: '2분음표', 4: '4분음표', 8: '8분음표', 16: '16분음표' }[ts[1]] || '박';
  let h = `<div class="th"><b>👩‍🏫 ${mi + 1}번째 마디, 이렇게 쳐 보세요</b><span class="tbtns"><button data-teach="loop">🔁 이 마디 70% 반복</button><button data-teach="stop">■ 정지</button><button data-teach="hide" title="선생님 설명 끄기 (도우미 탭에서 다시 켤 수 있어요)">✕</button></span></div>`;
  if (!m.beats.length) return h + `<div class="tx">아직 음이 없어요. 줄 위를 클릭하고 숫자를 입력한 다음 Enter를 누르세요.</div>`;
  const cm = teachData().measures[mi];
  const words = []; for (let i = 0; i < ts[0]; i++) words.push(COUNT_WORDS[i] || i + 1);
  h += `<div class="tx">⏱ <b>${ts[0]}/${ts[1]}박자</b>: 한 마디에 ${unitName} ${ts[0]}개 길이예요. 발로 박자를 맞추며 “${words.join(' - ')}” 하고 세요. 8분음표는 그 사이를 “앤”으로 (${words.slice(0, 2).map(w => w + ' 앤').join(' ')} …) 세면 돼요.</div>`;
  // 박자 칩
  let t = 0; const steps = [];
  let chips = '<div class="tchips">';
  m.beats.forEach((b, bi) => {
    const cb = cm.beats[bi]; const w = b.grace ? '꾸밈' : countWord(t, unit);
    const rest = isRest(b);
    const label = rest ? '쉼' : b.notes.slice().sort((a, c) => a.s - c.s).map(n => `${n.s + 1}줄 ${n.dead ? 'x' : n.f}`).join('<br>');
    chips += `<span class="tchip ${rest ? 'rest' : ''} ${bi === sel.bi && mi === sel.mi ? 'cur' : ''}"><i>${w}</i>${label}</span>`;
    steps.push(teachStep(mi, bi, b, cb, w));
    t += beatTicks(b);
  });
  chips += '</div>';
  h += chips + `<ol class="tsteps">${steps.map(s => `<li>${s}</li>`).join('')}</ol>`;
  // 손 위치 / 연습 팁
  const fr = m.beats.flatMap(b => b.notes.filter(n => n.f > 0 && !n.dead).map(n => n.f));
  const tips = [];
  if (!fr.length) tips.push('모두 개방현(0)이라 왼손은 줄을 누르지 않아도 돼요. 오른손 리듬에만 집중하세요.');
  else {
    const lo = Math.min(...fr), hi = Math.max(...fr);
    if (hi - lo <= 3) tips.push(`✋ 왼손 검지를 <b>${Math.max(1, lo)}프렛</b> 근처에 두면 손을 옮기지 않고 이 마디를 다 칠 수 있어요 (손가락 하나가 한 칸씩 맡아요).`);
    else tips.push(`✋ 손 위치가 ${lo}프렛 ~ ${hi}프렛으로 넓게 움직여요. 옮겨 갈 자리를 미리 눈으로 봐 두고, 엄지는 넥 뒤에서 같이 미끄러지게 하세요.`);
  }
  const fast = m.beats.some(b => !b.grace && beatTicks(b) <= 120);
  tips.push(`🐢 연습 순서: ① 박자를 소리 내어 세며 오른손만 쳐 보기 → ② 왼손을 더해 <b>70% 속도</b>로 반복 → ③ 익숙해지면 100%로.${fast ? ' 16분음표처럼 빠른 음이 있으니 피킹을 위·아래로 번갈아 치는 게 중요해요.' : ''}`);
  h += `<div class="ttips">${tips.map(x => `<div>${x}</div>`).join('')}</div>`;
  return h;
}
function teachStep(mi, bi, b, cb, w) {
  const q = `<b>“${w}”</b>`;
  if (b.grace) return `${q} 다음 음 바로 직전에 ${b.notes.map(n => `${n.s + 1}번 줄 ${n.f}프렛`).join(', ')}을 아주 짧게 “톡” 치고 바로 다음 음으로 넘어가요 (꾸밈음 — 박자를 차지하지 않아요).`;
  if (isRest(b)) return `${q} 쉬어요 (쉼표). 오른손 손바닥이나 왼손 손가락을 줄에 살짝 대서 소리를 멈춰요.`;
  if (b.notes.every(n => n.tie)) return `${q} 다시 치지 말고 앞 음을 누른 채로 소리를 계속 이어요 (붙임줄).`;
  const pick = b.pick || cb.pa;
  const legato = b.notes.every(n => isLegatoTarget(song, mi, bi, n));
  const pickTxt = legato ? '오른손은 치지 않아요 (왼손만으로 소리를 내요)' : pick === 'd' ? '<b>⊓ 다운</b>(위에서 아래로) 쳐요' : pick === 'u' ? '<b>V 업</b>(아래에서 위로) 쳐요' : '쳐요';
  const fin = (n, i) => { const cn = cb.notes.find(x => x.id === n.id) || {}; const f = n.fm || cn.fa; if (n.dead) return '살짝 대기만'; if (n.f === 0) return '누르지 않고(개방현)'; return f ? FN[f] + '로' : ''; };
  const ns = b.notes.slice().sort((a, c) => a.s - c.s);
  let txt;
  if (ns.length === 1) { const n = ns[0]; txt = n.f === 0 && !n.dead ? `${q}에 <b>${n.s + 1}번 줄 개방현(0)</b>을 왼손으로 아무것도 누르지 않고 ${pickTxt}.` : n.dead ? `${q}에 <b>${n.s + 1}번 줄</b>을 왼손으로 살짝 대기만 하고 ${pickTxt}.` : `${q}에 <b>${n.s + 1}번 줄 ${n.f}프렛</b>을 ${fin(n)} 누르고 ${pickTxt}.`; }
  else txt = `${q}에 줄 ${ns.length}개를 동시에 ${pickTxt}: ${ns.map(n => `${n.s + 1}번 줄 ${n.dead ? 'x' : n.f}${n.f > 0 && !n.dead ? '(' + (fin(n).replace('로', '')) + ')' : ''}`).join(', ')}. 피크로 줄을 한 번에 쓸듯이 쳐요 (화음).`;
  const extra = [];
  ns.forEach(n => {
    const nx = nextOnString(song, mi, bi, n.s);
    if (n.slide === 'to' && nx) extra.push(`${n.f}프렛을 친 뒤 손가락을 떼지 말고 줄 위로 <b>${nx.note.f}프렛까지 미끄러뜨려요</b> (슬라이드). 도착한 음은 다시 치지 않아요.`);
    if (n.slide === 'in') extra.push('낮은 프렛에서 미끄러져 올라오며 소리를 내요 (슬라이드 인).');
    if (n.slide === 'out') extra.push('친 다음 손가락을 누른 채 아래쪽으로 미끄러뜨리며 소리를 빼요 (슬라이드 아웃).');
    if (n.hp && nx) extra.push(nx.note.f > n.f ? `다음 ${nx.note.f}프렛은 피킹하지 말고, 다른 손가락으로 줄을 <b>망치처럼 “탁” 세게 눌러</b> 소리를 내요 (해머온).` : `다음 ${nx.note.f}프렛은 피킹하지 말고, 누르던 손가락을 <b>줄을 살짝 튕기듯 떼어</b> 아래 음을 울려요 (풀오프). ${nx.note.f > 0 ? nx.note.f + '프렛은 미리 눌러 두세요.' : ''}`);
    if (n.bend) extra.push(`친 다음 줄을 위로 밀어 올려 음을 <b>${n.bend.a === 0.5 ? '반음(1프렛 위 소리)' : n.bend.a === 1.5 ? '한 음 반(3프렛 위 소리)' : '한 음(2프렛 위 소리)'}</b>만큼 올려요. 약지로 밀고 검지·중지가 뒤에서 같이 밀어 줘요${n.bend.r ? '. 올린 뒤 천천히 원래 음으로 내려요 (릴리즈)' : ''}.`);
    if (n.vib) extra.push('누른 채로 손가락을 위아래로 살살 흔들어 소리에 떨림을 줘요 (비브라토).');
    if (n.pm) extra.push('오른손 손날을 브릿지 바로 앞 줄 위에 살짝 얹고 쳐서 “퉁퉁” 짧고 묵직한 소리를 내요 (팜뮤트).');
    if (n.dead) extra.push('왼손은 줄을 누르지 말고 살짝 대기만 한 채 쳐서 “칙” 하는 소리를 내요 (데드노트).');
    if (n.ghost) extra.push('아주 약하게, 거의 들릴 듯 말 듯 쳐요 (고스트노트).');
    if (n.harm) extra.push('프렛 바로 위(쇠 막대 위)에 손가락을 살짝 대기만 하고 쳐서 종소리 같은 소리를 내요 (하모닉).');
    if (n.acc) extra.push('다른 음보다 조금 세게 쳐요 (악센트).');
    if (n.lr) extra.push('손을 떼지 말고 소리가 계속 울리게 둬요 (렛링).');
  });
  return txt + (extra.length ? `<div class="tex">${[...new Set(extra)].join('<br>')}</div>` : '');
}
function teachOn() { try { return localStorage.getItem('gtab-teach') !== '0'; } catch (e) { return true; } }
function renderTeacher() {
  if (printMode || !teachOn() || !layout || !layout.msys) return;
  const si = layout.msys[sel.mi]; if (si === undefined) return;
  const svg = scoreEl.querySelector(`svg[data-si="${si}"]`); if (!svg) return;
  const d = document.createElement('div'); d.className = 'teach no-print'; d.innerHTML = teachHtml(sel.mi);
  svg.after(d);
}
scoreEl.addEventListener('click', e => {
  const b = e.target.closest('[data-teach]'); if (!b) return;
  e.stopPropagation();
  const a = b.dataset.teach;
  if (a === 'loop') playMeasure(song, sel.mi, true);
  else if (a === 'stop') Player.stop();
  else if (a === 'hide') { try { localStorage.setItem('gtab-teach', '0'); } catch (er) { } $('vTeach').checked = false; render(); status('선생님 설명을 껐어요. 도우미 탭에서 다시 켤 수 있어요'); }
}, true);

// ---------- 키보드 ----------
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t.matches && t.matches('input, select, textarea')) { if (e.key === 'Escape') t.blur(); return; }
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (ctrl && k.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
  if (ctrl && k.toLowerCase() === 's') { e.preventDefault(); return saveFile(); }
  if (ctrl && k.toLowerCase() === 'p') { e.preventDefault(); return exportPdf(); }
  if (ctrl || e.altKey) return;
  if (/^[0-9]$/.test(k)) { pending = (pending + k).slice(-2); render(); e.preventDefault(); return; }
  let handled = true;
  switch (k) {
    case 'Enter': if (pending) commitPending(); moveRight(); pending = ''; afterFill(); render(); break;
    case 'Insert': insertBeat(); break;
    case 'F1': openHelp(); break;
    case '?': openHelp(); break;
    case 'Escape': $('helpModal').classList.add('hidden'); $('theoryModal').classList.add('hidden'); pending = ''; if (mode) { mode = null; status('취소했어요'); } closePopup(); render(); break;
    case 'Backspace': if (pending) { pending = pending.slice(0, -1); render(); } else if (e.shiftKey) deleteBeat(); else deleteNote(); break;
    case 'Delete': if (e.shiftKey) deleteBeat(); else deleteNote(); break;
    case 'ArrowRight': if (pending) commitPending(); pending = ''; moveRight(); closePopup(); render(); break;
    case 'ArrowLeft': pending = ''; moveLeft(); closePopup(); render(); break;
    case 'ArrowUp': if (pending) commitPending(); pending = ''; sel.s = Math.max(0, sel.s - 1); closePopup(); render(); break;
    case 'ArrowDown': if (pending) commitPending(); pending = ''; sel.s = Math.min(5, sel.s + 1); closePopup(); render(); break;
    case ' ': togglePlay(); break;
    case '+': case '=': changeDur(-1); break;
    case '-': case '_': changeDur(1); break;
    case '.': toggleBeat('dot'); break;
    default: handled = false;
  }
  if (!handled) {
    handled = true;
    switch (k.toLowerCase()) {
      case 'm': if (pending) commitPending(); pending = ''; splitMeasure(); break;
      case 'b': toggleNote('bend'); break;
      case 's': if (pending) commitPending(); pending = ''; startLink('slide'); break;
      case 'h': if (pending) commitPending(); pending = ''; startLink('hp'); break;
      case 'v': toggleNote('vib'); break;
      case 'p': toggleNote('pm'); break;
      case 'x': toggleNote('dead'); break;
      case 'g': toggleNote('ghost'); break;
      case 'l': toggleNote('lr'); break;
      case 'a': toggleNote('acc'); break;
      case 't': toggleBeat('trip'); break;
      case 'q': toggleBeat('grace'); break;
      case 'r': insertRest(); break;
      case 'd': setPick('d'); break;
      case 'u': setPick('u'); break;
      case 'i': insertBeat(); break;
      default: handled = false;
    }
  }
  if (handled) e.preventDefault();
});

// ---------- 마우스 ----------
scoreEl.addEventListener('click', e => {
  const el = e.target.closest('[data-ins],[data-col],[data-rhythm],[data-pick],[data-measure]');
  if (!el) return;
  e.stopPropagation();
  const rect = el.getBoundingClientRect();
  const anchor = { getBoundingClientRect: () => rect };
  if (el.dataset.ins) {
    if (pending) commitPending(); pending = ''; mode = null;
    const [mi, bi] = el.dataset.ins.split(',').map(Number);
    const sr = el.ownerSVGElement.getBoundingClientRect();
    const sy = (e.clientY - sr.top) * (R.height / sr.height);
    const s = Math.max(0, Math.min(5, Math.round((sy - R.line0) / R.gap)));
    mutate(() => { song.measures[mi].beats.splice(bi, 0, newBeat(inputDur)); sel = { mi, bi, s }; });
    closePopup();
    status(`${s + 1}번 줄에 새 칸을 끼워 넣었어요. 숫자를 입력하세요`);
    if (wantKbd()) focusKbd();
    return;
  }
  if (el.dataset.col) {
    const [mi, bi, s] = el.dataset.col.split(',').map(Number);
    if (pending && !(mi === sel.mi && bi === sel.bi && s === sel.s)) commitPending();
    if (mode) { if (noteAt(song.measures[mi].beats[bi], s)) { completeLink(mi, bi, s); return; } }
    pending = '';
    sel = { mi, bi: Math.min(bi, song.measures[mi].beats.length), s };
    const n = curNote();
    render();
    if (n) { openPopup('note', anchor); previewAt(mi, sel.bi, s); }
    else { closePopup(); if (wantKbd()) { focusKbd(); status('숫자를 누르면 바로 들어가요 (12처럼 두 자리는 이어서 누르세요)'); } else status(IS_TOUCH ? '아래 숫자 패드에서 프렛 숫자를 누르세요' : '숫자(프렛)를 입력하고 Enter를 누르세요'); }
  } else if (el.dataset.rhythm) {
    const [mi, bi] = el.dataset.rhythm.split(',').map(Number);
    sel.mi = mi; sel.bi = bi; pending = ''; render(); openPopup('rhythm', anchor);
  } else if (el.dataset.pick) {
    const [mi, bi] = el.dataset.pick.split(',').map(Number);
    sel.mi = mi; sel.bi = bi;
    const b = curBeat(); if (isRest(b)) return;
    mutate(() => { b.pick = b.pick === null || b.pick === undefined ? 'd' : b.pick === 'd' ? 'u' : null; });
    status(b.pick ? `피킹: ${b.pick === 'd' ? '⊓ 다운' : 'V 업'} (직접 입력 = 검정색)` : '직접 입력한 피킹을 지웠어요');
  } else if (el.dataset.measure) {
    sel.mi = +el.dataset.measure; sel.bi = 0; render(); openPopup('measure', anchor);
  }
});
document.addEventListener('click', e => {
  if (!e.target.closest('#popup') && !e.target.closest('#score')) closePopup();
});

// ---------- 팝업 메뉴 ----------
function closePopup() { $('popup').classList.add('hidden'); popupInfo = null; document.body.classList.remove('popopen'); }
function reopenPopup() {
  if (!popupInfo) return;
  if (popupInfo.type === 'note' && !curNote()) return closePopup();
  if (popupInfo.type !== 'measure' && popupInfo.type !== 'note' && !curBeat()) return closePopup();
  buildPopup(popupInfo.type); placePopup();
}
function openPopup(type, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  popupInfo = { type, x: r.left + window.scrollX, y: r.bottom + window.scrollY, top: r.top + window.scrollY };
  buildPopup(type); placePopup();
}
function placePopup() {
  const p = $('popup'); p.classList.remove('hidden'); document.body.classList.add('popopen');
  p.style.left = ''; p.style.top = '';
  setTimeout(keepCursorVisible, 0);
}
function btn(label, act, on, title) { return `<button data-act="${act}" class="${on ? 'on' : ''}" ${title ? `title="${title}"` : ''}>${label}</button>`; }

function buildPopup(type) {
  const p = $('popup'); let h = '';
  if (type === 'note') {
    const n = curNote(), midi = noteMidi(song, n);
    h += `<div class="ph">${n.s + 1}번 줄 · <b>${n.f}</b>프렛 <span class="muted">(${midiName(midi)})</span> ${btn('▶ 듣기', 'listen')}</div>`;
    h += patHtml();
    h += `<div class="prow"><label>숫자 고치기</label><input id="pfret" type="number" min="0" max="24" value="${n.f}" style="width:60px"> ${btn('적용', 'setfret')} ${btn('🗑 삭제', 'del')}</div>`;
    h += `<div class="prow"><label>손가락 색</label>`;
    [1, 2, 3, 4, 'T'].forEach(f => h += `<button data-act="finger:${f}" class="fbtn ${n.fm == f ? 'on' : ''}" style="--fc:${FINGER_COLORS[f]}">${FINGER_NAMES[f]}${f === 'T' ? '' : ' ' + f}</button>`);
    h += btn('색 없음', 'finger:none', !n.fm) + (n.fa && !n.fm ? `<span class="muted"> 추천: ${FINGER_NAMES[n.fa]}</span>` : '') + `</div>`;
    h += `<div class="prow"><label>벤딩 (B)</label>${btn('없음', 'bend:none', !n.bend)}${btn('½', 'bend:0.5', n.bend && n.bend.a === 0.5 && !n.bend.r)}${btn('full', 'bend:1', n.bend && n.bend.a === 1 && !n.bend.r)}${btn('1½', 'bend:1.5', n.bend && n.bend.a === 1.5)}${btn('벤딩→릴리즈', 'bend:r', n.bend && n.bend.r)}</div>`;
    const li = linkInfo(sel.mi, sel.bi, n);
    const pvTxt = li.pv ? li.pv.note.f : '없음', nxTxt = li.nx ? li.nx.note.f : '없음';
    h += `<div class="prow"><label>연결</label><span class="linkhint">같은 ${n.s + 1}번 줄: 앞 <b>${pvTxt}</b> · <b>${n.f}</b> · 다음 <b>${nxTxt}</b></span></div>`;
    h += `<div class="prow"><label></label>${li.pv ? btn(`← ${pvTxt}에서 슬라이드`, 'linkprev:slide', li.pv.note.slide === 'to') + btn(`← ${pvTxt}에서 해머/풀`, 'linkprev:hp', li.pv.note.hp) : ''}${li.nx ? btn(`슬라이드 → ${nxTxt} (S)`, 'link:slide', n.slide === 'to') + btn(`해머/풀 → ${nxTxt} (H)`, 'link:hp', n.hp) : ''}${btn('붙임줄(tie)', 'tog:tie', n.tie, '앞 음과 이어서 길게')}</div>`;
    if (li.text) h += `<div class="prow"><label></label><span class="muted">${li.text}</span></div>`;
    h += `<div class="prow"><label>슬라이드 인/아웃</label>${btn('↗ 아래에서 미끄러져 들어감', 'slide:in', n.slide === 'in')}${btn('↘ 미끄러져 나감', 'slide:out', n.slide === 'out')}</div>`;
    h += `<div class="prow"><label>주법</label>${btn('비브라토 (V)', 'tog:vib', n.vib)}${btn('팜뮤트 (P)', 'tog:pm', n.pm)}${btn('렛링 (L)', 'tog:lr', n.lr)}${btn('데드노트 x (X)', 'tog:dead', n.dead)}${btn('고스트 ( ) (G)', 'tog:ghost', n.ghost)}${btn('하모닉 < >', 'tog:harm', n.harm)}${btn('악센트 > (A)', 'tog:acc', n.acc)}${btn('꾸밈음 (Q)', 'btog:grace', curBeat().grace)}</div>`;
  } else if (type === 'rhythm') {
    const b = curBeat(); if (!b) return;
    h += patHtml();
    h += `<div class="ph">음표 길이 (이 칸)</div><div class="prow">`;
    DUR_LIST.forEach(d => h += btn(durIcon(d) + ' ' + DUR_LABEL[d], 'dur:' + d, b.dur === d));
    h += `</div><div class="prow">${btn('점음표 (.)', 'btog:dot', b.dot === true)}${btn('겹점 (..)', 'ddot', b.dot === 2, '점 2개: 원래 길이의 1.75배')}${btn('셋잇단 (T)', 'btog:trip', b.trip)}${btn('꾸밈음 (Q)', 'btog:grace', b.grace, '작은 숫자로, 박자를 차지하지 않고 바로 앞에서 짧게 치는 음')}${btn('이 칸을 쉼표로', 'rest', isRest(b))}</div>`;
    h += `<div class="prow"><label>피킹</label>${btn('⊓ 다운 (D)', 'pick:d', b.pick === 'd')}${btn('V 업 (U)', 'pick:u', b.pick === 'u')}${btn('직접 입력 지우기', 'pick:none', !b.pick)}${b.pa ? `<span class="muted"> 추천: ${b.pa === 'd' ? '⊓' : 'V'}</span>` : ''}</div>`;
    h += candHtml();
    h += `<div class="prow">${btn('앞에 쉼표 칸 넣기 (I)', 'insbeat')}${btn('이 칸 삭제', 'delbeat')}${b.dm ? btn('🔓 길이 자동으로 맡기기', 'undm', false, '직접 정한 길이를 풀어서 자동 추천이 바꿀 수 있게') : ''}</div>`;
  } else if (type === 'measure') {
    const m = song.measures[sel.mi]; const ts = m.ts || song.ts;
    h += `<div class="ph">${sel.mi + 1}번째 마디</div>`;
    h += diagHtml(sel.mi);
    h += `<div class="prow"><label>구간 이름</label><input id="psec" value="${esc(m.section || '')}" placeholder="예: Intro, Verse, 솔로" style="width:150px"> ${btn('적용', 'setsec')}</div>`;
    h += `<div class="prow"><label>이 마디부터 박자</label><select id="pts0">${[1, 2, 3, 4, 5, 6, 7, 9, 12].map(v => `<option ${v === ts[0] ? 'selected' : ''}>${v}</option>`).join('')}</select> / <select id="pts1">${[2, 4, 8, 16].map(v => `<option ${v === ts[1] ? 'selected' : ''}>${v}</option>`).join('')}</select> ${btn('적용', 'setts')} ${m.ts ? btn('기본 박자로', 'clearts') : ''}</div>`;
    if (!measureProblem(song, sel.mi)) h += candHtml();
    h += `<div class="prow">${btn('▶ 여기서부터 재생', 'playfrom')}${btn('🔁 이 마디 반복 연습', 'loopm')}</div>`;
    h += `<div class="prow">${btn('앞에 마디 추가', 'maddb')}${btn('뒤에 마디 추가', 'madda')}${btn('마디 복사해서 뒤에 붙이기', 'mcopy')}${btn('🗑 마디 삭제', 'mdel')}</div><div class="prow">${btn('↵ 이 마디부터 새 줄', 'mbrk', m.brk)}</div>`;
  }
  p.innerHTML = `<button class="pclose" data-act="close">✕</button>` + h;
}
function durIcon(d) { return { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯', 32: '𝅘𝅥𝅰' }[d]; }

$('popup').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('[data-act]'); if (!b) return;
  const [act, arg] = b.dataset.act.split(':');
  const n = curNote(), beat = curBeat(), m = song.measures[sel.mi];
  switch (act) {
    case 'close': closePopup(); break;
    case 'listen': previewAt(sel.mi, sel.bi, sel.s); if (Player.isPlaying()) break; Player.preview(noteMidi(song, n), song.tone, song.fx, song.bpm); break;
    case 'setfret': { const v = parseInt($('pfret').value, 10); if (isNaN(v) || v < 0 || v > 24) return status('0~24 사이 숫자를 넣어주세요', true); mutate(() => { n.f = v; }); break; }
    case 'del': deleteNote(); break;
    case 'finger': mutate(() => { if (arg === 'none') delete n.fm; else n.fm = arg === 'T' ? 'T' : +arg; }); break;
    case 'bend': toggleNote('bend', arg === 'none' ? null : arg === 'r' ? { a: 1, r: true } : { a: +arg }); break;
    case 'link': if (n && ((arg === 'slide' && n.slide === 'to') || (arg === 'hp' && n.hp))) startLink(arg); else if (n) linkNext(arg, sel.mi, sel.bi, n); break;
    case 'linkprev': { const pv = prevOnString(song, sel.mi, sel.bi, n.s); if (pv && ((arg === 'slide' && pv.note.slide === 'to') || (arg === 'hp' && pv.note.hp))) { mutate(() => { if (arg === 'slide') delete pv.note.slide; else delete pv.note.hp; }); status('연결을 해제했어요'); } else linkPrev(arg, sel.mi, sel.bi, n); break; }
    case 'pat': applyBeatPattern(+arg); break;
    case 'ddot': mutate(() => { beat.dot = beat.dot === 2 ? false : 2; beat.dm = true; }); break;
    case 'togcands': showCands = !showCands; reopenPopup(); break;
    case 'slide': toggleNote('slide', arg); break;
    case 'tog': toggleNote(arg); break;
    case 'dur': setDur(+arg); break;
    case 'btog': toggleBeat(arg); break;
    case 'rest': makeRest(); break;
    case 'pick': mutate(() => { beat.pick = arg === 'none' ? null : arg; }); break;
    case 'cand': { const c = popCands[+arg]; if (!c) break; mutate(() => { applyTicks(m, c.ticks); }); status(`리듬을 바꿨어요: ${c.label}. ▶ 재생으로 들어보세요`); break; }
    case 'candplay': { const c = popCands[+arg]; if (!c) break; const tmp = cloneSong(song); applyTicks(tmp.measures[sel.mi], c.ticks); playMeasure(tmp, sel.mi, false); break; }
    case 'undm': mutate(() => { delete beat.dm; }); status('이 칸의 길이를 자동 추천에 맡겼어요'); break;
    case 'fix': doFix(arg); break;
    case 'loopm': closePopup(); playMeasure(song, sel.mi, true); break;
    case 'autorhythm': mutate(() => { const r = suggestRhythm(song, sel.mi); status(r === 'copy' ? '음 개수가 같은 다른 마디의 리듬을 그대로 가져왔어요' : r ? '마디 길이에 맞게 리듬을 나눴어요. 필요하면 직접 고쳐주세요' : '이 마디에 음이 없어요'); }); break;
    case 'insbeat': insertBeat(); break;
    case 'delbeat': deleteBeat(); break;
    case 'setsec': mutate(() => { m.section = $('psec').value.trim(); }); break;
    case 'setts': mutate(() => { m.ts = [+$('pts0').value, +$('pts1').value]; if (sel.mi === 0) { song.ts = m.ts; m.ts = null; syncToolbar(); } }); break;
    case 'clearts': mutate(() => { m.ts = null; }); break;
    case 'playfrom': closePopup(); startPlay(sel.mi); break;
    case 'maddb': mutate(() => { song.measures.splice(sel.mi, 0, newMeasure()); }); closePopup(); break;
    case 'madda': mutate(() => { song.measures.splice(sel.mi + 1, 0, newMeasure()); sel.mi++; sel.bi = 0; }); closePopup(); break;
    case 'mcopy': mutate(() => { const c = cloneSong(m); c.id = uid(); c.beats.forEach(bb => { bb.id = uid(); bb.notes.forEach(nn => nn.id = uid()); }); song.measures.splice(sel.mi + 1, 0, c); }); status('마디를 복사했어요'); closePopup(); break;
    case 'mchecked': mutate(() => { delete m.check; }); closePopup(); break;
    case 'mbrk': mutate(() => { m.brk = !m.brk; }); break;
    case 'mdel': mutate(() => { song.measures.splice(sel.mi, 1); if (!song.measures.length) song.measures.push(newMeasure()); clampSel(); }); closePopup(); break;
  }
});
$('popup').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'pfret') $('popup').querySelector('[data-act="setfret"]').click();
  if (e.key === 'Enter' && e.target.id === 'psec') $('popup').querySelector('[data-act="setsec"]').click();
});

// ---------- 툴바 ----------
function syncToolbar() {
  $('title').value = song.title; $('artist').value = song.artist;
  $('bpm').value = song.bpm; $('ts0').value = song.ts[0]; $('ts1').value = song.ts[1];
  $('tuning').value = song.tuning; $('tone').value = song.tone;
  $('revOn').checked = !!song.fx.rev; $('revAmt').value = song.fx.revAmt; $('delOn').checked = !!song.fx.del; $('delAmt').value = song.fx.delAmt; $('delTime').value = song.fx.delTime;
  $('vFingers').classList.toggle('on', !!song.view.fingers);
  $('vPicks').classList.toggle('on', !!song.view.picks);
  $('vNames').checked = !!song.view.names; $('vFnums').checked = !!song.view.fingerNums;
  $('perLine').value = String(song.view.perLine || 0);
  $('printSub').textContent = [`♩ = ${song.bpm}`, `튜닝: ${TUNINGS[song.tuning].name}`].filter(Boolean).join('   ·   ');
}
function updateDurButtons() {
  const b = curBeat(); const d = b ? b.dur : inputDur;
  document.querySelectorAll('[data-dur]').forEach(x => x.classList.toggle('on', +x.dataset.dur === d));
  $('bDot').classList.toggle('on', !!(b && b.dot)); $('bTrip').classList.toggle('on', !!(b && b.trip)); $('bGrace').classList.toggle('on', !!(b && b.grace));
}
function updateLegend() {
  const any = song.view.fingers || song.measures.some(m => m.beats.some(b => b.notes.some(n => n.fm)));
  const pk = song.view.picks || song.measures.some(m => m.beats.some(b => b.pick));
  let h = '';
  if (any) h += [1, 2, 3, 4].map(f => `<span class="lg"><i style="background:${FINGER_COLORS[f]}"></i>${FINGER_NAMES[f]}(${f})</span>`).join('') + `<span class="lg muted">0 = 개방현</span>`;
  if (pk) h += `<span class="lg"><b>⊓</b> 다운 피킹</span><span class="lg"><b>V</b> 업 피킹</span>` + (song.view.picks ? `<span class="lg muted no-print">파란색 = 추천, 검정 = 직접 입력</span>` : '');
  $('legend').innerHTML = h;
}

$('title').addEventListener('change', e => mutate(() => { song.title = e.target.value || '제목 없음'; syncToolbar(); }));
$('artist').addEventListener('change', e => mutate(() => { song.artist = e.target.value; syncToolbar(); }));
$('bpm').addEventListener('change', e => mutate(() => { song.bpm = Math.max(20, Math.min(400, +e.target.value || 100)); syncToolbar(); }));
$('ts0').addEventListener('change', e => mutate(() => { song.ts = [+$('ts0').value, +$('ts1').value]; }));
$('ts1').addEventListener('change', e => mutate(() => { song.ts = [+$('ts0').value, +$('ts1').value]; }));
$('tuning').addEventListener('change', e => mutate(() => { song.tuning = e.target.value; syncToolbar(); }));
$('tone').addEventListener('change', e => { mutate(() => { song.tone = e.target.value; }); Player.setTone(song.tone); toneDemo(); });
// 리버브 / 딜레이 (재생 중에도 바로 바뀜)
function readFx() {
  song.fx = { rev: $('revOn').checked, revAmt: +$('revAmt').value, del: $('delOn').checked, delAmt: +$('delAmt').value, delTime: $('delTime').value };
  Player.setFx(song.fx, song.bpm * ((+$('speed').value || 100) / 100)); autosave();
}
['revOn', 'delOn', 'delTime'].forEach(id => $(id).addEventListener('change', () => { readFx(); toneDemo(); }));
['revAmt', 'delAmt'].forEach(id => { $(id).addEventListener('input', readFx); $(id).addEventListener('change', toneDemo); });
// 톤을 바꾸면 짧게 들려주기 (재생 중이 아닐 때)
function toneDemo() {
  if (Player.isPlaying()) return;
  const t = TUNINGS[song.tuning].midi;
  [t[5] + 0, t[4] + 2, t[3] + 2].forEach(m => Player.preview(m, song.tone, song.fx, song.bpm));
}
document.querySelectorAll('[data-dur]').forEach(x => x.addEventListener('click', () => setDur(+x.dataset.dur)));
$('bDot').onclick = () => toggleBeat('dot');
$('bTrip').onclick = () => toggleBeat('trip');
document.querySelectorAll('[data-rest]').forEach(x => x.addEventListener('click', () => insertRest(+x.dataset.rest)));
$('bInsBeat').onclick = () => insertBeat();
$('bDelBeat').onclick = () => deleteBeat();
$('bAddMeasures').onclick = () => mutate(() => { for (let i = 0; i < 4; i++) song.measures.push(newMeasure()); status('빈 마디 4개를 추가했어요'); });
$('bBreak').onclick = () => mutate(() => { const m = song.measures[sel.mi]; m.brk = !m.brk; status(m.brk ? `${sel.mi + 1}번째 마디부터 새 줄에서 시작해요` : '줄 바꾸기를 해제했어요'); });
$('bPickD').onclick = () => setPick('d');
$('bPickU').onclick = () => setPick('u');
$('perLine').onchange = e => mutate(() => { song.view.perLine = +e.target.value; });
document.querySelectorAll('[data-tech]').forEach(x => x.addEventListener('click', () => {
  const [act, arg] = x.dataset.tech.split(':');
  if (act === 'bend') return toggleNote('bend', curNote() && curNote().bend && ((arg === 'r' && curNote().bend.r) || (+arg === curNote().bend.a && !curNote().bend.r)) ? null : arg === 'r' ? { a: 1, r: true } : { a: +arg });
  if (act === 'link') return startLink(arg);
  toggleNote(act === 'slide' ? 'slide' : arg, act === 'slide' ? arg : undefined);
}));
// 탭
function showTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.ribbon').forEach(p => p.classList.toggle('on', p.dataset.panel === t));
  try { localStorage.setItem('gtab-tab', t); } catch (e) { }
}
document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
let _tab = 'input'; try { _tab = localStorage.getItem('gtab-tab') || 'input'; } catch (e) { }
showTab(_tab);
// 도움말
function openHelp() { $('helpModal').classList.remove('hidden'); }
$('bHelp').onclick = openHelp;
$('helpClose').onclick = () => $('helpModal').classList.add('hidden');
$('helpModal').onclick = e => { if (e.target.id === 'helpModal') $('helpModal').classList.add('hidden'); };
$('bGrace').onclick = () => toggleBeat('grace');
// 위 메뉴 숨기기/보이기 (휴대폰에서 악보를 넓게)
function setMenuHidden(h) {
  document.body.classList.toggle('menu-hidden', h);
  $('bMenu').textContent = h ? '☰ 메뉴' : '▴';
  $('bMenu').title = h ? '메뉴 다시 보이기' : '위 메뉴 숨기기 (악보를 넓게 보기)';
  try { localStorage.setItem('gtab-menu', h ? '1' : '0'); } catch (e) { }
  setTimeout(() => keepCursorVisible && render(), 0);
}
$('bMenu').onclick = e => { e.stopPropagation(); setMenuHidden(!document.body.classList.contains('menu-hidden')); };
(function () { let h = null; try { h = localStorage.getItem('gtab-menu'); } catch (e) { } if (h === '1') setMenuHidden(true); })();
$('minfo').onclick = e => { e.stopPropagation(); openPopup('measure', $('minfo')); };
$('vTeach').checked = teachOn();
$('vTeach').onchange = e => { try { localStorage.setItem('gtab-teach', e.target.checked ? '1' : '0'); } catch (er) { } render(); };
function openTheory() { $('helpModal').classList.add('hidden'); $('theoryModal').classList.remove('hidden'); }
$('bTheory').onclick = openTheory; $('bTheory2').onclick = openTheory;
$('theoryClose').onclick = () => $('theoryModal').classList.add('hidden');
$('theoryModal').onclick = e => { if (e.target.id === 'theoryModal') $('theoryModal').classList.add('hidden'); };
$('bMeasure').onclick = () => { if (pending) commitPending(); pending = ''; splitMeasure(); };
$('bUndo').onclick = undo; $('bRedo').onclick = redo;
$('vFingers').onclick = () => mutate(() => { song.view.fingers = !song.view.fingers; if (!song.view.fingers) song.measures.forEach(m => m.beats.forEach(b => b.notes.forEach(n => delete n.fa))); syncToolbar(); status(song.view.fingers ? '앞뒤 음을 모두 보고 가장 편한 손가락을 색으로 표시했어요. 숫자를 눌러 직접 바꿀 수도 있어요' : '운지 추천을 껐어요 (직접 칠한 색은 남아요)'); });
$('vPicks').onclick = () => mutate(() => { song.view.picks = !song.view.picks; if (!song.view.picks) song.measures.forEach(m => m.beats.forEach(b => delete b.pa)); syncToolbar(); status(song.view.picks ? '박자 위치에 맞춰 ⊓(다운)/V(업)를 추천했어요. 파란색 = 추천, 위 칸을 누르면 직접 입력' : '피킹 추천을 껐어요'); });
$('vNames').onchange = e => mutate(() => { song.view.names = e.target.checked; });
$('vFnums').onchange = e => mutate(() => { song.view.fingerNums = e.target.checked; });
$('bAutoRhythm').onclick = () => mutate(() => { let c = 0; song.measures.forEach((m, i) => { if (m.beats.length && measureFill(m) !== measureCapacity(measureTs(song, i))) { const cs = rhythmCandidates(song, i); const best = cs.find(x => keepsManual(m, x)) || cs[0]; if (best) { applyTicks(m, best.ticks); c++; } } }); status(c ? `박자가 안 맞던 마디 ${c}개의 리듬을 자동으로 맞췄어요` : '모든 마디의 박자가 이미 맞아요'); });
$('bClearFingers').onclick = () => mutate(() => { song.measures.forEach(m => m.beats.forEach(b => b.notes.forEach(n => delete n.fm))); status('직접 칠한 손가락 색을 모두 지웠어요'); });

// 파일
// 기본 저장 = MusicXML (다른 악보 프로그램에서도 열리는 공통 형식)
function safeName() { return (song.title || '악보').replace(/[\\/:*?"<>|]/g, '_'); }
function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function xmlBlob() { return new Blob([MusicXML.exportSong(song)], { type: 'application/vnd.recordare.musicxml+xml' }); }
function saveFile() {
  downloadBlob(xmlBlob(), safeName() + '.musicxml');
  status(IS_IOS ? '저장했어요: "파일" 앱 → 다운로드 폴더에 있어요 (.musicxml)' : '저장했어요: 다운로드 폴더의 .musicxml 파일 (Guitar Pro, MuseScore에서도 열려요)');
}
function saveJson() {
  downloadBlob(new Blob([JSON.stringify(song, null, 1)], { type: 'application/json' }), safeName() + '.gtab.json');
  status('백업 파일(.gtab.json)을 저장했어요. 이 프로그램의 모든 정보(검사 표시 등)가 그대로 들어 있어요');
}
async function shareFile() {
  const file = new File([MusicXML.exportSong(song)], safeName() + '.musicxml', { type: 'application/xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: song.title }); status('보냈어요'); } catch (e) { if (e.name !== 'AbortError') saveFile(); }
  } else saveFile();
}
$('bSave').onclick = saveFile;
$('bSaveJson').onclick = saveJson;
$('bShare').onclick = shareFile;
if (!(navigator.share && navigator.canShare)) $('bShare').style.display = 'none';
$('bOpen').onclick = () => $('fileInput').click();
// iOS는 낯선 확장자(.musicxml)를 회색으로 막는 경우가 있어서 모든 파일을 고를 수 있게
if (IS_IOS) $('fileInput').removeAttribute('accept');
$('fileInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (/\.pdf$/i.test(f.name)) { status('PDF는 "PDF 악보 불러오기" 버튼으로 열어주세요', true); return; }
  try {
    const buf = await f.arrayBuffer();
    const r = await MusicXML.importFile(f.name, buf);
    const s = fixSong(r.json ? r.json : r);
    snapshot(); song = s; sel = { mi: 0, bi: 0, s: 0 }; changed(true);
    const chk = song.measures.filter(m => m.check).length;
    status(`"${song.title}" 악보를 불러왔어요 (${song.measures.length}마디)` + (chk ? ` · ⚠ 박자가 안 맞는 마디 ${chk}개` : ''));
  } catch (err) {
    console.error(err);
    const why = { NO_UNZIP: '이 브라우저는 압축된 .mxl 파일을 풀 수 없어요. 원래 프로그램에서 압축 안 된 .musicxml로 내보내 주세요.', UNKNOWN_FORMAT: '악보 파일 형식이 아니에요. (.musicxml, .xml, .mxl, .gtab.json을 열 수 있어요)' }[err && err.message];
    alert(why || '이 파일은 열 수 없어요. (' + (err && err.message) + ')'); status('파일을 열지 못했어요', true);
  }
};
$('bNew').onclick = () => { if (!confirm('새 악보를 만들까요? (지금 악보는 Ctrl+Z로 되돌릴 수 있어요)')) return; snapshot(); song = newSong(); sel = { mi: 0, bi: 0, s: 0 }; changed(true); };
$('bDemo').onclick = () => { snapshot(); song = demoSong(); sel = { mi: 0, bi: 0, s: 0 }; changed(true); status('예제 악보를 불러왔어요. ▶ 재생을 눌러보세요'); };

function exportPdf() {
  status('인쇄 창에서 "대상(프린터)"을 "PDF로 저장"으로 고르고 저장을 누르세요');
  setTimeout(() => window.print(), 100);
}
$('bPdf').onclick = exportPdf;
window.addEventListener('beforeprint', () => { printMode = true; render(); });
window.addEventListener('afterprint', () => { printMode = false; render(); });

// ---------- 터치 기기: 화면 확대 / 숫자 자판 ----------
function touchZoom() {
  if (!IS_TOUCH) return 1;
  const w = window.innerWidth; return w < 700 ? 1.2 : w < 1100 ? 1.15 : 1.1;
}
// 터치 기기: 숫자 패드/자판에 가려지지 않게 선택한 줄을 화면 안으로
function keepCursorVisible() {
  if (!layout || !layout.msys) return;
  const popOpen = !$('popup').classList.contains('hidden');
  if (!IS_TOUCH && !popOpen) return;
  const si = layout.msys[sel.mi]; const svg = si !== undefined && scoreEl.querySelector(`svg[data-si="${si}"]`); if (!svg) return;
  const r = svg.getBoundingClientRect();
  const pad = $('pad'); let bottom = pad.classList.contains('hidden') ? (window.visualViewport ? window.visualViewport.height : window.innerHeight) - 40 : pad.getBoundingClientRect().top - 6;
  if (popOpen) bottom = Math.min(bottom, $('popup').getBoundingClientRect().top - 6);
  const top = $('toolbar').getBoundingClientRect().bottom + 4;
  if (r.bottom > bottom) window.scrollBy(0, Math.min(r.bottom - bottom, r.top - top));
  else if (r.top < top) window.scrollBy(0, r.top - top);
}
function wantKbd() { return IS_TOUCH && $('pad').classList.contains('hidden'); }
function focusKbd() { const k = $('kbd'); k.value = ''; try { k.focus({ preventScroll: true }); } catch (e) { k.focus(); } }
let kbdTimer = null;
function kbdCommit() { clearTimeout(kbdTimer); kbdTimer = null; if (!pending) return; commitPending(); pending = ''; moveRight(); afterFill(); render(); }
$('kbd').addEventListener('input', () => {
  const k = $('kbd'); const v = k.value.replace(/\D/g, ''); k.value = '';
  for (const ch of v) {
    pending = (pending + ch).slice(-2);
    // 3~9로 시작하면 한 자리, 1·2로 시작하면 다음 숫자를 잠깐 기다림 (12, 24 등)
    if (pending.length === 2 || +pending >= 3) kbdCommit();
  }
  clearTimeout(kbdTimer);
  if (pending) { render(); kbdTimer = setTimeout(kbdCommit, 900); }
});
$('kbd').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); if (pending) kbdCommit(); else { moveRight(); render(); } }
  else if (e.key === 'Backspace' && !$('kbd').value) { e.preventDefault(); if (pending) { pending = pending.slice(0, -1); render(); } else deleteNote(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault(); kbdCommit();
    if (e.key === 'ArrowRight') moveRight(); else if (e.key === 'ArrowLeft') moveLeft(); else sel.s = Math.max(0, Math.min(5, sel.s + (e.key === 'ArrowUp' ? -1 : 1)));
    render();
  } else if (/^[a-zA-Z ]$/.test(e.key)) { // 아이패드 실물 키보드 단축키(M, S, H...)
    $('kbd').blur(); document.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, shiftKey: e.shiftKey }));
    e.preventDefault();
  }
});
$('kbd').addEventListener('blur', () => { if (pending) kbdCommit(); });
$('fab').onclick = e => { e.stopPropagation(); setPad(true); };
if (IS_TOUCH) document.body.classList.add('touch');

// ---------- 화면 숫자 패드 (아이패드/터치용) ----------
(function () {
  const nums = $('padNums'); let h = '';
  for (let f = 0; f <= 24; f++) h += `<button data-fret="${f}">${f}</button>`;
  nums.innerHTML = h;
})();
function setPad(on) { $('pad').classList.toggle('hidden', !on); $('padOn').checked = on; $('fab').classList.toggle('hidden', on || !IS_TOUCH); if (on) $('kbd').blur(); document.body.classList.toggle('padopen', on); try { localStorage.setItem('gtab-pad', on ? '1' : '0'); } catch (e) { } }
$('padOn').onchange = e => setPad(e.target.checked);
$('pad').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.fret !== undefined) { pending = b.dataset.fret; commitPending(); pending = ''; moveRight(); afterFill(); render(); return; }
  switch (b.dataset.pad) {
    case 'left': moveLeft(); break;
    case 'right': moveRight(); break;
    case 'up': sel.s = Math.max(0, sel.s - 1); break;
    case 'down': sel.s = Math.min(5, sel.s + 1); break;
    case 'x': if (!curNote()) { pending = '0'; commitPending(); pending = ''; } toggleNote('dead'); return;
    case 'del': deleteNote(); return;
    case 'rest': insertRest(); return;
    case 'measure': splitMeasure(); return;
    case 'ins': insertBeat(); return;
    case 'hide': setPad(false); return;
    case 'kbd': setPad(false); focusKbd(); status('숫자 자판으로 입력하세요. 줄 위를 누르면 자판이 다시 나와요'); return;
  }
  closePopup(); render();
});
(function () { let on = null; try { on = localStorage.getItem('gtab-pad'); } catch (e) { } setPad(on === null ? matchMedia('(pointer: coarse)').matches : on === '1'); })();

// ---------- PDF 자동 인식 ----------
$('bImportPdf').onclick = () => $('pdfInput').click();
$('pdfInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const busy = $('busy'), bt = $('busyText');
  busy.classList.remove('hidden'); bt.textContent = 'PDF 읽는 중...';
  try {
    if (!window.pdfjsLib) throw new Error('NO_LIB');
    if (window.pdfjsLib.GlobalWorkerOptions) window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    const buf = new Uint8Array(await f.arrayBuffer());
    const r = await PdfImport.importPdf(window.pdfjsLib, buf, (p, n) => { bt.textContent = `악보 인식 중... (${p} / ${n} 페이지)`; });
    snapshot();
    song = fixSong(r.song); sel = { mi: 0, bi: 0, s: 0 };
    changed(true);
    const chk = song.measures.filter(m => m.check).length;
    status(`"${song.title}" 악보를 불러왔어요: ${song.measures.length}마디. ${chk ? `⚠ 표시된 ${chk}마디는 원본과 한 번 비교해 주세요.` : '모든 마디의 박자가 맞아요.'}`);
    alert(`✅ PDF 인식 완료\n\n제목: ${song.title}\n마디: ${song.measures.length}개\n빠르기: ${song.bpm} BPM\n\n${chk ? `⚠ 주황색 마디 번호(${chk}개)는 리듬을 추측해서 맞춘 곳이에요.\n원본과 비교해서 필요하면 고쳐 주세요.` : '모든 마디의 박자가 맞아요.'}\n\n(되돌리려면 Ctrl+Z)`);
  } catch (err) {
    console.error(err);
    const msg = err && err.message === 'NO_TAB' ? '이 PDF에서 타브(6줄) 악보를 찾지 못했어요.\n스캔하거나 사진으로 찍은 PDF는 아직 인식할 수 없어요.\n(Guitar Pro, MuseScore 등에서 내보낸 PDF는 인식돼요)' : '이 PDF를 읽지 못했어요. (' + (err && err.message) + ')';
    alert(msg); status('PDF 인식 실패', true);
  } finally { busy.classList.add('hidden'); }
};

// ---------- 재생 ----------
let rafId = null;
function startPlay(from) {
  if (pending) commitPending(); pending = '';
  const loop = $('loopOn').checked;
  let a = from !== undefined ? from : sel.mi, b = song.measures.length - 1;
  if (loop) { a = Math.max(0, (+$('loopA').value || 1) - 1); b = Math.min(song.measures.length - 1, (+$('loopB').value || song.measures.length) - 1); if (b < a) b = a; }
  if (!song.measures.slice(a, b + 1).some(m => m.beats.some(bt => !isRest(bt)))) { status('재생할 음이 없어요', true); return; }
  Player.play(song, { from: a, to: b, speed: (+$('speed').value || 100) / 100, metronome: $('metroOn').checked, countIn: $('countIn').checked, loop }, onPlayStop);
  $('bPlay').textContent = '■ 정지'; $('bPlay').classList.add('on');
  cancelAnimationFrame(rafId); tick();
}
function onPlayStop() {
  $('bPlay').textContent = '▶ 재생'; $('bPlay').classList.remove('on');
  document.querySelectorAll('.playhead').forEach(p => p.style.display = 'none');
  cancelAnimationFrame(rafId);
}
function togglePlay() { if (Player.isPlaying()) { Player.stop(); } else startPlay(); }
let lastBeatId = null;
function tick() {
  const cb = Player.currentBeat();
  if (cb && cb.id !== lastBeatId && layout) {
    lastBeatId = cb.id;
    const bp = layout.beatPos[cb.id];
    document.querySelectorAll('.playhead').forEach(p => p.style.display = 'none');
    if (bp) {
      const svg = scoreEl.querySelector(`svg[data-si="${bp.si}"]`);
      const ph = svg && svg.querySelector('.playhead');
      if (ph) { ph.setAttribute('x', bp.x0 + 1); ph.setAttribute('width', Math.max(10, bp.w - 2)); ph.style.display = ''; }
      if (svg && $('follow').checked) { const r = svg.getBoundingClientRect(); if (r.top < 120 || r.bottom > window.innerHeight - 40) window.scrollBy({ top: r.top - 160, behavior: 'smooth' }); }
    }
  }
  if (Player.isPlaying()) rafId = requestAnimationFrame(tick);
}
$('bPlay').onclick = togglePlay;
$('speed').oninput = () => { $('speedVal').textContent = $('speed').value + '%'; };

window.addEventListener('resize', () => { clearTimeout(window._rz); window._rz = setTimeout(render, 120); });

// ---------- 시작 ----------
song = loadAutosave() || demoSong();
syncToolbar();
changed();
status(IS_TOUCH ? '줄 위를 누르고 아래 숫자 패드로 프렛을 입력하세요' : '줄 위를 클릭하고 숫자 → Enter. 아래 단축키 안내를 참고하세요');
// 홈 화면 앱(오프라인) 지원: 인터넷 주소(https)에서 열었을 때만
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
