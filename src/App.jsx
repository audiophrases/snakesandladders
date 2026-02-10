import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'snl_state_v1';
import './App.css';
import { DEFAULT_TYPE_WEIGHTS, TASKS_CSV_URL } from './config';
import { fetchTasks, listGamePacks, weightedPick } from './tasks';

const BOARD_SIZE = 100; // classic 10x10

// Simple snakes & ladders (can tune later). Format: start -> end
const JUMPS = {
  // ladders
  4: 14,
  9: 31,
  20: 38,
  28: 84,
  40: 59,
  63: 81,
  71: 91,
  // snakes
  17: 7,
  54: 34,
  62: 19,
  64: 60,
  87: 24,
  93: 73,
  95: 75,
  99: 78,
};

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

function PlayerChip({ idx, active }) {
  const colors = ['#a78bfa', '#22c55e', '#60a5fa', '#fb7185', '#f59e0b', '#14b8a6'];
  return (
    <span
      className={`pchip ${active ? 'active' : ''}`}
      style={{ background: colors[idx % colors.length] }}
      title={`Player ${idx + 1}`}
    />
  );
}

function buildBoardCells(size) {
  // Returns an array of numbers in visual grid order (top-left to bottom-right), with boustrophedon rows.
  const side = Math.sqrt(size);
  const n = Number.isInteger(side) ? side : 10;
  const rows = [];
  let start = size;
  for (let r = 0; r < n; r++) {
    const rowNums = [];
    for (let c = 0; c < n; c++) rowNums.push(start - c);
    start -= n;
    // alternate direction
    if (r % 2 === 1) rowNums.reverse();
    rows.push(rowNums);
  }
  return rows.flat();
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [pack, setPack] = useState('');
  const [selectedPacks, setSelectedPacks] = useState([]);
  const [showAnswer, setShowAnswer] = useState(false);
  const [dice, setDice] = useState(1);
  const [history, setHistory] = useState([]);

  const [numPlayers, setNumPlayers] = useState(2);
  const [players, setPlayers] = useState(() => Array.from({ length: 2 }, (_, i) => ({ name: `P${i + 1}`, pos: 0 })));
  const [turn, setTurn] = useState(0);
  const [pending, setPending] = useState(null); // { roll, taskId }
  const [hydrated, setHydrated] = useState(false);

  // "session" rng
  const rng = useMemo(() => mulberry32(Date.now() & 0xffffffff), []);

  // Load saved session state (local)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          if (typeof s.pack === 'string') setPack(s.pack);
          if (Array.isArray(s.selectedPacks)) setSelectedPacks(s.selectedPacks);
          if (typeof s.dice === 'number') setDice(s.dice);
          if (typeof s.turn === 'number') setTurn(s.turn);
          if (typeof s.numPlayers === 'number') setNumPlayers(s.numPlayers);
          if (Array.isArray(s.players)) setPlayers(s.players);
          if (Array.isArray(s.history)) setHistory(s.history);
          if (typeof s.showAnswer === 'boolean') setShowAnswer(s.showAnswer);
          if (s.pending && typeof s.pending === 'object') setPending(s.pending);
        }
      }
    } catch {
      // ignore corrupt storage
    } finally {
      setHydrated(true);
    }
  }, []);

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
        // If no pack chosen (fresh start), pick the first available.
        setPack((p) => p || (packs[0]?.name || 'General'));
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

  function togglePack(name) {
    setSelectedPacks((prev) => {
      const set = new Set(prev || []);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      return Array.from(set);
    });
  }

  function clearPacks() {
    setSelectedPacks([]);
    setPack('');
  }

  const filtered = useMemo(() => {
    const legacy = (pack || '').trim();
    const chosen = (selectedPacks || []).filter(Boolean);

    // Backward compatibility: if only legacy 'pack' is set, treat it as the selection.
    const effective = chosen.length ? chosen : (legacy ? [legacy] : []);

    if (!effective.length) return tasks;
    const set = new Set(effective);
    return tasks.filter((t) => set.has(t.focus || 'General'));
  }, [tasks, pack, selectedPacks]);

  const current = history[0] || null;

  const boardCells = useMemo(() => buildBoardCells(BOARD_SIZE), []);

  // Persist session state locally
  useEffect(() => {
    if (!hydrated) return;
    const state = {
      pack,
      selectedPacks,
      dice,
      turn,
      numPlayers,
      players,
      pending,
      history,
      showAnswer,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore quota / storage errors
    }
  }, [hydrated, pack, selectedPacks, dice, turn, numPlayers, players, pending, history, showAnswer]);

  function roll() {
    const value = 1 + Math.floor(rng() * 6);
    setDice(value);
    return value;
  }

  function drawTask(rollValue) {
    // balance across types: downweight types that were just used.
    const recent = history.slice(0, 4).map((h) => h.type);
    const counts = recent.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});

    const candidates = filtered.filter((t) => !history.slice(0, 10).some((h) => h.id === t.id));
    const pool = candidates.length ? candidates : filtered;

    return weightedPick(rng, pool, (t) => {
      const base = DEFAULT_TYPE_WEIGHTS[t.type] || 1;
      const penalty = 1 / (1 + (counts[t.type] || 0));
      // dice spice
      const spice =
        rollValue === 6 && t.type === 'speaking'
          ? 1.4
          : rollValue === 1 && t.type === 'error_correction'
            ? 1.4
            : 1;
      return base * penalty * spice;
    });
  }

  function rollAndDraw() {
    if (!filtered.length) return;
    if (!players.length) return;

    const value = roll();
    const picked = drawTask(value);

    setShowAnswer(false);
    setHistory((h) => [picked, ...h].slice(0, 50));
    setPending({ roll: value, taskId: picked.id });
  }

  function applyMove(success) {
    if (!pending || !current) return;

    if (success) {
      setPlayers((ps) => {
        const next = ps.map((p) => ({ ...p }));
        const p = next[turn];
        let newPos = p.pos + pending.roll;

        // classic rule: must land exactly on 100
        if (newPos > BOARD_SIZE) newPos = p.pos;

        // snakes/ladders
        const jumped = JUMPS[newPos];
        if (jumped) newPos = jumped;

        p.pos = newPos;
        return next;
      });
    }

    // next player's turn
    setTurn((t) => (players.length ? (t + 1) % players.length : 0));
    setPending(null);
  }

  const winnerIdx = useMemo(() => players.findIndex((p) => p.pos === BOARD_SIZE), [players]);

  function resetSession() {
    setHistory([]);
    setShowAnswer(false);
    setPending(null);
    setTurn(0);
    setPlayers((ps) => ps.map((p, i) => ({ ...p, pos: 0, name: p.name || `P${i + 1}` })));
    roll();
  }

  function setPlayerCount(n) {
    const clamped = Math.max(1, Math.min(6, n));
    setNumPlayers(clamped);
    setTurn(0);
    setPending(null);
    setPlayers((prev) => {
      const next = [];
      for (let i = 0; i < clamped; i++) {
        next.push({ name: prev[i]?.name || `P${i + 1}`, pos: prev[i]?.pos || 0 });
      }
      return next;
    });
  }

  function setPlayerName(idx, name) {
    setPlayers((prev) => {
      const next = prev.map((p) => ({ ...p }));
      if (!next[idx]) return prev;
      next[idx].name = (name || '').slice(0, 20);
      return next;
    });
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
        </div>
      </header>

      <main className="container">
        <section className="hero">
          <div className="hero-left">
            <div className="turnBanner" aria-label="Current turn">
              <div className="turnBannerLeft">
                <span className="muted">Current turn</span>
                <div className="turnBannerName">
                  <PlayerChip idx={turn} active />
                  <span>{players[turn]?.name || `P${turn + 1}`}</span>
                </div>
              </div>
              <div className="turnBannerRight">
                <span className="muted">Position</span>
                <span className="mono">{players[turn]?.pos || 0} / {BOARD_SIZE}</span>
              </div>
            </div>

            <div className="controls">
              <div className="control">
                <label>Language points (combine)</label>
                <div className="packBox">
                  <div className="packTop">
                    <button className="btn ghost" type="button" onClick={clearPacks}>
                      Clear
                    </button>
                    <span className="muted">
                      Selected: {(selectedPacks?.length || 0) || (pack ? 1 : 0)}
                    </span>
                  </div>

                  <div className="packGrid">
                    {packs.map((p) => {
                      const checked = (selectedPacks || []).includes(p.name) || (!selectedPacks?.length && pack === p.name);
                      return (
                        <label key={p.name} className={`packItem ${checked ? 'on' : ''}`}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              // migrate from legacy single-pack state
                              if (pack && !selectedPacks?.length) {
                                setSelectedPacks([pack]);
                                setPack('');
                              }
                              togglePack(p.name);
                            }}
                          />
                          <span className="packName">{p.name}</span>
                          <span className="muted">({p.count})</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="control">
                <label>Players</label>
                <div className="playersRow">
                  <select value={numPlayers} onChange={(e) => setPlayerCount(parseInt(e.target.value, 10))}>
                    {[1, 2, 3, 4, 5, 6].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <div className="playersMini">
                    {players.map((_, i) => (
                      <PlayerChip key={i} idx={i} active={i === turn} />
                    ))}
                    <span className="muted turnLabel">Turn:</span>
                    <span className="turnNow">
                      <PlayerChip idx={turn} active />
                      <span className="turnName">{players[turn]?.name || `P${turn + 1}`}</span>
                    </span>
                  </div>
                </div>

                <div className="names">
                  {players.map((p, i) => (
                    <label key={i} className="nameRow">
                      <span className="nameLeft">
                        <PlayerChip idx={i} active={i === turn} />
                        <span className="muted">Name</span>
                      </span>
                      <input
                        className="nameInput"
                        value={p.name || ''}
                        onChange={(e) => setPlayerName(i, e.target.value)}
                        placeholder={`P${i + 1}`}
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="control">
                <label>Dice</label>
                <div className="diceRow">
                  <Dice value={dice} />
                  <button className="btn" onClick={rollAndDraw} disabled={loading || !!error || !filtered.length || winnerIdx >= 0}>
                    Roll & Draw
                  </button>
                </div>
                <div className="resultRow">
                  <button className="btn success" onClick={() => applyMove(true)} disabled={!pending || winnerIdx >= 0}>Success ✅</button>
                  <button className="btn fail" onClick={() => applyMove(false)} disabled={!pending || winnerIdx >= 0}>Fail ❌</button>
                </div>
                <div className="hint">
                  Success = move by dice. Fail = stay. To win, you must land exactly on {BOARD_SIZE}.
                </div>
              </div>
            </div>

            {winnerIdx >= 0 ? (
              <div className="card win">
                <div className="cardTitle">Winner!</div>
                <div className="mono">{players[winnerIdx]?.name || `P${winnerIdx + 1}`} reached {BOARD_SIZE} 🎉</div>
              </div>
            ) : null}

            {error ? (
              <div className="card error">
                <div className="cardTitle">Oops</div>
                <div className="mono">{error}</div>
                <div className="hint">
                  If this is the first time, make sure the sheet is public and the CSV URL is reachable.
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

        </section>

        <section className="boardWrap">
          <div className="card boardCard">
            <div className="boardHeader">
              <div className="cardTitle">Board</div>
              <div className="muted">Snakes 🐍 and ladders 🪜 are included (basic set).</div>
            </div>
            <div className="board" role="grid" aria-label="Snakes and Ladders board">
              {boardCells.map((n) => {
                const occupants = players
                  .map((p, i) => ({ i, on: p.pos === n }))
                  .filter((x) => x.on)
                  .map((x) => x.i);

                const isTurnCell = players[turn]?.pos === n;

                const jumpTo = JUMPS[n];
                const jumpKind = jumpTo ? (jumpTo > n ? 'ladder' : 'snake') : '';

                return (
                  <div key={n} className={`cell ${jumpKind} ${isTurnCell ? 'turnCell' : ''}`} role="gridcell">
                    <div className="cellNum">{n}</div>
                    {n === BOARD_SIZE ? <div className="cellWin">🏁</div> : null}
                    {jumpTo ? (
                      <div className="cellJump">
                        {jumpTo > n ? '🪜' : '🐍'} {n}→{jumpTo}
                      </div>
                    ) : null}
                    <div className="cellOcc">
                      {occupants.map((i) => (
                        <PlayerChip key={i} idx={i} active={i === turn} />
                      ))}
                    </div>
                  </div>
                );
              })}
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
              <li>Roll the dice 🎲 to draw a challenge.</li>
              <li>Mark Success/Fail.</li>
            </ol>

            <div className="cardTitle">Recent draws</div>
            <div className="recent">
              {history.slice(0, 6).map((t) => (
                <button
                  key={t.id}
                  className="recentItem"
                  onClick={() => {
                    setShowAnswer(false);
                    setHistory((h) => [t, ...h.filter((x) => x.id !== t.id)]);
                  }}
                >
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
          <div>Built for <strong>ESL practice</strong>. Edit the sheet to add more tasks.</div>
          <div className="footerRight">
            <a href="https://github.com/audiophrases/snakesandladders" target="_blank" rel="noreferrer">GitHub</a>
          </div>
        </footer>
      </main>
    </div>
  );
}
