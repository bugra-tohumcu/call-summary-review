/* Call summary review: manual review with cited evidence, suggested sentence-to-transcript matching
   (word/number overlap, no AI), impact-weighted priority score, status filter and sort. */
(function () {
  'use strict';

  const STORAGE_KEY = 'callSummaryReview.v1';

  const FINDING_TYPES = {
    contradicted: {
      label: 'Contradicted', icon: '✕', defaultImpact: 'high',
      help: 'The summary states something the transcript contradicts (e.g. wrong amount, date, call direction or outcome).'
    },
    unsupported: {
      label: 'Not supported', icon: '?', defaultImpact: 'high',
      help: 'The summary states something the transcript does not support. Cite the turns that show what actually happened, if any.'
    },
    omitted: {
      label: 'Required but omitted', icon: '∅', defaultImpact: 'medium',
      help: 'Discussed in the call AND required by the rules, but missing from the summary. A topic that was never discussed is correctly left out.'
    },
    rule: {
      label: 'Rule breach', icon: '§', defaultImpact: 'medium',
      help: 'The fact may be correct, but the summary breaks a rule (e.g. arrears or payment amount, names, entity names, required wording).'
    }
  };

  const IMPACT = {
    high: { label: 'High', points: 40, help: 'could mislead the next contact or create a compliance problem' },
    medium: { label: 'Medium', points: 20, help: 'required information missing, unlikely to cause a wrong action' },
    low: { label: 'Low', points: 5, help: 'wording or style only' }
  };

  const CERTAINTY = {
    definite: { icon: '●', label: 'Definite' },
    uncertain: { icon: '◌', label: 'Uncertain' }
  };

  const STATUS = {
    not_reviewed: { icon: '○', label: 'Not reviewed' },
    in_progress: { icon: '◐', label: 'In progress' },
    accurate: { icon: '✓', label: 'Accurate' },
    needs_correction: { icon: '✕', label: 'Needs correction' }
  };

  const BANDS = {
    none: { icon: '–', label: 'No findings' },
    low: { icon: '▽', label: 'Low' },
    medium: { icon: '◆', label: 'Medium' },
    high: { icon: '▲', label: 'High' }
  };

  const PRIORITY_EXPLAINER = 'Priority score: High 40, Medium 20, Low 5 points per finding; uncertain findings count half; capped at 100. Bands: High 50+, Medium 20 to 49, Low under 20.';

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  /* ---------- Text matching (word and number overlap, no AI) ---------- */

  const NUM_UNITS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
    eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
    eighteenth: 18, nineteenth: 19
  };
  const NUM_TENS = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    twentieth: 20, thirtieth: 30
  };
  const isNumWord = (w) => w in NUM_UNITS || w in NUM_TENS;

  const STOPWORDS = new Set((
    'the and for that this with was were are you your they them their there then than have has had not but from into ' +
    'onto its our out can could would should will just what when where which who how why all any some been being also ' +
    'about after before over under more most very really yes yeah okay right thanks thank thats dont ive its im youre ' +
    'theres isnt doesnt didnt wont cant she her him his hers she\'s there\'s did does get got going want well now today ' +
    'customer company agent call called calls calling next steps step pound pounds because while still only one off ' +
    'per each been through who\'s whose whether those these such may might need needs needed made make let lets ' +
    'customers companys agents'
  ).split(/\s+/));

  function rawWords(text) {
    return text
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/(\d),(\d)/g, '$1$2')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  // Turns spoken numbers ("two hundred and thirty", "twenty-third") into digits so they match "£230" / "23 October".
  function convertNumbers(words) {
    const out = [];
    let cur = null;
    const flush = () => { if (cur !== null) { out.push(String(cur)); cur = null; } };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const next = words[i + 1];
      if (isNumWord(w)) {
        const v = w in NUM_UNITS ? NUM_UNITS[w] : NUM_TENS[w];
        if (cur !== null && cur % 100 !== 0 && (v >= 10 || cur % 10 !== 0)) flush();
        cur = (cur || 0) + v;
      } else if (w === 'hundred' || w === 'thousand') {
        cur = (cur || 1) * (w === 'hundred' ? 100 : 1000);
      } else if (w === 'a' && (next === 'hundred' || next === 'thousand')) {
        flush();
        cur = 1;
      } else if (w === 'and' && cur !== null && next && isNumWord(next)) {
        // "two hundred AND thirty": keep building the number
      } else {
        flush();
        out.push(w);
      }
    }
    flush();
    return out;
  }

  function tokensOf(text) {
    const seen = new Set();
    const tokens = [];
    for (const w of convertNumbers(rawWords(text))) {
      const isNum = /^\d+$/.test(w);
      if (!isNum && (w.length < 3 || STOPWORDS.has(w))) continue;
      const stem = isNum ? w : (w.length > 5 ? w.slice(0, 5) : w);
      if (seen.has(stem)) continue;
      seen.add(stem);
      tokens.push({ stem, word: w, isNum });
    }
    return tokens;
  }

  function prepareMatching(call) {
    const df = new Map();
    call.turns.forEach((t) => {
      t.stems = new Set(tokensOf(t.text).map((k) => k.stem));
      t.stems.forEach((s) => df.set(s, (df.get(s) || 0) + 1));
    });
    call.df = df;
  }

  function matchSentence(call, sentence) {
    const N = call.turns.length || 1;
    const weight = (k) => Math.log(1 + N / (call.df.get(k.stem) || N)) * (k.isNum ? 2 : 1);
    const sTokens = tokensOf(sentence.text);
    const scored = call.turns
      .filter((t) => t.kind !== 'unclear')
      .map((t) => {
        const shared = sTokens.filter((k) => t.stems.has(k.stem));
        return { turn: t, shared, score: shared.reduce((a, k) => a + weight(k), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    const MIN_SCORE = 3;
    const matches = scored.filter((x) => x.score >= MIN_SCORE && x.score >= best * 0.5).slice(0, 3);
    // Every amount, date or count in the sentence also brings in the best turn that contains it,
    // so a figure is always shown next to where it was said (e.g. a figure the customer later retracted).
    sTokens.filter((k) => k.isNum).forEach((k) => {
      const hit = scored.find((x) => x.shared.includes(k));
      if (hit && !matches.includes(hit) && matches.length < 5) matches.push(hit);
    });
    matches.sort((a, b) => parseInt(a.turn.id.slice(1), 10) - parseInt(b.turn.id.slice(1), 10));
    const unfound = sTokens.filter((k) => !call.df.has(k.stem)).map((k) => k.word);
    const bestId = matches.length ? [...matches].sort((a, b) => b.score - a.score)[0].turn.id : null;
    return { matches, unfound, bestId };
  }

  /* ---------- Data ---------- */

  const rawCalls = Array.isArray(window.CALLS) ? window.CALLS : null;
  const calls = rawCalls
    ? rawCalls.map(prepareCall).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    : [];
  const callById = new Map(calls.map((c) => [c.id, c]));

  function prepareCall(c) {
    const call = {
      id: String(c.id),
      date: c.call_date || '',
      duration: c.estimated_duration || '',
      turns: parseTranscript(c.transcript || ''),
      sentences: splitSentences(c.summary || '')
    };
    prepareMatching(call);
    return call;
  }

  function parseTranscript(text) {
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line, i) => {
        const m = line.match(/^(T\d+)\s+\[(\d{1,2}:\d{2})\]\s+([^:]+):\s*(.*)$/);
        if (!m) return { id: 'L' + (i + 1), time: '', speaker: 'Unparsed line', text: line, kind: 'note' };
        const speaker = m[3].trim();
        const s = speaker.toLowerCase();
        let kind = 'third';
        if (s === 'agent') kind = 'agent';
        else if (s === 'customer') kind = 'customer';
        else if (s.includes('transcript note')) kind = 'note';
        else if (s.includes('unclear')) kind = 'unclear';
        return { id: m[1], time: m[2], speaker, text: m[4], kind };
      });
  }

  function splitSentences(text) {
    return text
      .trim()
      .split(/(?<=[.!?])\s+(?=[A-Z“"'(])/)
      .filter(Boolean)
      .map((t, i) => ({ id: 'S' + (i + 1), text: t }));
  }

  /* ---------- State and storage ---------- */

  let reviews = loadReviews();
  let storageOk = true;
  let currentId = null;
  let draftTurns = [];
  let rulesOpen = false;
  let commentTimer = null;
  let activeSentence = null;
  let matchIds = [];
  let matchBestId = null;
  let impactTouched = false;
  let listFilter = 'all';
  let listSort = 'id';

  function loadReviews() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' ? data : {};
    } catch (e) {
      return {};
    }
  }

  function saveReviews() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews));
      storageOk = true;
    } catch (e) {
      storageOk = false;
    }
    renderSaveState();
  }

  function getReview(id) {
    if (!reviews[id]) reviews[id] = { findings: [], verdict: null, comment: '', updatedAt: null };
    if (!Array.isArray(reviews[id].findings)) reviews[id].findings = [];
    return reviews[id];
  }

  function findingsOf(id) {
    return (reviews[id] && Array.isArray(reviews[id].findings)) ? reviews[id].findings : [];
  }

  function touch(r) {
    r.updatedAt = new Date().toISOString();
  }

  function statusOf(id) {
    const r = reviews[id];
    if (!r) return 'not_reviewed';
    if (r.verdict && STATUS[r.verdict]) return r.verdict;
    if ((r.findings && r.findings.length) || (r.comment && r.comment.trim())) return 'in_progress';
    return 'not_reviewed';
  }

  /* ---------- Priority ---------- */

  function impactOf(f) {
    if (IMPACT[f.impact]) return f.impact;
    return (FINDING_TYPES[f.type] && FINDING_TYPES[f.type].defaultImpact) || 'medium';
  }

  function findingPoints(f) {
    return IMPACT[impactOf(f)].points * (f.certainty === 'uncertain' ? 0.5 : 1);
  }

  function priorityOf(id) {
    const fs = findingsOf(id);
    const score = Math.min(100, Math.round(fs.reduce((a, f) => a + findingPoints(f), 0)));
    const band = !fs.length ? 'none' : score >= 50 ? 'high' : score >= 20 ? 'medium' : 'low';
    return { score, band };
  }

  function priorityBadge(id) {
    const p = priorityOf(id);
    const b = BANDS[p.band];
    return el('span', { class: 'priority priority-' + p.band, title: PRIORITY_EXPLAINER },
      el('span', { 'aria-hidden': 'true', text: b.icon }),
      p.band === 'none' ? 'Priority: no findings' : `Priority ${p.score}/100 · ${b.label}`);
  }

  /* ---------- Small helpers ---------- */

  function statusBadge(id) {
    const key = statusOf(id);
    const s = STATUS[key];
    return el('span', { class: 'status status-' + key },
      el('span', { 'aria-hidden': 'true', text: s.icon }), s.label);
  }

  function typeTag(type) {
    const t = FINDING_TYPES[type] || { label: type, icon: '•' };
    return el('span', { class: 'tag type-tag type-' + type },
      el('span', { 'aria-hidden': 'true', text: t.icon }), ' ' + t.label);
  }

  function sortTurns(ids) {
    return [...ids].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  }

  function truncate(text, n) {
    return text.length > n ? text.slice(0, n - 1).trimEnd() + '…' : text;
  }

  function formatDate(iso) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function field(id, label, ...controls) {
    return el('div', { class: 'field' }, el('label', { for: id }, label), ...controls);
  }

  function radio(name, value, label, checked) {
    const id = name + '-' + value;
    return el('div', { class: 'radio' },
      el('input', { type: 'radio', name, id, value, checked }),
      el('label', { for: id }, label));
  }

  /* ---------- Top bar and list ---------- */

  function renderSaveState() {
    const s = $('#saveState');
    if (!s) return;
    s.textContent = storageOk
      ? 'Saved in this browser'
      : '⚠ Not saved: browser storage unavailable. Export to keep your work.';
    s.classList.toggle('is-error', !storageOk);
  }

  function renderList() {
    const counts = { all: calls.length };
    Object.keys(STATUS).forEach((k) => { counts[k] = 0; });
    calls.forEach((c) => { counts[statusOf(c.id)]++; });

    const filters = [['all', null, 'All']].concat(Object.entries(STATUS).map(([k, s]) => [k, s.icon, s.label]));
    $('#filterBar').replaceChildren(...filters.map(([k, icon, label]) =>
      el('button', {
        type: 'button',
        class: 'filter-btn' + (listFilter === k ? ' is-active' : ''),
        'aria-pressed': String(listFilter === k),
        onclick: () => { listFilter = k; renderList(); }
      }, icon ? el('span', { 'aria-hidden': 'true', text: icon + ' ' }) : null, `${label} (${counts[k]})`)));

    let shown = calls.filter((c) => listFilter === 'all' || statusOf(c.id) === listFilter);
    if (listSort === 'priority') {
      shown = [...shown].sort((a, b) => priorityOf(b.id).score - priorityOf(a.id).score
        || a.id.localeCompare(b.id, 'en', { numeric: true }));
    }

    if (!shown.length) {
      $('#callList').replaceChildren(el('li', { class: 'list-empty muted', text: 'No calls with this status.' }));
    } else {
      $('#callList').replaceChildren(...shown.map((c) => {
        const n = findingsOf(c.id).length;
        const current = c.id === currentId;
        return el('li', null,
          el('button', {
            type: 'button',
            class: 'call-item' + (current ? ' is-current' : ''),
            'aria-current': current ? 'true' : null,
            onclick: () => selectCall(c.id)
          },
            el('span', { class: 'call-id', text: c.id }),
            statusBadge(c.id),
            n ? priorityBadge(c.id) : null,
            n ? el('span', { class: 'call-count', text: plural(n, 'finding') }) : null));
      }));
    }

    const done = counts.accurate + counts.needs_correction;
    $('#progress').textContent = `${done} of ${calls.length} reviewed · ${counts.needs_correction} need correction`;
  }

  /* ---------- Call view ---------- */

  function selectCall(id) {
    if (!callById.has(id)) return;
    currentId = id;
    draftTurns = [];
    activeSentence = null;
    matchIds = [];
    impactTouched = false;
    if (decodeURIComponent(location.hash.slice(1)) !== id) history.replaceState(null, '', '#' + id);
    renderList();
    renderCall();
  }

  function renderCall() {
    const call = callById.get(currentId);
    const idx = calls.indexOf(call);
    const prev = calls[idx - 1];
    const next = calls[idx + 1];

    const head = el('section', { class: 'call-head' },
      el('div', { class: 'call-title' },
        el('h2', { text: call.id }),
        el('span', { class: 'call-meta', text: `Call date ${formatDate(call.date)} · Est. duration ${call.duration}` }),
        el('span', { id: 'headStatus', class: 'head-badges' })),
      el('div', { class: 'call-nav' },
        el('button', { type: 'button', disabled: !prev, onclick: () => prev && selectCall(prev.id) }, '← Previous'),
        el('button', { type: 'button', disabled: !next, onclick: () => next && selectCall(next.id) }, 'Next →')));

    const rulesText = typeof window.SUMMARY_RULES === 'string' && window.SUMMARY_RULES.trim()
      ? window.SUMMARY_RULES.trim()
      : 'Rules text not loaded. Check data.js.';
    const rules = el('details', { class: 'card rules', open: rulesOpen },
      el('summary', null, 'Summary rules (reference)'),
      el('pre', { class: 'rules-text', text: rulesText }));
    rules.addEventListener('toggle', () => { rulesOpen = rules.open; });

    const summaryCard = el('section', { class: 'card' },
      el('h3', null, 'Summary under review'),
      el('p', { class: 'hint', text: 'Click a sentence to see suggested matching turns. Click its number to attach a new finding to it.' }),
      el('ol', { class: 'summary', id: 'summaryList' }),
      el('p', { class: 'whole-count', id: 'wholeCount' }));

    const findingsCard = el('section', { class: 'card' },
      el('h3', null, 'Findings ', el('span', { id: 'findingsCount', class: 'count' })),
      el('p', { class: 'hint', id: 'priorityLine' }),
      el('div', { id: 'findingsList' }));

    const left = el('div', { class: 'pane pane-left' },
      rules, summaryCard, findingsCard, buildForm(call), buildVerdict());

    const right = el('div', { class: 'pane pane-right', id: 'paneRight' },
      el('h3', { class: 'pane-title' }, 'Transcript'),
      el('p', { class: 'hint', text: 'Click a turn ID to cite it as evidence in a new finding.' }),
      el('div', { id: 'matchBox', class: 'match-box', 'aria-live': 'polite' }),
      buildTranscript(call));

    $('#main').replaceChildren(head, el('div', { class: 'panes' }, left, right));

    renderHeadStatus();
    renderSummary();
    renderFindings();
    renderMatch();
    renderDraftTurns();
    renderVerdictWarning();
  }

  function renderHeadStatus() {
    const h = $('#headStatus');
    if (h) h.replaceChildren(statusBadge(currentId), priorityBadge(currentId));
  }

  function renderSummary() {
    const call = callById.get(currentId);
    const findings = findingsOf(currentId);
    const bySentence = {};
    findings.forEach((f) => { (bySentence[f.sentence] = bySentence[f.sentence] || []).push(f); });

    $('#summaryList').replaceChildren(...call.sentences.map((s) => {
      const fs = bySentence[s.id] || [];
      const types = [...new Set(fs.map((f) => f.type))];
      const topType = fs.length
        ? [...fs].sort((a, b) => findingPoints(b) - findingPoints(a))[0].type
        : null;
      return el('li', {
        class: 'sentence' + (fs.length ? ' has-findings flag-' + topType : '') + (activeSentence === s.id ? ' is-active' : '')
      },
        el('button', {
          type: 'button',
          class: 'sid',
          title: 'Add a finding about ' + s.id,
          onclick: () => pickSentence(s.id)
        }, s.id),
        el('button', {
          type: 'button',
          class: 'stext',
          'aria-pressed': String(activeSentence === s.id),
          title: 'Show suggested matching turns',
          onclick: () => setActiveSentence(activeSentence === s.id ? null : s.id)
        }, s.text),
        fs.length ? el('span', { class: 'finding-flag' },
          types.map((t) => el('span', { class: 'type-icon type-' + t, 'aria-hidden': 'true', text: FINDING_TYPES[t].icon })),
          ` ${plural(fs.length, 'finding')}: ${types.map((t) => FINDING_TYPES[t].label).join(', ')}`) : null);
    }));

    const whole = bySentence.whole || [];
    const wc = $('#wholeCount');
    if (whole.length) {
      const types = [...new Set(whole.map((f) => f.type))];
      wc.replaceChildren(
        ...types.map((t) => el('span', { class: 'type-icon type-' + t, 'aria-hidden': 'true', text: FINDING_TYPES[t].icon })),
        ` ${plural(whole.length, 'finding')} about the whole summary: ${types.map((t) => FINDING_TYPES[t].label).join(', ')}`);
    } else {
      wc.replaceChildren();
    }
    wc.hidden = !whole.length;
  }

  function pickSentence(id) {
    $('#fSentence').value = id;
    $('#findingForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#fType').focus({ preventScroll: true });
  }

  /* ---------- Suggested matches ---------- */

  function setActiveSentence(id) {
    activeSentence = id;
    renderSummary();
    renderMatch();
    if (matchBestId) jumpToTurn(matchBestId, false);
    else if (id) $('#matchBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderMatch() {
    const box = $('#matchBox');
    const call = callById.get(currentId);
    const s = activeSentence ? call.sentences.find((x) => x.id === activeSentence) : null;

    if (!s) {
      matchIds = [];
      matchBestId = null;
      box.hidden = true;
      box.replaceChildren();
      renderTranscriptMarks();
      return;
    }

    const m = matchSentence(call, s);
    matchIds = m.matches.map((x) => x.turn.id);
    matchBestId = m.bestId;
    box.hidden = false;

    const parts = [
      el('div', { class: 'match-head' },
        el('strong', { text: `Matching ${s.id}` }),
        el('button', { type: 'button', class: 'link', onclick: () => setActiveSentence(null) }, 'Close')),
      el('p', { class: 'match-sentence', text: s.text })
    ];

    if (m.matches.length) {
      parts.push(
        el('p', { class: 'match-label' },
          el('span', { 'aria-hidden': 'true', text: '◇ ' }),
          'Suggested match (shared words/numbers). Read the turn to confirm it supports the claim.'),
        el('ul', { class: 'match-list' }, m.matches.map((x) =>
          el('li', null,
            el('button', { type: 'button', class: 'turn-link', title: 'Show ' + x.turn.id, onclick: () => jumpToTurn(x.turn.id) }, x.turn.id),
            el('span', { class: 'muted', text: ' shares: ' + x.shared.map((k) => k.word).join(', ') })))),
        el('button', { type: 'button', onclick: useMatchAsEvidence }, 'Use as evidence'));
    } else {
      parts.push(el('p', { class: 'match-none' },
        el('span', { 'aria-hidden': 'true', text: '∅ ' }),
        'No matching turns found by word search. Check the transcript manually; this does not mean the claim is wrong.'));
    }

    if (m.unfound.length) {
      parts.push(el('p', { class: 'match-unfound' },
        'Words/numbers in this sentence that appear nowhere in the transcript: ',
        el('strong', { text: m.unfound.join(', ') }),
        '. They may be paraphrased, or unsupported.'));
    }

    box.replaceChildren(...parts);
    renderTranscriptMarks();
  }

  function useMatchAsEvidence() {
    draftTurns = [...new Set([...draftTurns, ...matchIds])];
    if (activeSentence) $('#fSentence').value = activeSentence;
    renderDraftTurns();
    $('#findingForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('#fType').focus({ preventScroll: true });
  }

  /* ---------- Transcript ---------- */

  function buildTranscript(call) {
    if (!call.turns.length) {
      return el('p', { class: 'muted', text: 'This call has no transcript text.' });
    }
    return el('ol', { class: 'transcript', id: 'transcript' }, call.turns.map((t) =>
      el('li', { class: 'turn turn-' + t.kind, id: 'turn-' + t.id, dataset: { turn: t.id } },
        el('div', { class: 'turn-meta' },
          el('button', {
            type: 'button',
            class: 'turn-id',
            'aria-pressed': 'false',
            title: 'Cite ' + t.id + ' as evidence',
            onclick: () => toggleDraftTurn(t.id)
          }, t.id),
          t.time ? el('span', { class: 'turn-time', text: t.time }) : null,
          el('span', { class: 'turn-speaker', text: t.speaker }),
          el('span', { class: 'mark mark-match', text: '◇ Suggested match' }),
          el('span', { class: 'mark mark-selected', text: 'Selected' }),
          el('span', { class: 'mark mark-cited', text: 'Cited in a finding' })),
        el('p', { class: 'turn-text', text: t.text }))));
  }

  function toggleDraftTurn(id) {
    draftTurns = draftTurns.includes(id) ? draftTurns.filter((t) => t !== id) : [...draftTurns, id];
    renderDraftTurns();
  }

  function renderTranscriptMarks() {
    const cited = new Set(findingsOf(currentId).flatMap((f) => f.turns || []));
    document.querySelectorAll('#transcript .turn').forEach((li) => {
      const id = li.dataset.turn;
      const selected = draftTurns.includes(id);
      li.classList.toggle('is-cited', cited.has(id));
      li.classList.toggle('is-selected', selected);
      li.classList.toggle('is-match', matchIds.includes(id));
      li.querySelector('.turn-id').setAttribute('aria-pressed', String(selected));
    });
  }

  function jumpToTurn(id, flash = true) {
    const li = document.getElementById('turn-' + id);
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (!flash) return;
    li.classList.remove('flash');
    void li.offsetWidth;
    li.classList.add('flash');
  }

  /* ---------- Finding form ---------- */

  function buildForm(call) {
    const defaultHelp = 'Choose a type to see what it covers.';
    const typeHelp = el('p', { class: 'hint', id: 'typeHelp', text: defaultHelp });
    const typeSel = el('select', { id: 'fType' },
      el('option', { value: '' }, 'Choose…'),
      Object.entries(FINDING_TYPES).map(([k, v]) => el('option', { value: k }, `${v.icon}  ${v.label}`)));
    typeSel.addEventListener('change', () => {
      const t = FINDING_TYPES[typeSel.value];
      typeHelp.textContent = t ? t.help : defaultHelp;
      if (t && !impactTouched) setImpactRadio(t.defaultImpact);
    });

    const impactField = el('fieldset', { class: 'field' },
      el('legend', null, 'Impact ', el('span', { class: 'legend-note', text: '(suggested from the type; change if needed)' })),
      Object.entries(IMPACT).map(([k, v]) => radio('fImpact', k, `${v.label} (${v.points} pts): ${v.help}`, false)));
    impactField.addEventListener('change', () => { impactTouched = true; });

    return el('form', { class: 'card finding-form', id: 'findingForm', novalidate: true, onsubmit: saveFinding },
      el('h3', null, 'Add a finding'),
      field('fSentence', 'Which part of the summary?',
        el('select', { id: 'fSentence' },
          el('option', { value: '' }, 'Choose…'),
          call.sentences.map((s) => el('option', { value: s.id }, `${s.id}: ${truncate(s.text, 70)}`)),
          el('option', { value: 'whole' }, 'Whole summary (e.g. required information missing)'))),
      field('fType', 'Type of issue', typeSel, typeHelp),
      impactField,
      el('fieldset', { class: 'field' },
        el('legend', null, 'How sure are you?'),
        radio('fCertainty', 'definite', 'Definite: the transcript clearly shows it', true),
        radio('fCertainty', 'uncertain', 'Uncertain: needs a second look (counts half)', false)),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'Evidence (transcript turns)'),
        el('div', { id: 'draftTurns', class: 'chips', 'aria-live': 'polite' })),
      field('fNote', 'Note (optional)',
        el('textarea', { id: 'fNote', rows: '3', placeholder: 'What is wrong, and what does the transcript actually say?' })),
      el('p', { id: 'formError', class: 'form-error', role: 'alert' }),
      el('div', { class: 'form-actions' },
        el('button', { type: 'submit', class: 'primary' }, 'Save finding'),
        el('button', { type: 'button', onclick: clearForm }, 'Clear')));
  }

  function setImpactRadio(value) {
    document.querySelectorAll('input[name="fImpact"]').forEach((i) => { i.checked = i.value === value; });
  }

  function renderDraftTurns() {
    const box = $('#draftTurns');
    if (!draftTurns.length) {
      box.replaceChildren(el('span', { class: 'muted', text: 'None selected. Click turn IDs in the transcript.' }));
    } else {
      box.replaceChildren(...sortTurns(draftTurns).map((id) =>
        el('span', { class: 'chip' }, id,
          el('button', { type: 'button', class: 'chip-x', 'aria-label': 'Remove ' + id, onclick: () => toggleDraftTurn(id) }, '×'))));
    }
    renderTranscriptMarks();
  }

  function clearForm() {
    $('#findingForm').reset();
    $('#typeHelp').textContent = 'Choose a type to see what it covers.';
    $('#formError').textContent = '';
    impactTouched = false;
    draftTurns = [];
    renderDraftTurns();
  }

  function saveFinding(e) {
    e.preventDefault();
    const form = $('#findingForm');
    const sentence = $('#fSentence').value;
    const type = $('#fType').value;
    const certEl = form.querySelector('input[name="fCertainty"]:checked');
    const impactEl = form.querySelector('input[name="fImpact"]:checked');
    const note = $('#fNote').value.trim();

    const missing = [];
    if (!sentence) missing.push('which part of the summary');
    if (!type) missing.push('the type of issue');
    if (missing.length) {
      $('#formError').textContent = 'Please choose ' + missing.join(' and ') + '.';
      return;
    }

    const r = getReview(currentId);
    r.findings.push({
      id: 'F' + Date.now().toString(36),
      sentence,
      type,
      impact: impactEl ? impactEl.value : FINDING_TYPES[type].defaultImpact,
      certainty: certEl ? certEl.value : 'definite',
      turns: sortTurns(draftTurns),
      note,
      source: 'reviewer',
      createdAt: new Date().toISOString()
    });
    touch(r);
    saveReviews();
    clearForm();
    refreshAfterChange();
  }

  function deleteFinding(id) {
    if (!confirm('Delete this finding?')) return;
    const r = getReview(currentId);
    r.findings = r.findings.filter((f) => f.id !== id);
    touch(r);
    saveReviews();
    refreshAfterChange();
  }

  function refreshAfterChange() {
    renderSummary();
    renderFindings();
    renderDraftTurns();
    renderVerdictWarning();
    renderHeadStatus();
    renderList();
  }

  /* ---------- Findings list ---------- */

  function renderFindings() {
    const call = callById.get(currentId);
    const fs = findingsOf(currentId);
    $('#findingsCount').textContent = `(${fs.length})`;
    $('#priorityLine').textContent = PRIORITY_EXPLAINER;
    const wrap = $('#findingsList');

    if (!fs.length) {
      wrap.replaceChildren(el('p', { class: 'muted', text: 'No findings recorded yet. If the summary is accurate, record that in the verdict below.' }));
      return;
    }

    const order = (s) => (s === 'whole' ? 9999 : parseInt(s.slice(1), 10));
    const list = [...fs].sort((a, b) => order(a.sentence) - order(b.sentence) || String(a.createdAt).localeCompare(String(b.createdAt)));

    wrap.replaceChildren(el('ul', { class: 'findings' }, list.map((f) => {
      const sentence = call.sentences.find((s) => s.id === f.sentence);
      const cert = CERTAINTY[f.certainty] || CERTAINTY.definite;
      const impact = IMPACT[impactOf(f)];
      const pts = findingPoints(f);
      return el('li', { class: 'finding type-border-' + f.type + ' cert-' + f.certainty },
        el('div', { class: 'finding-head' },
          typeTag(f.type),
          el('span', { class: 'tag impact-tag impact-' + impactOf(f), text: `Impact: ${impact.label}` }),
          el('span', { class: 'tag tag-' + f.certainty }, el('span', { 'aria-hidden': 'true', text: cert.icon }), ' ' + cert.label),
          el('span', { class: 'finding-where', text: `${f.sentence === 'whole' ? 'Whole summary' : f.sentence} · ${pts} pts` }),
          el('button', { type: 'button', class: 'link danger', onclick: () => deleteFinding(f.id) }, 'Delete')),
        sentence ? el('blockquote', { class: 'finding-quote', text: sentence.text }) : null,
        f.note ? el('p', { class: 'finding-note', text: f.note }) : el('p', { class: 'finding-note muted', text: 'No note' }),
        el('div', { class: 'finding-evidence' },
          el('span', null, 'Evidence:'),
          f.turns && f.turns.length
            ? f.turns.map((t) => el('button', { type: 'button', class: 'turn-link', title: 'Show ' + t + ' in transcript', onclick: () => jumpToTurn(t) }, t))
            : el('span', { class: 'muted', text: 'No transcript turns cited' })));
    })));
  }

  /* ---------- Verdict ---------- */

  function buildVerdict() {
    const r = reviews[currentId] || {};
    const comment = el('textarea', { id: 'vComment', rows: '3', placeholder: 'Optional: anything a colleague should know about this summary.' });
    comment.value = r.comment || '';
    comment.addEventListener('input', () => {
      clearTimeout(commentTimer);
      const id = currentId;
      const value = comment.value;
      commentTimer = setTimeout(() => {
        const rv = getReview(id);
        rv.comment = value;
        touch(rv);
        saveReviews();
        renderList();
        if (id === currentId) renderHeadStatus();
      }, 300);
    });

    const options = [
      ['accurate', '✓ Accurate: no meaningful loss or change of information'],
      ['needs_correction', '✕ Needs correction: could mislead a colleague']
    ];

    return el('section', { class: 'card verdict' },
      el('h3', null, 'Verdict'),
      el('fieldset', { class: 'field' },
        el('legend', null, 'Your decision'),
        options.map(([value, label]) => {
          const id = 'verdict-' + value;
          const input = el('input', { type: 'radio', name: 'verdict', id, value });
          input.checked = r.verdict === value;
          input.addEventListener('change', () => setVerdict(value));
          return el('div', { class: 'radio' }, input, el('label', { for: id }, label));
        })),
      el('p', { id: 'verdictWarning', class: 'verdict-warning', role: 'status' }),
      field('vComment', 'Comment', comment),
      el('button', { type: 'button', class: 'link', onclick: () => setVerdict(null) }, 'Clear verdict'));
  }

  function setVerdict(value) {
    const r = getReview(currentId);
    r.verdict = value;
    touch(r);
    saveReviews();
    document.querySelectorAll('input[name="verdict"]').forEach((i) => { i.checked = i.value === value; });
    renderVerdictWarning();
    renderHeadStatus();
    renderList();
  }

  function renderVerdictWarning() {
    const r = getReview(currentId);
    const definite = r.findings.filter((f) => f.certainty === 'definite').length;
    let msg = '';
    if (r.verdict === 'accurate' && definite) {
      msg = `⚠ Marked Accurate, but ${plural(definite, 'definite finding')} recorded. Check this is intended.`;
    } else if (r.verdict === 'needs_correction' && !r.findings.length) {
      msg = '⚠ Marked Needs correction, but no findings are recorded to show why.';
    } else if (r.verdict === 'needs_correction' && !definite) {
      msg = 'ⓘ Only uncertain findings are recorded for this verdict. Check this is intended.';
    }
    const w = $('#verdictWarning');
    w.textContent = msg;
    w.hidden = !msg;
  }

  /* ---------- Export and reset ---------- */

  function exportJson() {
    const out = {
      exportedAt: new Date().toISOString(),
      tool: 'Call summary review v2',
      priorityFormula: PRIORITY_EXPLAINER,
      reviews: calls.map((c) => {
        const r = reviews[c.id] || {};
        const p = priorityOf(c.id);
        return {
          callId: c.id,
          status: STATUS[statusOf(c.id)].label,
          verdict: r.verdict || null,
          priorityScore: p.score,
          priorityBand: BANDS[p.band].label,
          comment: r.comment || '',
          findings: (r.findings || []).map((f) => ({
            sentence: f.sentence,
            sentenceText: f.sentence === 'whole' ? null : ((c.sentences.find((s) => s.id === f.sentence) || {}).text || null),
            type: (FINDING_TYPES[f.type] || { label: f.type }).label,
            impact: IMPACT[impactOf(f)].label,
            certainty: (CERTAINTY[f.certainty] || { label: f.certainty }).label,
            points: findingPoints(f),
            evidence: (f.turns || []).map((t) => `${c.id} ${t}`),
            note: f.note || '',
            source: f.source || 'reviewer',
            createdAt: f.createdAt
          })),
          updatedAt: r.updatedAt || null
        };
      })
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `call-reviews-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function resetAll() {
    if (!confirm('Delete all review work stored in this browser? Export first if you want to keep it. This cannot be undone.')) return;
    reviews = {};
    saveReviews();
    selectCall(currentId || calls[0].id);
  }

  /* ---------- Init ---------- */

  function init() {
    if (!rawCalls || !calls.length) {
      $('#main').replaceChildren(el('div', { class: 'card load-error' },
        el('h2', null, 'Call data not loaded'),
        el('p', null, 'Check that data.js contains the full contents of candidate-calls.json.')));
      return;
    }
    $('#exportBtn').addEventListener('click', exportJson);
    $('#resetBtn').addEventListener('click', resetAll);
    $('#sortSel').addEventListener('change', (e) => { listSort = e.target.value; renderList(); });
    window.addEventListener('hashchange', () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (id !== currentId && callById.has(id)) selectCall(id);
    });
    renderSaveState();
    const fromHash = decodeURIComponent(location.hash.slice(1));
    selectCall(callById.has(fromHash) ? fromHash : calls[0].id);
  }

  init();
})();
