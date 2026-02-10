import { useEffect, useMemo, useState } from 'react';
import './App.css';
import { DEFAULT_TYPE_WEIGHTS, TASKS_CSV_URL } from './config';
import { fetchTasks, listGamePacks, weightedPick } from './tasks';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function Dice({ value }) {
  return (
    <div className="dice" aria-label={`Dice shows ${value}`}> 
      <div className={`pipgrid pips-${value}`}>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="pip" />
        ))}
      </div>
    </div>
  );
}

function Badge({ children }) {
  return <span className="badge">{children}</span>;
}

function typeLabel(t) {
  if (t === 'speaking') return 'Speaking';
  if (t === 'error_correction') return 'Fix the mistake';
  if (t === 'translate_ca_en') return 'Translate (CA → EN)';
  if (t === 'translate_en_ca') return 'Translate (EN → CA)';
  return t;
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [pack, setPack] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const [dice, setDice] = useState(1);
  const [history, setHistory] = useState([]);

  // "session" rng
  const rng = useMemo(() => mulberry32(Date.now() & 0xffffffff), []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const data = await fetchTasks(TASKS_CSV_URL);
        if (!alive) return;
        setTasks(data);
        const packs = listGamePacks(data);
        setPack(packs[0]?.name || 'General');
      } catch (e) {
        if (!alive) return;
        setError(e?.message || String(e));
      } finally {
        if (!alive) return;
        setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const packs = useMemo(() => listGamePacks(tasks), [tasks]);

  const filtered = useMemo(() => {
    const p = (pack || '').trim();
    if (!p) return tasks;
    return tasks.filter((t) => (t.focus || 'General') === p);
  }, [tasks, pack]);

  const current = history[0] || null;

  function roll() {
    const value = 1 + Math.floor(rng() * 6);
    setDice(value);
    return value;
  }

  function nextTask() {
    if (!filtered.length) return;

    const value = roll();

    // balance across types: downweight types that were just used.
    const recent = history.slice(0, 4).map((h) => h.type);
    const counts = recent.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});

    const candidates = filtered.filter((t) => !history.slice(0, 10).some((h) => h.id === t.id));
    const pool = candidates.length ? candidates : filtered;

    const picked = weightedPick(rng, pool, (t) => {
      const base = DEFAULT_TYPE_WEIGHTS[t.type] || 1;
      const penalty = 1 / (1 + (counts[t.type] || 0));
      // Use dice as a tiny spice: if 6, favor speaking; if 1, favor correction.
      const spice =
        value === 6 && t.type === 'speaking'
          ? 1.4
          : value === 1 && t.type === 'error_correction'
            ? 1.4
            : 1;
      return base * penalty * spice;
    });

    setShowAnswer(false);
    setHistory((h) => [picked, ...h].slice(0, 50));
  }

  function resetSession() {
    setHistory([]);
    setShowAnswer(false);
    roll();
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="logo">🐍🎲🪜</div>
          <div>
            <div className="title">Snakes & Ladders</div>
            <div className="subtitle">ESL Grammar + Speaking Practice</div>
          </div>
        </div>
        <div className="top-actions">
          <button className="btn ghost" onClick={resetSession}>New session</button>
          <a className="btn ghost" href="https://docs.google.com/spreadsheets/d/1ITLDp3Bp_ohKnw-Zg4gq4JJ-pIAnFMCEp0Rumyx3zdM/edit" target="_blank" rel="noreferrer">Task bank</a>
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <div className="hero-left">
            <h1>Roll the dice. Get a challenge. Speak better English.</h1>
            <p>
              Balanced mix of <strong>speaking</strong>, <strong>error correction</strong>, and
              <strong> translations</strong> (CA↔EN). Feed it by editing the Google Sheet.
            </p>

            <div className="controls">
              <div className="control">
                <label>Game / language point</label>
                <select value={pack} onChange={(e) => setPack(e.target.value)}>
                  {packs.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ({p.count})
                    </option>
                  ))}
                </select>
              </div>

              <div className="control">
                <label>Dice</label>
                <div className="diceRow">
                  <Dice value={dice} />
                  <button className="btn" onClick={nextTask} disabled={loading || !!error || !filtered.length}>
                    Roll & Draw
                  </button>
                </div>
              </div>
            </div>

            {error ? (
              <div className="card error">
                <div className="cardTitle">Oops</div>
                <div className="mono">{error}</div>
                <div className="hint">
                  If this is the first time, make sure the sheet is public (anyone-with-link) and the CSV URL is reachable.
                </div>
              </div>
            ) : null}

            {loading ? (
              <div className="card">
                <div className="skeleton" />
                <div className="skeleton small" />
              </div>
            ) : null}
          </div>

          <div className="hero-right">
            <div className="poster">
              <div className="posterTop">Today’s vibe</div>
              <div className="posterBig">Therefore…</div>
              <div className="posterLine">so / because / however / but</div>
              <div className="posterEmojis">🗣️✨📚</div>
            </div>
          </div>
        </section>

        <section className="play">
          <div className="card task">
            <div className="taskHeader">
              <div className="taskMeta">
                <Badge>{pack || 'General'}</Badge>
                {current ? <Badge>{typeLabel(current.type)}</Badge> : <Badge>Ready</Badge>}
                {current?.grammarTags?.slice(0, 2).map((t) => <Badge key={t}>{t}</Badge>)}
              </div>
              <div className="taskActions">
                <button className="btn ghost" onClick={() => setShowAnswer((v) => !v)} disabled={!current || !current.target}>
                  {showAnswer ? 'Hide' : 'Show'} answer
                </button>
              </div>
            </div>

            <div className="taskBody">
              {current ? (
                <>
                  <div className="prompt">{current.prompt}</div>
                  {showAnswer && current.target ? (
                    <div className="answer">
                      <div className="answerLabel">Suggested answer</div>
                      <div className="mono">{current.target}</div>
                    </div>
                  ) : null}

                  {current.connectors?.length ? (
                    <div className="connectors">
                      <span className="muted">Connectors:</span> {current.connectors.join(', ')}
                    </div>
                  ) : null}

                  {current.notes ? (
                    <div className="notes">
                      <span className="muted">Note:</span> {current.notes}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty">
                  Click <strong>Roll & Draw</strong> to start.
                </div>
              )}
            </div>
          </div>

          <div className="card sidebar">
            <div className="cardTitle">How to play</div>
            <ol className="steps">
              <li>Pick a language point (game).</li>
              <li>Roll the dice 🎲.</li>
              <li>Do the challenge out loud.</li>
              <li>Use <em>therefore / so / because / however / but</em> when you can.</li>
            </ol>

            <div className="cardTitle">Recent draws</div>
            <div className="recent">
              {history.slice(0, 6).map((t) => (
                <button key={t.id} className="recentItem" onClick={() => { setShowAnswer(false); setHistory((h) => [t, ...h.filter((x) => x.id !== t.id)]); }}>
                  <div className="recentTop">
                    <span className="recentType">{typeLabel(t.type)}</span>
                    <span className="recentPack">{t.focus}</span>
                  </div>
                  <div className="recentPrompt">{t.prompt}</div>
                </button>
              ))}
              {!history.length ? <div className="muted">No draws yet.</div> : null}
            </div>
          </div>
        </section>

        <footer className="footer">
          <div>
            Built for <strong>ESL practice</strong>. Edit the sheet to add more tasks.
          </div>
          <div className="footerRight">
            <a href="https://github.com/audiophrases/snakesandladders" target="_blank" rel="noreferrer">GitHub</a>
            <span className="dot">•</span>
            <a href="https://docs.google.com/spreadsheets/d/1ITLDp3Bp_ohKnw-Zg4gq4JJ-pIAnFMCEp0Rumyx3zdM/export?format=csv&gid=0" target="_blank" rel="noreferrer">CSV</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
