// ===== MusicXML 저장/불러오기 =====
// MusicXML = 악보 프로그램들이 서로 주고받는 "공통 악보 파일" 형식.
// Guitar Pro, MuseScore, TuxGuitar, Finale, Sibelius, Dorico 등에서 열 수 있어요.
// 기타 타브 정보(줄 번호, 프렛)는 <technical><string>, <fret>에 들어가요.
const MusicXML = (function () {
  const STEPS = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const TYPE = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd' };
  const TYPE_R = { whole: 1, half: 2, quarter: 4, eighth: 8, '16th': 16, '32nd': 32, '64th': 32 };
  const x = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pitchXml = midi => { const [st, al] = STEPS[((midi % 12) + 12) % 12]; return `<pitch><step>${st}</step>${al ? `<alter>${al}</alter>` : ''}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`; };

  // ---------- 저장 ----------
  function exportSong(song) {
    const tun = TUNINGS[song.tuning].midi;
    const tieStart = new Set(), slideStop = new Set(), hpStop = {};
    song.measures.forEach((m, mi) => m.beats.forEach((b, bi) => b.notes.forEach(n => {
      if (n.tie) { const p = prevOnString(song, mi, bi, n.s); if (p) tieStart.add(p.note.id); }
      if (n.slide === 'to') { const q = nextOnString(song, mi, bi, n.s); if (q) slideStop.add(q.note.id); }
      if (n.hp) { const q = nextOnString(song, mi, bi, n.s); if (q) hpStop[q.note.id] = q.note.f > n.f ? 'hammer-on' : 'pull-off'; }
    })));
    let o = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0">\n`;
    o += `<work><work-title>${x(song.title)}</work-title></work>\n<identification>${song.artist ? `<creator type="composer">${x(song.artist)}</creator>` : ''}<encoding><software>타브 메이커</software></encoding></identification>\n`;
    o += `<part-list><score-part id="P1"><part-name>Guitar</part-name><score-instrument id="P1-I1"><instrument-name>Guitar</instrument-name></score-instrument><midi-instrument id="P1-I1"><midi-program>${song.tone === 'distortion' ? 31 : 28}</midi-program></midi-instrument></score-part></part-list>\n<part id="P1">\n`;
    let prevTs = null;
    song.measures.forEach((m, mi) => {
      const ts = measureTs(song, mi);
      o += `<measure number="${mi + 1}">\n`;
      if (mi > 0 && m.brk) o += `<print new-system="yes"/>\n`;
      if (mi === 0 || !prevTs || prevTs[0] !== ts[0] || prevTs[1] !== ts[1]) {
        o += `<attributes>${mi === 0 ? '<divisions>480</divisions><key><fifths>0</fifths></key>' : ''}<time><beats>${ts[0]}</beats><beat-type>${ts[1]}</beat-type></time>`;
        if (mi === 0) {
          o += `<clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>`;
          for (let l = 1; l <= 6; l++) { const midi = tun[6 - l]; const [st, al] = STEPS[midi % 12]; o += `<staff-tuning line="${l}"><tuning-step>${st}</tuning-step>${al ? `<tuning-alter>${al}</tuning-alter>` : ''}<tuning-octave>${Math.floor(midi / 12) - 1}</tuning-octave></staff-tuning>`; }
          o += `</staff-details>`;
        }
        o += `</attributes>\n`;
        prevTs = ts;
      }
      if (mi === 0) o += `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${song.bpm}</per-minute></metronome></direction-type><sound tempo="${song.bpm}"/></direction>\n`;
      if (m.section) o += `<direction placement="above"><direction-type><rehearsal>${x(m.section)}</rehearsal></direction-type></direction>\n`;
      if (!m.beats.length) { o += `<note><rest measure="yes"/><duration>${measureCapacity(ts)}</duration><voice>1</voice></note>\n`; }
      m.beats.forEach((b, bi) => {
        const dur = Math.round(beatTicks(b));
        const common = () => {
          let c = '';
          if (!b.grace) c += `<duration>${dur}</duration>`;
          return c;
        };
        const after = () => `<voice>1</voice><type>${TYPE[b.dur]}</type>${b.dot ? (b.dot === 2 ? '<dot/><dot/>' : '<dot/>') : ''}${b.trip ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : ''}`;
        if (isRest(b)) { o += `<note><rest/>${common()}${after()}</note>\n`; return; }
        const ns = b.notes.slice().sort((a, c) => c.s - a.s); // 낮은 줄부터
        ns.forEach((n, k) => {
          const midi = tun[n.s] + n.f;
          let t = `<note>${b.grace ? '<grace slash="yes"/>' : ''}${k ? '<chord/>' : ''}${pitchXml(midi)}${common()}`;
          if (n.tie) t += `<tie type="stop"/>`; if (tieStart.has(n.id)) t += `<tie type="start"/>`;
          t += after();
          if (n.dead) t += `<notehead>x</notehead>`; else if (n.ghost) t += `<notehead parentheses="yes">normal</notehead>`;
          // notations
          let nt = '', tech = `<string>${n.s + 1}</string><fret>${n.f}</fret>`, orn = '', art = '';
          if (n.tie) nt += `<tied type="stop"/>`; if (tieStart.has(n.id)) nt += `<tied type="start"/>`;
          if (slideStop.has(n.id)) nt += `<slide type="stop" number="1"/>`;
          if (n.slide === 'to') nt += `<slide type="start" number="1" line-type="solid"/>`;
          if (hpStop[n.id]) tech += `<${hpStop[n.id]} type="stop" number="1"/>`;
          if (n.hp) { const q = nextOnString(song, mi, bi, n.s); tech += `<${q && q.note.f < n.f ? 'pull-off' : 'hammer-on'} type="start" number="1">${q && q.note.f < n.f ? 'P' : 'H'}</${q && q.note.f < n.f ? 'pull-off' : 'hammer-on'}>`; }
          if (n.bend) tech += `<bend><bend-alter>${n.bend.a * 2}</bend-alter>${n.bend.r ? '<release/>' : ''}</bend>`;
          if (n.harm) tech += `<harmonic><natural/></harmonic>`;
          if (n.fm) tech += `<fingering>${n.fm === 'T' ? 'T' : n.fm}</fingering>`;
          if (n.pm) tech += `<other-technical>palm mute</other-technical>`;
          if (n.lr) tech += `<other-technical>let ring</other-technical>`;
          if (n.slide === 'in') tech += `<other-technical>slide in</other-technical>`;
          if (n.slide === 'out') tech += `<other-technical>slide out</other-technical>`;
          if (k === 0 && b.pick === 'd') tech = `<down-bow/>` + tech;
          if (k === 0 && b.pick === 'u') tech = `<up-bow/>` + tech;
          if (n.vib) orn += `<wavy-line type="start"/><wavy-line type="stop"/>`;
          if (n.acc) art += `<accent/>`;
          nt += `<technical>${tech}</technical>`;
          if (orn) nt += `<ornaments>${orn}</ornaments>`;
          if (art) nt += `<articulations>${art}</articulations>`;
          t += `<notations>${nt}</notations></note>\n`;
          o += t;
        });
      });
      if (mi === song.measures.length - 1) o += `<barline location="right"><bar-style>light-heavy</bar-style></barline>\n`;
      o += `</measure>\n`;
    });
    o += `</part>\n</score-partwise>\n`;
    return o;
  }
  // ---------- 불러오기 ----------
  const kids = (el, name) => el ? Array.from(el.children).filter(c => c.localName === name) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const txt = (el, name) => { const k = kid(el, name); return k ? k.textContent.trim() : ''; };
  const STEP_N = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function importXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML_BAD');
    let root = doc.documentElement;
    if (root.localName === 'score-timewise') throw new Error('TIMEWISE');
    if (root.localName !== 'score-partwise') throw new Error('NOT_MUSICXML');
    const song = newSong(); song.measures = []; song.view.perLine = 4;
    song.title = txt(kid(root, 'work'), 'work-title') || txt(root, 'movement-title') || '불러온 악보';
    const ident = kid(root, 'identification');
    const cr = kids(ident, 'creator'); song.artist = (cr.find(c => /composer|artist/i.test(c.getAttribute('type') || '')) || cr[0] || { textContent: '' }).textContent.trim();
    if (!song.artist) { const cw = Array.from(root.getElementsByTagName('credit-words')).map(e => e.textContent.trim()); if (cw.length > 1) song.artist = cw[1]; }
    // 기타(타브) 파트 고르기: string/fret 이 있거나 TAB 음자리표가 있는 파트, 없으면 첫 파트
    const parts = kids(root, 'part');
    if (!parts.length) throw new Error('NO_PART');
    const score = p => p.getElementsByTagName('fret').length * 2 + (Array.from(p.getElementsByTagName('sign')).some(s => s.textContent.trim() === 'TAB') ? 50 : 0) + p.getElementsByTagName('note').length * 0.001;
    const part = parts.slice().sort((a, b) => score(b) - score(a))[0];
    // 여러 보표(오선+타브)가 있으면 fret 이 있는 보표만
    let useStaff = null;
    const fretNotes = Array.from(part.getElementsByTagName('note')).filter(n => n.getElementsByTagName('fret').length);
    if (fretNotes.length) { const st = kid(fretNotes[0], 'staff'); useStaff = st ? st.textContent.trim() : null; }
    let divisions = 1, ts = null, tuning = null, voice = null;
    let pendingTieStarts = {};
    const allNotes = []; // for tuning-free string assignment
    kids(part, 'measure').forEach((mel, mIdx) => {
      const m = newMeasure(); let mTs = null;
      let lastBeat = null;
      Array.from(mel.children).forEach(el => {
        const tag = el.localName;
        if (tag === 'attributes') {
          const dv = txt(el, 'divisions'); if (dv) divisions = +dv;
          const tm = kid(el, 'time'); if (tm && txt(tm, 'beats')) { const nts = [parseInt(txt(tm, 'beats'), 10) || 4, +txt(tm, 'beat-type') || 4]; if (!ts) ts = nts; mTs = nts; }
          kids(el, 'staff-details').forEach(sd => {
            const sn = sd.getAttribute('number'); if (useStaff && sn && sn !== useStaff) return;
            const tl = kids(sd, 'staff-tuning'); if (tl.length >= 6) { const arr = []; tl.forEach(t => { const l = +t.getAttribute('line'); arr[l] = (+txt(t, 'tuning-octave') + 1) * 12 + STEP_N[txt(t, 'tuning-step')] + (+txt(t, 'tuning-alter') || 0); }); tuning = [arr[6], arr[5], arr[4], arr[3], arr[2], arr[1]]; }
          });
        } else if (tag === 'direction') {
          const rh = el.getElementsByTagName('rehearsal')[0]; if (rh && !m.section) m.section = rh.textContent.trim();
          const snd = kid(el, 'sound'); if (snd && snd.getAttribute('tempo') && mIdx === 0) song.bpm = Math.round(+snd.getAttribute('tempo'));
          const pm = el.getElementsByTagName('per-minute')[0]; if (pm && mIdx === 0 && !(snd && snd.getAttribute('tempo'))) song.bpm = Math.round(parseFloat(pm.textContent)) || song.bpm;
        } else if (tag === 'sound' && el.getAttribute('tempo') && mIdx === 0) song.bpm = Math.round(+el.getAttribute('tempo'));
        else if (tag === 'print' && el.getAttribute('new-system') === 'yes' && mIdx > 0) m.brk = true;
        else if (tag === 'note') {
          const st = kid(el, 'staff'); if (useStaff && st && st.textContent.trim() !== useStaff) return;
          const v = txt(el, 'voice') || '1'; if (voice === null) voice = v; if (v !== voice) return;
          const isChord = !!kid(el, 'chord'), isGrace = !!kid(el, 'grace'), rest = kid(el, 'rest');
          let beat;
          if (rest && rest.getAttribute('measure') === 'yes' && !isChord) { lastBeat = null; return; } // 마디 전체 쉼표 = 빈 마디
          if (isChord && lastBeat) beat = lastBeat;
          else {
            beat = newBeat(8);
            const type = txt(el, 'type'); const dots = kids(el, 'dot').length; const tmod = kid(el, 'time-modification');
            const dur = +txt(el, 'duration') || 0; const ticks = Math.round(dur * 480 / divisions);
            if (isGrace) { beat.grace = true; beat.dur = TYPE_R[type] || 8; }
            else if (!setBeatTicks(beat, ticks)) {
              beat.dur = TYPE_R[type] || 8; beat.dot = dots >= 2 ? 2 : dots > 0; beat.trip = !!tmod && txt(tmod, 'actual-notes') === '3';
            }
            beat.dm = true;
            m.beats.push(beat); lastBeat = beat;
          }
          if (rest) return;
          const tech = el.getElementsByTagName('technical')[0];
          const sEl = tech && kid(tech, 'string'), fEl = tech && kid(tech, 'fret');
          const p = kid(el, 'pitch');
          const midi = p ? (+txt(p, 'octave') + 1) * 12 + STEP_N[txt(p, 'step')] + (+txt(p, 'alter') || 0) : null;
          const n = newNote(sEl ? +sEl.textContent - 1 : -1, fEl ? +fEl.textContent : 0);
          n._midi = midi;
          const nh = txt(el, 'notehead'); const nhEl = kid(el, 'notehead');
          if (nh === 'x') n.dead = true; else if (nhEl && nhEl.getAttribute('parentheses') === 'yes') n.ghost = true;
          if (kids(el, 'tie').some(t => t.getAttribute('type') === 'stop') || Array.from(el.getElementsByTagName('tied')).some(t => t.getAttribute('type') === 'stop')) n.tie = true;
          const nots = kid(el, 'notations');
          if (nots) {
            if (Array.from(nots.getElementsByTagName('slide')).concat(Array.from(nots.getElementsByTagName('glissando'))).some(s => s.getAttribute('type') === 'start')) n.slide = 'to';
            if (tech) {
              if (Array.from(tech.children).some(c => (c.localName === 'hammer-on' || c.localName === 'pull-off') && c.getAttribute('type') === 'start')) n.hp = true;
              const bd = kid(tech, 'bend'); if (bd) { const a = Math.abs(parseFloat(txt(bd, 'bend-alter')) || 2) / 2; n.bend = { a: [0.5, 1, 1.5, 2].reduce((p2, c) => Math.abs(c - a) < Math.abs(p2 - a) ? c : p2, 1) }; if (kid(bd, 'release')) n.bend.r = true; }
              if (kid(tech, 'harmonic')) n.harm = true;
              const fg = txt(tech, 'fingering'); if (/^[1-4]$/.test(fg)) n.fm = +fg; else if (/^(T|p|0)$/i.test(fg)) n.fm = 'T';
              kids(tech, 'other-technical').forEach(ot => { const t = ot.textContent.trim().toLowerCase(); if (/palm/.test(t) || t === 'p.m.') n.pm = true; if (/let ring/.test(t)) n.lr = true; if (t === 'slide in') n.slide = 'in'; if (t === 'slide out') n.slide = 'out'; });
              if (kid(tech, 'down-bow')) beat.pick = 'd'; if (kid(tech, 'up-bow')) beat.pick = 'u';
              if (kid(tech, 'palm-mute')) n.pm = true;
            }
            if (nots.getElementsByTagName('wavy-line').length || nots.getElementsByTagName('vibrato').length) n.vib = true;
            if (nots.getElementsByTagName('accent').length || nots.getElementsByTagName('strong-accent').length) n.acc = true;
          }
          beat.notes.push(n); allNotes.push({ n, beat });
        }
      });
      if (mTs && song.measures.length) m.ts = mTs;
      song.measures.push(m);
    });
    if (!song.measures.length) throw new Error('NO_MEASURE');
    song.ts = ts || [4, 4];
    if (song.measures[0].ts) song.measures[0].ts = null;
    // 못갖춘마디: 첫 마디만 짧고 둘째 마디부터 진짜 박자인 경우
    if (song.measures[1] && song.measures[1].ts) { song.measures[0].ts = song.ts; song.ts = song.measures[1].ts; song.measures[1].ts = null; }
    // 튜닝
    if (tuning && tuning.every(v => isFinite(v))) {
      const key = Object.keys(TUNINGS).find(k => TUNINGS[k].midi.every((v, i) => v === tuning[i]));
      if (key) song.tuning = key;
    }
    const tun = TUNINGS[song.tuning].midi;
    // 줄/프렛이 없는 음(일반 오선보만 있는 파일): 음높이로 가장 편한 줄을 고름
    let hand = 3;
    song.measures.forEach(m => m.beats.forEach(b => {
      const need = b.notes.filter(n => n.s < 0 || n.s > 5);
      if (!need.length) { b.notes.forEach(n => { if (n.f > 0) hand = n.f; delete n._midi; }); return; }
      const used = new Set(b.notes.filter(n => n.s >= 0 && n.s <= 5).map(n => n.s));
      need.sort((a, c) => (c._midi || 0) - (a._midi || 0)).forEach(n => {
        let best = null;
        for (let s = 0; s < 6; s++) { if (used.has(s) || n._midi == null) continue; const f = n._midi - tun[s]; if (f < 0 || f > 24) continue; const c = Math.abs(f - hand) + (f === 0 ? -0.5 : 0) + (f > 12 ? 2 : 0); if (!best || c < best.c) best = { s, f, c }; }
        if (!best) { best = { s: 5, f: Math.max(0, (n._midi || tun[5]) - tun[5]) }; }
        n.s = best.s; n.f = best.f; used.add(best.s);
      });
      b.notes = b.notes.filter((n, i, arr) => arr.findIndex(o => o.s === n.s) === i);
      b.notes.forEach(n => { delete n._midi; if (n.f > 0) hand = n.f; });
    }));
    // 마지막 빈 마디 정리 + 박자 안 맞는 마디 확인
    song.measures.forEach((m, mi) => { if (m.beats.length && measureFill(m) !== measureCapacity(measureTs(song, mi))) m.check = true; });
    if (song.measures.length < 4) while (song.measures.length < 4) song.measures.push(newMeasure());
    return song;
  }

  // ---------- 압축 MusicXML (.mxl = zip) ----------
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('NO_UNZIP');
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function unzipText(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('ZIP_BAD');
    const cnt = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let i = 0; i < cnt; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loff = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, loff };
      p += 46 + nlen + elen + clen;
    }
    const read = async name => {
      const f = files[name]; if (!f) return null;
      const l = f.loff; const start = l + 30 + dv.getUint16(l + 26, true) + dv.getUint16(l + 28, true);
      const data = u8.subarray(start, start + f.csize);
      const raw = f.method === 0 ? data : await inflateRaw(data);
      return dec.decode(raw);
    };
    let rootPath = null;
    const cont = await read('META-INF/container.xml');
    if (cont) { const m = cont.match(/full-path="([^"]+)"/); if (m) rootPath = m[1]; }
    if (!rootPath) rootPath = Object.keys(files).find(n => !n.startsWith('META-INF') && /\.(musicxml|xml)$/i.test(n));
    if (!rootPath) throw new Error('ZIP_NO_XML');
    return read(rootPath);
  }

  async function importFile(name, buf) {
    const u8 = new Uint8Array(buf);
    if (u8[0] === 0x50 && u8[1] === 0x4b) return importXml(await unzipText(buf)); // PK.. = zip(.mxl)
    let text = new TextDecoder('utf-8').decode(u8);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (/^\s*\{/.test(text)) return { json: JSON.parse(text) };
    if (/<\?xml|<score-partwise|<score-timewise/.test(text.slice(0, 2000))) {
      if (/UTF-16/i.test(text.slice(0, 200)) || text.indexOf('\u0000') >= 0) text = new TextDecoder('utf-16').decode(u8);
      return importXml(text);
    }
    throw new Error('UNKNOWN_FORMAT');
  }

  return { exportSong, importXml, importFile };
})();

if (typeof module !== 'undefined') module.exports = MusicXML;
