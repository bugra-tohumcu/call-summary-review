/* Call summary review: manual review with cited evidence, suggested sentence-to-transcript matching
   (word/number overlap, no AI), impact-weighted priority score, status filter, search, sort and editing. */
(function () {
  'use strict';

  const STORAGE_KEY = 'callSummaryReview.v1';

  const FINDING_TYPES = {
    contradicted: {
      label: 'Contradicted', defaultImpact: 'high',
      help: 'The summary states something the transcript contradicts (e.g. wrong amount, date, call direction or outcome).'
    },
    unsupported: {
      label: 'Not supported', defaultImpact: 'high',
      help: 'The summary states something the transcript does not support. Cite the turns that show what actually happened, if any.'
    },
    omitted: {
      label: 'Required but omitted', defaultImpact: 'medium',
      help: 'Discussed in the call AND required by the rules, but missing from the summary. A topic that was never discussed is correctly left out.'
    },
    rule: {
      label: 'Rule breach', defaultImpact: 'medium',
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
    call.summaryLower = (c.summary || '').toLowerCase();
    call.transcriptLower = call.turns.map((t) => t.text).join('\n').toLowerCase();
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
  let searchQuery = '';
  let editingId = null;

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
      p.band === 'none' ? 'Priority: no findings' : `Priority
