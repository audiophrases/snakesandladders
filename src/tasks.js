// Lightweight CSV parser (handles quotes/double-quotes)
function parseCSV(text) {
  const rows = [];
  let row = [];
  let i = 0;
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };

  const pushRow = () => {
    // skip completely empty trailing row
    if (row.length === 1 && row[0] === '') return;
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }

    if (c === '\n') {
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    if (c === '\r') {
      // ignore CR
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  pushField();
  pushRow();
  return rows;
}

function norm(s) {
  return (s ?? '').toString().trim();
}

function splitTags(s) {
  return norm(s)
    .split(/[,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export async function fetchTasks(csvUrl) {
  const res = await fetch(csvUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load tasks CSV (${res.status})`);

  // Force UTF-8 decoding (Google "published CSV" sometimes comes without a charset;
  // some browsers will mis-decode and you get cafÃ© instead of café).
  const buf = await res.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = parseCSV(text);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => norm(h).toLowerCase());
  const col = (name) => headers.indexOf(name);

  const idx = {
    id: col('id'),
    level: col('level'),

    // Pack / focus
    pack: col('pack'),
    focus: col('focus'),

    prompt: col('prompt'),

    // Answer / target
    answer: col('answer'),
    target: col('target'),

    // Tags / metadata
    grammar_tags: col('grammar_tags'),
    tags: col('tags'),
    connectors: col('connectors'),
    notes: col('notes'),
    source: col('source'),

    // optional
    type: col('type'),
    task_type: col('task_type'),
    lang_dir: col('lang_dir'),
  };

  const tasks = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (k) => (idx[k] >= 0 ? norm(row[idx[k]]) : '');

    const prompt = get('prompt');
    const target = get('target') || get('answer');
    const focus = get('pack') || get('focus') || 'General';

    if (!prompt) continue;

    const explicitType = (
      get('task_type') || get('type') || get('lang_dir')
    ).toLowerCase();

    // Heuristics if no explicit type:
    let type = 'speaking';
    const pLower = prompt.toLowerCase();
    if (explicitType.includes('error')) type = 'error_correction';
    else if (explicitType.includes('ca-en') || explicitType.includes('ca_en')) type = 'translate_ca_en';
    else if (explicitType.includes('en-ca') || explicitType.includes('en_ca')) type = 'translate_en_ca';
    else if (explicitType.includes('translate') && explicitType.includes('ca')) type = 'translate_ca_en';
    else if (explicitType.includes('translate') && explicitType.includes('en')) type = 'translate_en_ca';
    else if (target && (pLower.includes('correct') || pLower.includes('fix') || pLower.includes('error'))) type = 'error_correction';
    else if (pLower.startsWith('ca>') || pLower.startsWith('ca:')) type = 'translate_ca_en';
    else if (pLower.startsWith('en>') || pLower.startsWith('en:')) type = 'translate_en_ca';
    else if (!target) type = 'speaking';

    tasks.push({
      id: get('id') || `${focus}-${r}`,
      level: get('level'),
      focus,
      prompt,
      target,
      grammarTags: splitTags(get('grammar_tags') || get('tags')),
      connectors: splitTags(get('connectors')),
      notes: get('notes'),
      source: get('source'),
      type,
    });
  }

  return tasks;
}

export function listGamePacks(tasks) {
  const packs = new Map();
  for (const t of tasks) {
    const key = (t.focus || 'General').trim();
    if (!key) continue;
    packs.set(key, (packs.get(key) || 0) + 1);
  }
  return Array.from(packs.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

export function weightedPick(rng, items, weightFn) {
  const weights = items.map((x) => Math.max(0, weightFn(x) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}
