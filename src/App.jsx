import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'snl_state_v2';
import './App.css';
import { DEFAULT_TYPE_WEIGHTS, TASKS_CSV_URL } from './config';
import { fetchTasks, listGamePacks, weightedPick } from './tasks';

const DEFAULT_BOARD_SIZE = 100; // max

// Base snakes & ladders for size=100. We'll scale these down for smaller boards.
// Format: start -> end
const BASE_JUMPS_100 = {
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

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function buildJumps(boardSize) {
  if (boardSize === 100) return { ...BASE_JUMPS_100 };
  const scale = boardSize / 100;

  const out = {};
  const usedStarts = new Set();

  const add = (s, e) => {
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    if (s <= 1 || s >= boardSize) return;
    if (e <= 1 || e >= boardSize) return;
    if (e === s) return;
    if (usedStarts.has(s)) return;
    usedStarts.add(s);
    out[s] = e;
  };

  for (const [startStr, end] of Object.entries(BASE_JUMPS_100)) {
    const start = parseInt(startStr, 10);
    const kind = end > start ? 'ladder' : 'snake';

    // scaled positions
    let s = Math.round(start * scale);
    let e = Math.round(end * scale);

    s = clamp(s, 2, boardSize - 2);

    // preserve direction and ensure a minimum jump distance
    const minDelta = Math.max(3, Math.round(6 * scale));
    if (kind === 'ladder') {
      e = clamp(Math.max(e, s + minDelta), 2, boardSize - 1);
    } else {
      e = clamp(Math.min(e, s - minDelta), 2, boardSize - 1);
    }

    // avoid landing exactly on final square (keeps win clean)
    if (e === boardSize) e = boardSize - 1;

    add(s, e);
  }

  return out;
}

function boardRows(boardSize, cols = 10) {
  return Math.max(1, Math.ceil(boardSize / cols));
}

function buildBoardCells(boardSize, cols = 10) {
  // Returns an array of numbers (or null) in visual grid order (top-left to bottom-right),
  // with boustrophedon rows.
  const rows = boardRows(boardSize, cols);
  const cells = [];

  let n = boardSize;
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      if (n >= 1) row.push(n--);
      else row.push(null);
    }
    if (r % 2 === 1) row.reverse();
    cells.push(...row);
  }
  return cells;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}


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

function Collapsible({ title, defaultOpen = true, right, children }) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary className="collapsibleSummary">
        <span className="collapsibleTitle">{title}</span>
        {right ? <span className="collapsibleRight">{right}</span> : null}
      </summary>
      <div className="collapsibleBody">{children}</div>
    </details>
  );
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

// (board cells builder is defined above as buildBoardCells(boardSize, cols))

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);
  const [pack, setPack] = useState('');
  const [selectedPacks, setSelectedPacks] = useState([]);
  const [showAnswer, setShowAnswer] = useState(false);
  const [dice, setDice] = useState(1);
  const [history, setHistory] = useState([]);

  const [boardSize, setBoardSize] = useState(DEFAULT_BOARD_SIZE);

  const [numPlayers, setNumPlayers] = useState(2);
  const [players, setPlayers] = useState(() => Array.from({ length: 2 }, (_, i) => ({ name: `P${i + 1}`, pos: 0 })));
  const [turn, setTurn] = useState(0);
  const [pending, setPending] = useState(null); // { roll, taskId }
  const [hydrated, setHydrated] = useState(false);
  const [animating, setAnimating] = useState(false);

  const [selectedLevels, setSelectedLevels] = useState([]);

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
          if (typeof s.boardSize === 'number') setBoardSize(clamp(s.boardSize, 40, 100));
          if (Array.isArray(s.selectedLevels)) setSelectedLevels(s.selectedLevels);
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

  function selectAllPacks() {
    setSelectedPacks(packs.map((p) => p.name));
    setPack('');
  }

  function toggleLevel(lv) {
    setSelectedLevels((prev) => {
      const set = new Set(prev || []);
      if (set.has(lv)) set.delete(lv);
      else set.add(lv);
      return Array.from(set);
    });
  }

  function clearLevels() {
    setSelectedLevels([]);
  }

  function selectAllLevels() {
    setSelectedLevels(levels.slice());
  }

  const levels = useMemo(() => {
    const set = new Set();
    let hasEmpty = false;
    for (const t of tasks) {
      const lv = (t.level || '').trim();
      if (!lv) hasEmpty = true;
      else set.add(lv);
    }
    const out = Array.from(set).sort((a, b) => a.localeCompare(b));
    if (hasEmpty) out.push('Unspecified');
    return out;
  }, [tasks]);

  const filtered = useMemo(() => {
    const legacy = (pack || '').trim();
    const chosen = (selectedPacks || []).filter(Boolean);

    // Backward compatibility: if only legacy 'pack' is set, treat it as the selection.
    const effective = chosen.length ? chosen : (legacy ? [legacy] : []);

    let out = tasks;
    if (effective.length) {
      const set = new Set(effective);
      out = out.filter((t) => set.has(t.focus || 'General'));
    }

    if ((selectedLevels || []).length) {
      const set = new Set(selectedLevels);
      out = out.filter((t) => {
        const lv = (t.level || '').trim();
        if (!lv) return set.has('Unspecified');
        return set.has(lv);
      });
    }

    return out;
  }, [tasks, pack, selectedPacks, selectedLevels]);

  const current = history[0] || null;

  const packLabel = useMemo(() => {
    const chosen = (selectedPacks || []).filter(Boolean);
    if (chosen.length > 1) return `Mixed (${chosen.length})`;
    if (chosen.length === 1) return chosen[0];
    return (pack || 'General').trim() || 'General';
  }, [pack, selectedPacks]);

  const jumps = useMemo(() => buildJumps(boardSize), [boardSize]);
  const boardCells = useMemo(() => buildBoardCells(boardSize, 10), [boardSize]);
  const rows = useMemo(() => boardRows(boardSize, 10), [boardSize]);

  // Persist session state locally
  useEffect(() => {
    if (!hydrated) return;
    const state = {
      pack,
      selectedPacks,
      selectedLevels,
      boardSize,
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
  }, [hydrated, pack, selectedPacks, selectedLevels, boardSize, dice, turn, numPlayers, players, pending, history, showAnswer]);

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
    if (animating) return;
    if (!filtered.length) return;
    if (!players.length) return;

    const value = roll();
    const picked = drawTask(value);

    setShowAnswer(false);
    setHistory((h) => [picked, ...h].slice(0, 50));
    setPending({ roll: value, taskId: picked.id });
  }

  async function applyMove(success) {
    if (!pending || !current) return;
    if (animating) return;

    setAnimating(true);

    try {
      if (success) {
        const startPos = players[turn]?.pos || 0;
        let target = startPos + pending.roll;

        // classic rule: must land exactly on final square
        if (target > boardSize) target = startPos;

        // Step animation
        const stepDelay = 160;
        if (target !== startPos) {
          for (let pos = startPos + 1; pos <= target; pos++) {
            setPlayers((ps) => {
              const next = ps.map((p) => ({ ...p }));
              if (next[turn]) next[turn].pos = pos;
              return next;
            });
            await sleep(stepDelay);
          }
        } else {
          // tiny feedback so the user feels it happened
          await sleep(120);
        }

        // snakes/ladders jump animation
        const jumped = jumps[target];
        if (jumped && jumped !== target) {
          await sleep(220);
          setPlayers((ps) => {
            const next = ps.map((p) => ({ ...p }));
            if (next[turn]) next[turn].pos = jumped;
            return next;
          });
          await sleep(220);
        }
      }

      // next player's turn
      setTurn((t) => (players.length ? (t + 1) % players.length : 0));
      setPending(null);
    } finally {
      setAnimating(false);
    }
  }

  const winnerIdx = useMemo(() => players.findIndex((p) => p.pos === boardSize), [players, boardSize]);

  function resetSession() {
    setHistory([]);
    setShowAnswer(false);
    setPending(null);
    setTurn(0);
    setPlayers((ps) => ps.map((p, i) => ({ ...p, pos: 0, name: p.name || `P${i + 1}` })));
    roll();
  }

  function setBoardSizeAndReset(n) {
    const nextSize = clamp(n, 40, 100);
    setBoardSize(nextSize);
    setPending(null);
    setTurn(0);
    setPlayers((ps) => ps.map((p, i) => ({ ...p, pos: 0, name: p.name || `P${i + 1}` })));
    setHistory([]);
    setShowAnswer(false);
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
                <span className="mono">{players[turn]?.pos || 0} / {boardSize}</span>
              </div>
            </div>

            <div className="controls">
              <Collapsible
                title="Language points"
                right={<span className="muted">Selected: {(selectedPacks?.length || 0) || (pack ? 1 : 0)}</span>}
              >
                <div className="packBox">
                  <div className="packTop">
                    <div className="packTopLeft">
                      <button className="btn ghost" type="button" onClick={clearPacks}>
                        Clear
                      </button>
                      <button className="btn ghost" type="button" onClick={selectAllPacks} disabled={!packs.length}>
                        Select all
                      </button>
                    </div>
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
              </Collapsible>

              <Collapsible title="Players" right={<span className="muted">{numPlayers} players</span>}
>
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
              </Collapsible>

              <Collapsible title="Game settings" right={<span className="muted">Board: {boardSize}</span>}>
                <div className="boardControls">
                  <div className="boardControlRow">
                    <span className="muted">Board size</span>
                    <select value={boardSize} onChange={(e) => setBoardSizeAndReset(parseInt(e.target.value, 10))}>
                      {[40, 50, 60, 70, 80, 90, 100].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="hint">Smaller boards are faster games. Max is 100.</div>
                </div>

                <div className="levelBox" style={{ marginTop: 10 }}>
                  <div className="packTop">
                    <div className="packTopLeft">
                      <button className="btn ghost" type="button" onClick={clearLevels}>
                        Clear levels
                      </button>
                      <button className="btn ghost" type="button" onClick={selectAllLevels} disabled={!levels.length}>
                        Select all levels
                      </button>
                    </div>
                    <span className="muted">Selected: {selectedLevels?.length || 0}</span>
                  </div>

                  <div className="levelGrid">
                    {levels.map((lv) => {
                      const checked = (selectedLevels || []).includes(lv);
                      return (
                        <label key={lv} className={`packItem ${checked ? 'on' : ''}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleLevel(lv)} />
                          <span className="packName">{lv}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="hint">Leave empty to include all levels.</div>
                </div>
              </Collapsible>
            </div>

            <div className="diceTaskRow">
              <div className="card diceCard">
                <div className="cardTitle">Dice</div>
                <div className="diceRow">
                  <Dice value={dice} />
                  <button className="btn" onClick={rollAndDraw} disabled={loading || !!error || !filtered.length || winnerIdx >= 0 || animating}>
                    Roll & Draw
                  </button>
                </div>
                <div className="resultRow">
                  <button className="btn success" onClick={() => applyMove(true)} disabled={!pending || winnerIdx >= 0 || animating}>Success ✅</button>
                  <button className="btn fail" onClick={() => applyMove(false)} disabled={!pending || winnerIdx >= 0 || animating}>Fail ❌</button>
                </div>
                <div className="hint">Success = move by dice. Fail = stay. Exact landing required to win.</div>
              </div>

              <div className="card task taskInline">
                <div className="taskHeader">
                  <div className="taskMeta">
                    <Badge>{packLabel}</Badge>
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
                    <div className="empty">Click <strong>Roll & Draw</strong> to start.</div>
                  )}
                </div>
              </div>
            </div>

            {winnerIdx >= 0 ? (
              <div className="card win">
                <div className="cardTitle">Winner!</div>
                <div className="mono">{players[winnerIdx]?.name || `P${winnerIdx + 1}`} reached {boardSize} 🎉</div>
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
            <div
              className="board"
              role="grid"
              aria-label="Snakes and Ladders board"
              style={{ gridTemplateColumns: 'repeat(10, 1fr)', gridTemplateRows: `repeat(${rows}, 1fr)` }}
            >
              {boardCells.map((n, idx) => {
                if (n == null) {
                  return <div key={`blank-${idx}`} className="cell blank" role="presentation" />;
                }

                const occupants = players
                  .map((p, i) => ({ i, on: p.pos === n }))
                  .filter((x) => x.on)
                  .map((x) => x.i);

                const isTurnCell = players[turn]?.pos === n;

                const jumpTo = jumps[n];
                const jumpKind = jumpTo ? (jumpTo > n ? 'ladder' : 'snake') : '';

                return (
                  <div key={n} className={`cell ${jumpKind} ${isTurnCell ? 'turnCell' : ''}`} role="gridcell">
                    <div className="cellNum">{n}</div>
                    {n === boardSize ? <div className="cellWin">🏁</div> : null}
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

        <section className="belowBoard">
          <Collapsible title="How to play" defaultOpen={false}>
            <ol className="steps">
              <li>Pick language points and levels.</li>
              <li>Roll the dice 🎲 to draw a challenge.</li>
              <li>Mark Success/Fail.</li>
            </ol>
          </Collapsible>

          <Collapsible
            title="Recent draws"
            defaultOpen={false}
            right={<span className="muted">{history.length ? `${history.length} in session` : 'None yet'}</span>}
          >
            <div className="recent">
              {history.slice(0, 10).map((t) => (
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
          </Collapsible>
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
