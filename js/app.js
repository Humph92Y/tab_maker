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
  if (syncUi) syncToolbar();
  render();
  if (popupInfo) reopenPopup();
}

function clampSel() {
  sel.mi = Math.max(0, Math.min(sel.mi, song.measures.length - 1));
  sel.bi = Math.max(0, Math.min(sel.bi, song.measures[sel.mi].beats.length));
  sel.s = Math.max(0, Math.min(5, sel.s));
}

// ---------- 그리기 ----------
function render() {
  layout = renderScore(scoreEl, song, { sel, pending, mode: mode && { from: mode.from }, print: printMode, width: printMode ? 760 : scoreEl.clientWidth });
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
  $('minfo').textContent = `${sel.mi + 1}번째 마디 · ${fmt(fill)} / ${ts[0]}박 채움` + (fill > cap ? ' (넘침!)' : fill < cap && m.beats.length ? ' (모자람)' : fill === cap ? ' ✓' : '');
  $('minfo').className = fill > cap ? 'warn' : '';
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
  if (n && !Player.isPlaying() && $('previewOn').checked) Player.preview(noteMidi(song, n), song.tone);
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
  mode = { type, from: n || null, pos: n ? { ...sel } : null };
  closePopup();
  status(n ? `${name}: 이어질 다음 숫자를 클릭하세요 (Esc = 취소)` : `${name}: 시작할 숫자를 클릭하세요 (Esc = 취소)`);
  $('status').className = 'mode';
  render();
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
  if (b) mutate(() => { b.dur = d; }); else render();
}
function changeDur(dir) {
  const b = curBeat(); const i = DUR_LIST.indexOf(b ? b.dur : inputDur);
  const ni = Math.max(0, Math.min(DUR_LIST.length - 1, i + dir));
  setDur(DUR_LIST[ni]);
}
function toggleBeat(prop) {
  const b = curBeat(); if (!b) return status('먼저 음(칸)을 선택하세요', true);
  mutate(() => { b[prop] = !b[prop]; });
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
  mutate(() => { m.beats.splice(Math.min(sel.bi, m.beats.length), 0, newBeat(d)); sel.bi++; afterFill(); });
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
    case 'Escape': $('helpModal').classList.add('hidden'); pending = ''; if (mode) { mode = null; status('취소했어요'); } closePopup(); render(); break;
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
    status(`${s + 1}번 줄에 새 칸을 끼워 넣었어요. 숫자를 입력하고 Enter`);
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
    else { closePopup(); status('숫자(프렛)를 입력하고 Enter를 누르세요'); }
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
function closePopup() { $('popup').classList.add('hidden'); popupInfo = null; }
function reopenPopup() {
  if (!popupInfo) return;
  if (popupInfo.type === 'note' && !curNote()) return closePopup();
  if (popupInfo.type !== 'measure' && popupInfo.type !== 'note' && !curBeat()) return closePopup();
  buildPopup(popupInfo.type); placePopup();
}
function openPopup(type, anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  popupInfo = { type, x: r.left + window.scrollX, y: r.bottom + window.scrollY };
  buildPopup(type); placePopup();
}
function placePopup() {
  const p = $('popup'); p.classList.remove('hidden');
  let x = popupInfo.x, y = popupInfo.y + 6;
  const w = p.offsetWidth; if (x + w > window.scrollX + window.innerWidth - 10) x = window.scrollX + window.innerWidth - w - 10;
  p.style.left = Math.max(5, x) + 'px'; p.style.top = y + 'px';
}
function btn(label, act, on, title) { return `<button data-act="${act}" class="${on ? 'on' : ''}" ${title ? `title="${title}"` : ''}>${label}</button>`; }

function buildPopup(type) {
  const p = $('popup'); let h = '';
  if (type === 'note') {
    const n = curNote(), midi = noteMidi(song, n);
    h += `<div class="ph">${n.s + 1}번 줄 · <b>${n.f}</b>프렛 <span class="muted">(${midiName(midi)})</span> ${btn('▶ 듣기', 'listen')}</div>`;
    h += `<div class="prow"><label>숫자 고치기</label><input id="pfret" type="number" min="0" max="24" value="${n.f}" style="width:60px"> ${btn('적용', 'setfret')} ${btn('🗑 삭제', 'del')}</div>`;
    h += `<div class="prow"><label>손가락 색</label>`;
    [1, 2, 3, 4, 'T'].forEach(f => h += `<button data-act="finger:${f}" class="fbtn ${n.fm == f ? 'on' : ''}" style="--fc:${FINGER_COLORS[f]}">${FINGER_NAMES[f]}${f === 'T' ? '' : ' ' + f}</button>`);
    h += btn('색 없음', 'finger:none', !n.fm) + (n.fa && !n.fm ? `<span class="muted"> 추천: ${FINGER_NAMES[n.fa]}</span>` : '') + `</div>`;
    h += `<div class="prow"><label>벤딩 (B)</label>${btn('없음', 'bend:none', !n.bend)}${btn('½', 'bend:0.5', n.bend && n.bend.a === 0.5 && !n.bend.r)}${btn('full', 'bend:1', n.bend && n.bend.a === 1 && !n.bend.r)}${btn('1½', 'bend:1.5', n.bend && n.bend.a === 1.5)}${btn('벤딩→릴리즈', 'bend:r', n.bend && n.bend.r)}</div>`;
    h += `<div class="prow"><label>연결</label>${btn('슬라이드 → 다음 음 (S)', 'link:slide', n.slide === 'to')}${btn('해머/풀 → 다음 음 (H)', 'link:hp', n.hp)}${btn('붙임줄(tie)', 'tog:tie', n.tie, '앞 음과 이어서 길게')}</div>`;
    h += `<div class="prow"><label>슬라이드 인/아웃</label>${btn('↗ 아래에서 미끄러져 들어감', 'slide:in', n.slide === 'in')}${btn('↘ 미끄러져 나감', 'slide:out', n.slide === 'out')}</div>`;
    h += `<div class="prow"><label>주법</label>${btn('비브라토 (V)', 'tog:vib', n.vib)}${btn('팜뮤트 (P)', 'tog:pm', n.pm)}${btn('렛링 (L)', 'tog:lr', n.lr)}${btn('데드노트 x (X)', 'tog:dead', n.dead)}${btn('고스트 ( ) (G)', 'tog:ghost', n.ghost)}${btn('하모닉 < >', 'tog:harm', n.harm)}${btn('악센트 > (A)', 'tog:acc', n.acc)}${btn('꾸밈음 (Q)', 'btog:grace', curBeat().grace)}</div>`;
  } else if (type === 'rhythm') {
    const b = curBeat(); if (!b) return;
    h += `<div class="ph">음표 길이 (이 칸)</div><div class="prow">`;
    DUR_LIST.forEach(d => h += btn(durIcon(d) + ' ' + DUR_LABEL[d], 'dur:' + d, b.dur === d));
    h += `</div><div class="prow">${btn('점음표 (.)', 'btog:dot', b.dot)}${btn('셋잇단 (T)', 'btog:trip', b.trip)}${btn('꾸밈음 (Q)', 'btog:grace', b.grace, '작은 숫자로, 박자를 차지하지 않고 바로 앞에서 짧게 치는 음')}${btn('이 칸을 쉼표로', 'rest', isRest(b))}</div>`;
    h += `<div class="prow"><label>피킹</label>${btn('⊓ 다운 (D)', 'pick:d', b.pick === 'd')}${btn('V 업 (U)', 'pick:u', b.pick === 'u')}${btn('직접 입력 지우기', 'pick:none', !b.pick)}${b.pa ? `<span class="muted"> 추천: ${b.pa === 'd' ? '⊓' : 'V'}</span>` : ''}</div>`;
    h += `<div class="prow">${btn('✨ 이 마디 리듬 자동 추천', 'autorhythm')}${btn('앞에 쉼표 칸 넣기 (I)', 'insbeat')}${btn('이 칸 삭제', 'delbeat')}</div>`;
  } else if (type === 'measure') {
    const m = song.measures[sel.mi]; const ts = m.ts || song.ts;
    h += `<div class="ph">${sel.mi + 1}번째 마디</div>`;
    h += `<div class="prow"><label>구간 이름</label><input id="psec" value="${esc(m.section || '')}" placeholder="예: Intro, Verse, 솔로" style="width:150px"> ${btn('적용', 'setsec')}</div>`;
    h += `<div class="prow"><label>이 마디부터 박자</label><select id="pts0">${[1, 2, 3, 4, 5, 6, 7, 9, 12].map(v => `<option ${v === ts[0] ? 'selected' : ''}>${v}</option>`).join('')}</select> / <select id="pts1">${[2, 4, 8, 16].map(v => `<option ${v === ts[1] ? 'selected' : ''}>${v}</option>`).join('')}</select> ${btn('적용', 'setts')} ${m.ts ? btn('기본 박자로', 'clearts') : ''}</div>`;
    if (m.check) h += `<div class="prow"><span class="muted">⚠ PDF에서 자동 인식한 마디예요. 원본과 비교해 보세요.</span> ${btn('✓ 확인 완료', 'mchecked')}</div>`;
    h += `<div class="prow">${btn('▶ 여기서부터 재생', 'playfrom')}${btn('✨ 리듬 자동 추천', 'autorhythm')}</div>`;
    h += `<div class="prow">${btn('앞에 마디 추가', 'maddb')}${btn('뒤에 마디 추가', 'madda')}${btn('마디 복사해서 뒤에 붙이기', 'mcopy')}${btn('🗑 마디 삭제', 'mdel')}</div><div class="prow">${btn('↵ 이 마디부터 새 줄', 'mbrk', m.brk)}</div>`;
  }
  p.innerHTML = h + `<button class="pclose" data-act="close">✕</button>`;
}
function durIcon(d) { return { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯', 32: '𝅘𝅥𝅰' }[d]; }

$('popup').addEventListener('click', e => {
  e.stopPropagation();
  const b = e.target.closest('[data-act]'); if (!b) return;
  const [act, arg] = b.dataset.act.split(':');
  const n = curNote(), beat = curBeat(), m = song.measures[sel.mi];
  switch (act) {
    case 'close': closePopup(); break;
    case 'listen': previewAt(sel.mi, sel.bi, sel.s); if (Player.isPlaying()) break; Player.preview(noteMidi(song, n), song.tone); break;
    case 'setfret': { const v = parseInt($('pfret').value, 10); if (isNaN(v) || v < 0 || v > 24) return status('0~24 사이 숫자를 넣어주세요', true); mutate(() => { n.f = v; }); break; }
    case 'del': deleteNote(); break;
    case 'finger': mutate(() => { if (arg === 'none') delete n.fm; else n.fm = arg === 'T' ? 'T' : +arg; }); break;
    case 'bend': toggleNote('bend', arg === 'none' ? null : arg === 'r' ? { a: 1, r: true } : { a: +arg }); break;
    case 'link': startLink(arg); break;
    case 'slide': toggleNote('slide', arg); break;
    case 'tog': toggleNote(arg); break;
    case 'dur': setDur(+arg); break;
    case 'btog': toggleBeat(arg); break;
    case 'rest': makeRest(); break;
    case 'pick': mutate(() => { beat.pick = arg === 'none' ? null : arg; }); break;
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
$('tone').addEventListener('change', e => { mutate(() => { song.tone = e.target.value; }); });
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
$('bMeasure').onclick = () => { if (pending) commitPending(); pending = ''; splitMeasure(); };
$('bUndo').onclick = undo; $('bRedo').onclick = redo;
$('vFingers').onclick = () => mutate(() => { song.view.fingers = !song.view.fingers; if (!song.view.fingers) song.measures.forEach(m => m.beats.forEach(b => b.notes.forEach(n => delete n.fa))); syncToolbar(); status(song.view.fingers ? '앞뒤 음을 모두 보고 가장 편한 손가락을 색으로 표시했어요. 숫자를 눌러 직접 바꿀 수도 있어요' : '운지 추천을 껐어요 (직접 칠한 색은 남아요)'); });
$('vPicks').onclick = () => mutate(() => { song.view.picks = !song.view.picks; if (!song.view.picks) song.measures.forEach(m => m.beats.forEach(b => delete b.pa)); syncToolbar(); status(song.view.picks ? '박자 위치에 맞춰 ⊓(다운)/V(업)를 추천했어요. 파란색 = 추천, 위 칸을 누르면 직접 입력' : '피킹 추천을 껐어요'); });
$('vNames').onchange = e => mutate(() => { song.view.names = e.target.checked; });
$('vFnums').onchange = e => mutate(() => { song.view.fingerNums = e.target.checked; });
$('bAutoRhythm').onclick = () => mutate(() => { let c = 0; song.measures.forEach((m, i) => { if (m.beats.length && measureFill(m) !== measureCapacity(measureTs(song, i))) { suggestRhythm(song, i); c++; } }); status(c ? `박자가 안 맞던 마디 ${c}개의 리듬을 자동으로 맞췄어요` : '모든 마디의 박자가 이미 맞아요'); });
$('bClearFingers').onclick = () => mutate(() => { song.measures.forEach(m => m.beats.forEach(b => b.notes.forEach(n => delete n.fm))); status('직접 칠한 손가락 색을 모두 지웠어요'); });

// 파일
function saveFile() {
  const blob = new Blob([JSON.stringify(song, null, 1)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (song.title || '악보').replace(/[\\/:*?"<>|]/g, '_') + '.gtab.json';
  document.body.appendChild(a); a.click(); a.remove();
  status('악보 파일을 저장했어요 (다운로드 폴더를 확인하세요)');
}
$('bSave').onclick = saveFile;
$('bOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { const s = fixSong(JSON.parse(r.result)); snapshot(); song = s; sel = { mi: 0, bi: 0, s: 0 }; changed(true); status('악보를 불러왔어요'); } catch (err) { status('이 파일은 열 수 없어요', true); } };
  r.readAsText(f); e.target.value = '';
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

// ---------- 화면 숫자 패드 (아이패드/터치용) ----------
(function () {
  const nums = $('padNums'); let h = '';
  for (let f = 0; f <= 24; f++) h += `<button data-fret="${f}">${f}</button>`;
  nums.innerHTML = h;
})();
function setPad(on) { $('pad').classList.toggle('hidden', !on); $('padOn').checked = on; document.body.classList.toggle('padopen', on); try { localStorage.setItem('gtab-pad', on ? '1' : '0'); } catch (e) { } }
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
status('줄 위를 클릭하고 숫자 → Enter. 아래 단축키 안내를 참고하세요');
