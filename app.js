/* Call summary review, layer 1: manual review with cited evidence. No automated analysis. */
(function () {
  'use strict';

  const STORAGE_KEY = 'callSummaryReview.v1';

  const FINDING_TYPES = {
    contradicted: {
      label: 'Contradicted',
      help: 'The summary states something the transcript contradicts (e.g. wrong amount, date, call direction or outcome).'
    },
    unsupported: {
      label: 'Not supported',
      help: 'The summary states something the transcript does not support. Cite the turns that show what actually happened, if any.'
    },
    omitted: {
      label: 'Required but omitted',
      help: 'Discussed in the call AND required by the rules, but missing from the summary. A topic that was never discussed is correctly left out.'
    },
    rule: {
      label: 'Rule breach',
      help: 'The fact may be correct, but the summary breaks a rule (e.g. arrears or payment amount, names, entity names, required wording).'
    }
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

  /* ---------- Data ---------- */

  const rawCalls = Array.isArray(window.CALLS) ? window.CALLS : null;
  const calls = rawCalls
    ? rawCalls.map(prepareCall).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    : [];
  const callById = new Map(calls.map((c) => [c.id, c]));

  function prepareCall(c) {
    return {
      id: String(c.id),
      date: c.call_date || '',
      duration: c.estimated_duration || '',
      turns: parseTranscript(c.transcript || ''),
      sentences: splitSentences(c.summary || '')
    };
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

  /* ---------- Small helpers ---------- */

  function statusBadge(id) {
    const key = statusOf(id);
    const s = STATUS[key];
    return el('span', { class: 'status status-' + key },
      el('span', { 'aria-hidden': 'true', text: s.icon }), s.label);
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
    $('#callList').replaceChildren(...calls.map((c) => {
      const n = (reviews[c.id] && reviews[c.id].findings ? reviews[c.id].findings.length : 0);
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
          n ? el('span', { class: 'call-count', text: plural(n, 'finding') }) : null));
    }));
    const done = calls.filter((c) => statusOf(c.id) === 'accurate' || statusOf(c.id) === 'needs_correction').length;
    const needs = calls.filter((c) => statusOf(c.id) === 'needs_correction').length;
    $('#progress').textContent = `${done} of ${calls.length} reviewed · ${needs} need correction`;
  }

  /* ---------- Call view ---------- */

  function selectCall(id) {
    if (!callById.has(id)) return;
    currentId = id;
    draftTurns = [];
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
        el('span', { id: 'headStatus' })),
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
      el('p', { class: 'hint', text: 'Click a sentence number to attach a new finding to that sentence.' }),
      el('ol', { class: 'summary', id: 'summaryList' }),
      el('p', { class: 'whole-count', id: 'wholeCount' }));

    const findingsCard = el('section', { class: 'card' },
      el('h3', null, 'Findings ', el('span', { id: 'findingsCount', class: 'count' })),
      el('div', { id: 'findingsList' }));

    const left = el('div', { class: 'pane pane-left' },
      rules, summaryCard, findingsCard, buildForm(call), buildVerdict());

    const right = el('div', { class: 'pane pane-right' },
      el('h3', { class: 'pane-title' }, 'Transcript'),
      el('p', { class: 'hint', text: 'Click a turn ID to cite it as evidence in a new finding.' }),
      buildTranscript(call));

    $('#main').replaceChildren(head, el('div', { class: 'panes' }, left, right));

    renderHeadStatus();
    renderSummary();
    renderFindings();
    renderDraftTurns();
    renderVerdictWarning();
  }

  function renderHeadStatus() {
    const h = $('#headStatus');
    if (h) h.replaceChildren(statusBadge(currentId));
  }

  function renderSummary() {
    const call = callById.get(currentId);
    const findings = getReview(currentId).findings;
    const counts = {};
    findings.forEach((f) => { counts[f.sentence] = (counts[f.sentence] || 0) + 1; });

    $('#summaryList').replaceChildren(...call.sentences.map((s) => {
      const n = counts[s.id] || 0;
      return el('li', { class: 'sentence' + (n ? ' has-findings' : '') },
        el('button', {
          type: 'button',
          class: 'sid',
          title: 'Add a finding about ' + s.id,
          onclick: () => pickSentence(s.id)
        }, s.id),
        el('span', { class: 'stext', text: s.text }),
        n ? el('span', { class: 'finding-flag', text: '⚑ ' + plural(n, 'finding') }) : null);
    }));

    const whole = counts.whole || 0;
    const wc = $('#wholeCount');
    wc.textContent = whole ? `⚑ ${plural(whole, 'finding')} about the whole summary (e.g. omissions)` : '';
    wc.hidden = !whole;
  }

  function pickSentence(id) {
    $('#fSentence').value = id;
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
          el('span', { class: 'mark mark-selected', text: 'Selected' }),
          el('span', { class: 'mark mark-cited', text: 'Cited in a finding' })),
        el('p', { class: 'turn-text', text: t.text }))));
  }

  function toggleDraftTurn(id) {
    draftTurns = draftTurns.includes(id) ? draftTurns.filter((t) => t !== id) : [...draftTurns, id];
    renderDraftTurns();
  }

  function renderTranscriptMarks() {
    const cited = new Set(getReview(currentId).findings.flatMap((f) => f.turns || []));
    document.querySelectorAll('#transcript .turn').forEach((li) => {
      const id = li.dataset.turn;
      const selected = draftTurns.includes(id);
      li.classList.toggle('is-cited', cited.has(id));
      li.classList.toggle('is-selected', selected);
      li.querySelector('.turn-id').setAttribute('aria-pressed', String(selected));
    });
  }

  function jumpToTurn(id) {
    const li = document.getElementById('turn-' + id);
    if (!li) return;
    li.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      Object.entries(FINDING_TYPES).map(([k, v]) => el('option', { value: k }, v.label)));
    typeSel.addEventListener('change', () => {
      const t = FINDING_TYPES[typeSel.value];
      typeHelp.textContent = t ? t.help : defaultHelp;
    });

    return el('form', { class: 'card finding-form', id: 'findingForm', novalidate: true, onsubmit: saveFinding },
      el('h3', null, 'Add a finding'),
      field('fSentence', 'Which part of the summary?',
        el('select', { id: 'fSentence' },
          el('option', { value: '' }, 'Choose…'),
          call.sentences.map((s) => el('option', { value: s.id }, `${s.id}: ${truncate(s.text, 70)}`)),
          el('option', { value: 'whole' }, 'Whole summary (e.g. required information missing)'))),
      field('fType', 'Type of issue', typeSel, typeHelp),
      el('fieldset', { class: 'field' },
        el('legend', null, 'How sure are you?'),
        radio('fCertainty', 'definite', 'Definite: the transcript clearly shows it', true),
        radio('fCertainty', 'uncertain', 'Uncertain: needs a second look', false)),
      el('div', { class: 'field' },
        el('span', { class: 'label' }, 'Evidence (transcript turns)'),
        el('div', { id: 'draftTurns', class: 'chips', 'aria-live': 'polite' })),
      field('fNote', 'Note',
        el('textarea', { id: 'fNote', rows: '3', placeholder: 'What is wrong, and what does the transcript actually say?' })),
      el('p', { id: 'formError', class: 'form-error', role: 'alert' }),
      el('div', { class: 'form-actions' },
        el('button', { type: 'submit', class: 'primary' }, 'Save finding'),
        el('button', { type: 'button', onclick: clearForm }, 'Clear')));
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
    draftTurns = [];
    renderDraftTurns();
  }

  function saveFinding(e) {
    e.preventDefault();
    const form = $('#findingForm');
    const sentence = $('#fSentence').value;
    const type = $('#fType').value;
    const checked = form.querySelector('input[name="fCertainty"]:checked');
    const certainty = checked ? checked.value : 'definite';
    const note = $('#fNote').value.trim();

    const missing = [];
    if (!sentence) missing.push('which part of the summary');
    if (!type) missing.push('the type of issue');
    if (!note) missing.push('a short note');
    if (missing.length) {
      $('#formError').textContent = 'Please add ' + missing.join(', ') + '.';
      return;
    }

    const r = getReview(currentId);
    r.findings.push({
      id: 'F' + Date.now().toString(36),
      sentence,
      type,
      certainty,
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
    const r = getReview(currentId);
    $('#findingsCount').textContent = `(${r.findings.length})`;
    const wrap = $('#findingsList');

    if (!r.findings.length) {
      wrap.replaceChildren(el('p', { class: 'muted', text: 'No findings recorded yet. If the summary is accurate, record that in the verdict below.' }));
      return;
    }

    const order = (s) => (s === 'whole' ? 9999 : parseInt(s.slice(1), 10));
    const list = [...r.findings].sort((a, b) => order(a.sentence) - order(b.sentence) || a.createdAt.localeCompare(b.createdAt));

    wrap.replaceChildren(el('ul', { class: 'findings' }, list.map((f) => {
      const sentence = call.sentences.find((s) => s.id === f.sentence);
      const cert = CERTAINTY[f.certainty] || CERTAINTY.definite;
      const type = FINDING_TYPES[f.type] || { label: f.type };
      return el('li', { class: 'finding finding-' + f.certainty },
        el('div', { class: 'finding-head' },
          el('span', { class: 'tag tag-' + f.certainty }, el('span', { 'aria-hidden': 'true', text: cert.icon }), ' ' + cert.label),
          el('span', { class: 'tag', text: type.label }),
          el('span', { class: 'finding-where', text: f.sentence === 'whole' ? 'Whole summary' : f.sentence }),
          el('button', { type: 'button', class: 'link danger', onclick: () => deleteFinding(f.id) }, 'Delete')),
        sentence ? el('blockquote', { class: 'finding-quote', text: sentence.text }) : null,
        el('p', { class: 'finding-note', text: f.note }),
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
      tool: 'Call summary review v1',
      reviews: calls.map((c) => {
        const r = reviews[c.id] || {};
        return {
          callId: c.id,
          status: STATUS[statusOf(c.id)].label,
          verdict: r.verdict || null,
          comment: r.comment || '',
          findings: (r.findings || []).map((f) => ({
            sentence: f.sentence,
            sentenceText: f.sentence === 'whole' ? null : ((c.sentences.find((s) => s.id === f.sentence) || {}).text || null),
            type: (FINDING_TYPES[f.type] || { label: f.type }).label,
            certainty: (CERTAINTY[f.certainty] || { label: f.certainty }).label,
            evidence: (f.turns || []).map((t) => `${c.id} ${t}`),
            note: f.note,
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
