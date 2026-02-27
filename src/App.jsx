import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { DEFAULT_TYPE_WEIGHTS, TASKS_CSV_URL } from './config';
import { fetchTasks, listGamePacks, weightedPick } from './tasks';

const STORAGE_KEY = 'snl_party_v3';
const DEFAULT_BOARD_SIZE = 100;

// start -> end
const BASE_JUMPS_100 = {
  4: 14,
  9: 31,
  20: 38,
  28: 84,
  40: 59,
  63: 81,
  71: 91,
  17: 7,
  54: 34,
  62: 19,
  64: 60,
  87: 24,
  93: 73,
  95: 75,
  99: 78,
};

const BASE_JUMP_ENTRIES = Object.entries(BASE_JUMPS_100)
  .map(([start, end]) => ({ start: Number(start), end: Number(end) }))
  .sort((a, b) => a.start - b.start);

const BASE_LADDERS = BASE_JUMP_ENTRIES.filter((j) => j.end > j.start);
const BASE_SNAKES = BASE_JUMP_ENTRIES.filter((j) => j.end < j.start);

function pickEvenly(entries, count) {
  if (!entries.length || count <= 0) return [];
  if (count >= entries.length) return entries.slice();

  const picked = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const raw = Math.floor(((i + 0.5) * entries.length) / count);
    let idx = clamp(raw, 0, entries.length - 1);

    while (used.has(idx) && idx < entries.length - 1) idx += 1;
    while (used.has(idx) && idx > 0) idx -= 1;

    used.add(idx);
    picked.push(entries[idx]);
  }

  return picked.sort((a, b) => a.start - b.start);
}

const CATALAN_EMOJI = '🥘';
const ENGLISH_EMOJI = '🍔';

const TYPE_ICON = {
  speaking: '🗣️',
  error_correction: '🛠️',
  translate_ca_en: `${CATALAN_EMOJI}➡️${ENGLISH_EMOJI}`,
  translate_en_ca: `${ENGLISH_EMOJI}➡️${CATALAN_EMOJI}`,
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
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

function boardRows(boardSize, cols = 10) {
  return Math.max(1, Math.ceil(boardSize / cols));
}

function buildBoardCells(boardSize, cols = 10) {
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

function buildNumberToGrid(boardCells, cols = 10) {
  const map = new Map();
  boardCells.forEach((n, i) => {
    if (n == null) return;
    map.set(n, { row: Math.floor(i / cols), col: i % cols });
  });
  return map;
}

function scaleCell(n, boardSize) {
  return clamp(Math.round(n * (boardSize / 100)), 2, boardSize - 1);
}

function buildJumps(boardSize) {
  if (boardSize === 100) return { ...BASE_JUMPS_100 };

  const out = {};
  const usedStarts = new Set();
  const minDelta = Math.max(3, Math.round(6 * (boardSize / 100)));

  const add = (s, e) => {
    if (s <= 1 || s >= boardSize) return;
    if (e <= 1 || e >= boardSize) return;
    if (s === e) return;
    if (usedStarts.has(s)) return;
    usedStarts.add(s);
    out[s] = e;
  };

  // Keep snakes/ladders proportional to board length.
  // Example: 100-cell board keeps all base jumps; 40-cell board keeps ~40%.
  const ratio = boardSize / 100;
  const baseTotal = BASE_JUMP_ENTRIES.length;
  const targetTotal = clamp(Math.round(baseTotal * ratio), 2, baseTotal);

  let laddersCount = Math.max(1, Math.round(BASE_LADDERS.length * ratio));
  let snakesCount = Math.max(1, Math.round(BASE_SNAKES.length * ratio));

  while (laddersCount + snakesCount > targetTotal) {
    if (snakesCount >= laddersCount && snakesCount > 1) snakesCount -= 1;
    else if (laddersCount > 1) laddersCount -= 1;
    else snakesCount -= 1;
  }

  while (laddersCount + snakesCount < targetTotal) {
    if (snakesCount < BASE_SNAKES.length && snakesCount <= laddersCount) snakesCount += 1;
    else if (laddersCount < BASE_LADDERS.length) laddersCount += 1;
    else if (snakesCount < BASE_SNAKES.length) snakesCount += 1;
    else break;
  }

  const selected = [
    ...pickEvenly(BASE_LADDERS, laddersCount),
    ...pickEvenly(BASE_SNAKES, snakesCount),
  ].sort((a, b) => a.start - b.start);

  for (const { start, end } of selected) {
    const kind = end > start ? 'ladder' : 'snake';

    let s = scaleCell(start, boardSize);
    let e = scaleCell(end, boardSize);

    if (kind === 'ladder') e = clamp(Math.max(e, s + minDelta), 2, boardSize - 1);
    else e = clamp(Math.min(e, s - minDelta), 2, boardSize - 1);

    add(s, e);
  }

  return out;
}

function buildSpecialCells(boardSize, jumps) {
  const jumpOccupied = new Set();
  Object.entries(jumps).forEach(([s, e]) => {
    jumpOccupied.add(Number(s));
    jumpOccupied.add(Number(e));
  });

  const seed = [
    { n: 7, kind: 'boost' },
    { n: 16, kind: 'boost' },
    { n: 43, kind: 'boost' },
    { n: 23, kind: 'trap' },
    { n: 51, kind: 'trap' },
    { n: 79, kind: 'trap' },
    { n: 33, kind: 'freeze' },
    { n: 68, kind: 'freeze' },
    { n: 90, kind: 'lucky' },
  ];

  const out = {};
  for (const item of seed) {
    const cell = scaleCell(item.n, boardSize);
    if (cell <= 1 || cell >= boardSize) continue;
    if (jumpOccupied.has(cell)) continue;
    out[cell] = item.kind;
  }

  return out;
}

function typeLabel(t) {
  if (t === 'speaking') return 'Speak';
  if (t === 'error_correction') return 'Fix';
  if (t === 'translate_ca_en') return 'CA → EN';
  if (t === 'translate_en_ca') return 'EN → CA';
  return t || 'Task';
}

function PlayerChip({ idx, active, tiny = false }) {
  const colors = ['#a855f7', '#22c55e', '#3b82f6', '#f97316', '#f43f5e', '#14b8a6'];
  return (
    <span
      className={`pchip ${active ? 'active' : ''} ${tiny ? 'tiny' : ''}`}
      style={{ background: colors[idx % colors.length] }}
      aria-label={`Player ${idx + 1}`}
    />
  );
}

function Dice({ value, rolling }) {
  return (
    <div className={`dice ${rolling ? 'rolling' : ''}`} aria-label={`Dice ${value}`}>
      <div className={`pipgrid pips-${value}`}>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="pip" />
        ))}
      </div>
    </div>
  );
}

function JumpOverlay({ boardRef, jumps }) {
  const [layout, setLayout] = useState({ width: 0, height: 0, points: {} });

  useLayoutEffect(() => {
    const boardEl = boardRef.current;
    if (!boardEl) return undefined;

    let raf = 0;

    const measure = () => {
      const rect = boardEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const uniqueCells = new Set();
      Object.entries(jumps).forEach(([s, e]) => {
        uniqueCells.add(Number(s));
        uniqueCells.add(Number(e));
      });

      const points = {};
      uniqueCells.forEach((cell) => {
        const el = boardEl.querySelector(`[data-cell-number="${cell}"]`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        points[cell] = {
          x: r.left - rect.left + r.width / 2,
          y: r.top - rect.top + r.height / 2,
        };
      });

      setLayout({ width: rect.width, height: rect.height, points });
    };

    const requestMeasure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    requestMeasure();

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(requestMeasure) : null;
    if (ro) ro.observe(boardEl);

    window.addEventListener('resize', requestMeasure);

    return () => {
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', requestMeasure);
    };
  }, [boardRef, jumps]);

  const toPoint = (cell) => layout.points[cell] || null;

  if (!layout.width || !layout.height) return null;

  return (
    <svg className="jumpOverlay" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="none" aria-hidden>
      {Object.entries(jumps).map(([sStr, e]) => {
        const s = Number(sStr);
        const a = toPoint(s);
        const b = toPoint(e);
        if (!a || !b) return null;

        const ladder = e > s;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;

        if (ladder) {
          const railOffset = clamp(len * 0.06, 5, 11);
          const railW = clamp(len * 0.035, 2.6, 4.4);
          const rungW = clamp(len * 0.02, 1.6, 2.8);

          const x1 = a.x + nx * railOffset;
          const y1 = a.y + ny * railOffset;
          const x2 = b.x + nx * railOffset;
          const y2 = b.y + ny * railOffset;
          const x3 = a.x - nx * railOffset;
          const y3 = a.y - ny * railOffset;
          const x4 = b.x - nx * railOffset;
          const y4 = b.y - ny * railOffset;

          const rungCount = clamp(Math.round(len / 32), 3, 8);
          const rungs = [];
          for (let i = 1; i <= rungCount; i++) {
            const t = i / (rungCount + 1);
            const rx1 = x1 + (x2 - x1) * t;
            const ry1 = y1 + (y2 - y1) * t;
            const rx2 = x3 + (x4 - x3) * t;
            const ry2 = y3 + (y4 - y3) * t;
            rungs.push(
              <line
                key={`${s}-${e}-r-${i}`}
                x1={rx1}
                y1={ry1}
                x2={rx2}
                y2={ry2}
                stroke="#ecfeff"
                strokeWidth={rungW}
                opacity="0.95"
                strokeLinecap="round"
              />,
            );
          }

          return (
            <g key={`${s}-${e}`} className="ladderPath">
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#0f172a" strokeWidth={railW + 1.8} opacity="0.35" strokeLinecap="round" />
              <line x1={x3} y1={y3} x2={x4} y2={y4} stroke="#0f172a" strokeWidth={railW + 1.8} opacity="0.35" strokeLinecap="round" />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#7dd3fc" strokeWidth={railW} opacity="0.95" strokeLinecap="round" />
              <line x1={x3} y1={y3} x2={x4} y2={y4} stroke="#7dd3fc" strokeWidth={railW} opacity="0.95" strokeLinecap="round" />
              {rungs}
            </g>
          );
        }

        const amp = clamp(len * 0.12, 8, 24);
        const midX = a.x + dx * 0.5;
        const midY = a.y + dy * 0.5;
        const q1x = a.x + dx * 0.25 + nx * amp;
        const q1y = a.y + dy * 0.25 + ny * amp;
        const q2x = a.x + dx * 0.75 - nx * amp;
        const q2y = a.y + dy * 0.75 - ny * amp;
        const snakePath = `M ${a.x} ${a.y} Q ${q1x} ${q1y} ${midX} ${midY} Q ${q2x} ${q2y} ${b.x} ${b.y}`;

        const bodyW = clamp(len * 0.045, 4.8, 9.5);
        const headR = bodyW * 0.75;
        const eyeOffset = bodyW * 0.28;
        const eyeForward = bodyW * 0.2;

        return (
          <g key={`${s}-${e}`} className="snakePath">
            <path d={snakePath} fill="none" stroke="#0f172a" strokeWidth={bodyW + 2.6} opacity="0.38" strokeLinecap="round" />
            <path d={snakePath} fill="none" stroke="#fb7185" strokeWidth={bodyW} opacity="0.95" strokeLinecap="round" />
            <circle cx={b.x} cy={b.y} r={headR} fill="#f43f5e" />
            <circle cx={b.x + nx * eyeOffset + ux * eyeForward} cy={b.y + ny * eyeOffset + uy * eyeForward} r={Math.max(1.2, bodyW * 0.13)} fill="#fff" />
            <circle cx={b.x - nx * eyeOffset + ux * eyeForward} cy={b.y - ny * eyeOffset + uy * eyeForward} r={Math.max(1.2, bodyW * 0.13)} fill="#fff" />
          </g>
        );
      })}
    </svg>
  );
}

export default function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tasks, setTasks] = useState([]);

  const [selectedPacks, setSelectedPacks] = useState([]);
  const [selectedLevels, setSelectedLevels] = useState([]);

  const [boardSize, setBoardSize] = useState(DEFAULT_BOARD_SIZE);
  const [numPlayers, setNumPlayers] = useState(2);
  const [players, setPlayers] = useState(() => [
    { name: 'P1', pos: 0, skip: 0 },
    { name: 'P2', pos: 0, skip: 0 },
  ]);
  const [turn, setTurn] = useState(0);

  const [dice, setDice] = useState(1);
  const [rolling, setRolling] = useState(false);
  const [animating, setAnimating] = useState(false);

  const [history, setHistory] = useState([]);
  const [pending, setPending] = useState(null); // { roll, taskId }
  const [showAnswer, setShowAnswer] = useState(false);

  const [notice, setNotice] = useState('🎉 Roll the dice and play!');
  const [bursts, setBursts] = useState([]); // {id, emoji, x, y}
  const [soundOn, setSoundOn] = useState(true);
  const audioCtxRef = useRef(null);
  const boardGridRef = useRef(null);

  const [hydrated, setHydrated] = useState(false);

  const rng = useMemo(() => mulberry32(Date.now() & 0xffffffff), []);

  const packs = useMemo(() => listGamePacks(tasks), [tasks]);

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
    let out = tasks;

    if (selectedPacks.length) {
      const set = new Set(selectedPacks);
      out = out.filter((t) => set.has(t.focus || 'General'));
    }

    if (selectedLevels.length) {
      const set = new Set(selectedLevels);
      out = out.filter((t) => {
        const lv = (t.level || '').trim();
        if (!lv) return set.has('Unspecified');
        return set.has(lv);
      });
    }

    return out;
  }, [tasks, selectedPacks, selectedLevels]);

  const current = history[0] || null;

  const boardCells = useMemo(() => buildBoardCells(boardSize, 10), [boardSize]);
  const rows = useMemo(() => boardRows(boardSize, 10), [boardSize]);
  const jumps = useMemo(() => buildJumps(boardSize), [boardSize]);
  const specials = useMemo(() => buildSpecialCells(boardSize, jumps), [boardSize, jumps]);

  const winnerIdx = useMemo(() => players.findIndex((p) => p.pos === boardSize), [players, boardSize]);

  // --- Sound ---
  const ensureAudio = () => {
    if (!audioCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtxRef.current = new Ctx();
    }
    return audioCtxRef.current;
  };

  const beep = async (freq, ms, type = 'sine', gain = 0.04) => {
    const ctx = ensureAudio();
    if (!ctx || !soundOn) return;
    if (ctx.state === 'suspended') await ctx.resume();

    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = gain;
    o.connect(g);
    g.connect(ctx.destination);

    const now = ctx.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + ms / 1000);
    o.start(now);
    o.stop(now + ms / 1000);
  };

  const playSfx = async (kind) => {
    if (!soundOn) return;
    if (kind === 'roll') {
      await beep(320, 70, 'triangle', 0.04);
      await sleep(50);
      await beep(420, 70, 'triangle', 0.04);
      return;
    }
    if (kind === 'success') {
      await beep(520, 80, 'sine', 0.05);
      await sleep(55);
      await beep(700, 110, 'sine', 0.05);
      return;
    }
    if (kind === 'fail') {
      await beep(260, 120, 'sawtooth', 0.045);
      return;
    }
    if (kind === 'ladder') {
      await beep(500, 80, 'square', 0.045);
      await sleep(45);
      await beep(650, 90, 'square', 0.045);
      await sleep(45);
      await beep(830, 110, 'square', 0.045);
      return;
    }
    if (kind === 'snake') {
      await beep(380, 100, 'sawtooth', 0.04);
      await sleep(35);
      await beep(260, 130, 'sawtooth', 0.04);
      return;
    }
    if (kind === 'win') {
      await beep(620, 110, 'triangle', 0.05);
      await sleep(40);
      await beep(780, 110, 'triangle', 0.05);
      await sleep(40);
      await beep(980, 170, 'triangle', 0.05);
      return;
    }
    if (kind === 'freeze') {
      await beep(410, 80, 'sine', 0.04);
      await sleep(50);
      await beep(310, 120, 'sine', 0.04);
    }
  };

  // --- Bursts ---
  const spawnBurst = (emoji = '✨', count = 12) => {
    const idBase = Date.now() + Math.random();
    const items = Array.from({ length: count }).map((_, i) => ({
      id: `${idBase}-${i}`,
      emoji,
      x: 28 + Math.random() * 44,
      y: 35 + Math.random() * 35,
      dx: -60 + Math.random() * 120,
      dy: -120 - Math.random() * 120,
      rot: -80 + Math.random() * 160,
      life: 900 + Math.random() * 500,
    }));

    setBursts((prev) => [...prev, ...items]);

    items.forEach((b) => {
      setTimeout(() => {
        setBursts((prev) => prev.filter((x) => x.id !== b.id));
      }, b.life);
    });
  };

  // --- Load/save ---
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && typeof s === 'object') {
          if (Array.isArray(s.selectedPacks)) setSelectedPacks(s.selectedPacks);
          if (Array.isArray(s.selectedLevels)) setSelectedLevels(s.selectedLevels);
          if (typeof s.boardSize === 'number') setBoardSize(clamp(s.boardSize, 40, 100));
          if (typeof s.numPlayers === 'number') setNumPlayers(clamp(s.numPlayers, 1, 6));
          if (Array.isArray(s.players)) setPlayers(s.players);
          if (typeof s.turn === 'number') setTurn(s.turn);
          if (Array.isArray(s.history)) setHistory(s.history);
          if (s.pending && typeof s.pending === 'object') setPending(s.pending);
          if (typeof s.showAnswer === 'boolean') setShowAnswer(s.showAnswer);
          if (typeof s.soundOn === 'boolean') setSoundOn(s.soundOn);
          if (typeof s.notice === 'string') setNotice(s.notice);
        }
      }
    } catch {
      // ignore
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

  useEffect(() => {
    if (!hydrated) return;
    const state = {
      selectedPacks,
      selectedLevels,
      boardSize,
      numPlayers,
      players,
      turn,
      history,
      pending,
      showAnswer,
      soundOn,
      notice,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [
    hydrated,
    selectedPacks,
    selectedLevels,
    boardSize,
    numPlayers,
    players,
    turn,
    history,
    pending,
    showAnswer,
    soundOn,
    notice,
  ]);

  // --- Controls ---
  const setPlayerCount = (n) => {
    const clamped = clamp(n, 1, 6);
    setNumPlayers(clamped);
    setTurn(0);
    setPending(null);
    setPlayers((prev) => {
      const next = [];
      for (let i = 0; i < clamped; i++) {
        next.push({
          name: prev[i]?.name || `P${i + 1}`,
          pos: prev[i]?.pos || 0,
          skip: prev[i]?.skip || 0,
        });
      }
      return next;
    });
  };

  const setPlayerName = (idx, name) => {
    setPlayers((prev) => {
      const next = prev.map((p) => ({ ...p }));
      if (!next[idx]) return prev;
      next[idx].name = (name || '').slice(0, 20);
      return next;
    });
  };

  const resetSession = () => {
    setHistory([]);
    setShowAnswer(false);
    setPending(null);
    setTurn(0);
    setDice(1 + Math.floor(rng() * 6));
    setNotice('🎉 New game! Roll the dice.');
    setPlayers((ps) => ps.map((p, i) => ({ ...p, pos: 0, skip: 0, name: p.name || `P${i + 1}` })));
    spawnBurst('✨', 10);
  };

  const setBoardSizeAndReset = (n) => {
    const s = clamp(n, 40, 100);
    setBoardSize(s);
    setPending(null);
    setTurn(0);
    setDice(1 + Math.floor(rng() * 6));
    setHistory([]);
    setShowAnswer(false);
    setNotice(`🎲 Board ${s}`);
    setPlayers((ps) => ps.map((p, i) => ({ ...p, pos: 0, skip: 0, name: p.name || `P${i + 1}` })));
  };

  const togglePack = (name) => {
    setSelectedPacks((prev) => {
      const set = new Set(prev || []);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      return Array.from(set);
    });
  };

  const toggleLevel = (lv) => {
    setSelectedLevels((prev) => {
      const set = new Set(prev || []);
      if (set.has(lv)) set.delete(lv);
      else set.add(lv);
      return Array.from(set);
    });
  };

  const drawTask = (rollValue) => {
    const recent = history.slice(0, 4).map((h) => h.type);
    const counts = recent.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});

    const candidates = filtered.filter((t) => !history.slice(0, 12).some((h) => h.id === t.id));
    const pool = candidates.length ? candidates : filtered;

    return weightedPick(rng, pool, (t) => {
      const base = DEFAULT_TYPE_WEIGHTS[t.type] || 1;
      const penalty = 1 / (1 + (counts[t.type] || 0));
      const spice =
        rollValue === 6 && t.type === 'speaking'
          ? 1.35
          : rollValue === 1 && t.type === 'error_correction'
          ? 1.3
          : 1;
      return base * penalty * spice;
    });
  };

  const rollAnimated = async () => {
    setRolling(true);
    await playSfx('roll');
    let val = dice;
    const spins = 8;
    for (let i = 0; i < spins; i++) {
      val = 1 + Math.floor(rng() * 6);
      setDice(val);
      await sleep(70);
    }
    setRolling(false);
    return val;
  };

  const rollAndDraw = async () => {
    if (animating || rolling || winnerIdx >= 0) return;
    if (!filtered.length || !players.length) return;

    // skip-turn effect
    const currentPlayer = players[turn];
    if ((currentPlayer?.skip || 0) > 0) {
      setPlayers((ps) => {
        const next = ps.map((p) => ({ ...p }));
        if (next[turn]) next[turn].skip = Math.max(0, (next[turn].skip || 0) - 1);
        return next;
      });
      setTurn((t) => (players.length ? (t + 1) % players.length : 0));
      setNotice(`🧊 ${currentPlayer.name} skips this turn`);
      await playSfx('freeze');
      return;
    }

    const value = await rollAnimated();
    const picked = drawTask(value);

    setShowAnswer(false);
    setHistory((h) => [picked, ...h].slice(0, 60));
    setPending({ roll: value, taskId: picked.id });
    setNotice(`${TYPE_ICON[picked.type] || '🎯'} ${typeLabel(picked.type)}`);
  };

  const applySpecial = async (pos) => {
    const kind = specials[pos];
    if (!kind) return pos;

    const start = pos;
    let end = pos;

    if (kind === 'boost') {
      end = clamp(start + 2, 1, boardSize);
      if (end > boardSize) end = start;
      setNotice('⭐ Boost +2');
      spawnBurst('⭐', 12);
      await beep(740, 90, 'triangle', 0.05);
    } else if (kind === 'trap') {
      end = clamp(start - 2, 1, boardSize);
      setNotice('⚠️ Trap -2');
      spawnBurst('💥', 10);
      await beep(300, 110, 'sawtooth', 0.045);
    } else if (kind === 'freeze') {
      setPlayers((ps) => {
        const next = ps.map((p) => ({ ...p }));
        if (next[turn]) next[turn].skip = 1;
        return next;
      });
      setNotice('🧊 Freeze! Skip next turn');
      spawnBurst('🧊', 8);
      await playSfx('freeze');
    } else if (kind === 'lucky') {
      end = clamp(start + 1, 1, boardSize);
      setNotice('🍀 Lucky +1');
      spawnBurst('🍀', 10);
      await beep(830, 90, 'sine', 0.05);
    }

    if (end !== start) {
      const step = end > start ? 1 : -1;
      for (let p = start + step; step > 0 ? p <= end : p >= end; p += step) {
        setPlayers((ps) => {
          const next = ps.map((x) => ({ ...x }));
          if (next[turn]) next[turn].pos = p;
          return next;
        });
        await sleep(120);
      }
    }

    return end;
  };

  const applyMove = async (success) => {
    if (!pending || !current || animating || rolling || winnerIdx >= 0) return;

    setAnimating(true);

    try {
      if (success) {
        await playSfx('success');

        const startPos = players[turn]?.pos || 0;
        let target = startPos + pending.roll;

        // exact landing rule
        if (target > boardSize) target = startPos;

        if (target !== startPos) {
          for (let pos = startPos + 1; pos <= target; pos++) {
            setPlayers((ps) => {
              const next = ps.map((p) => ({ ...p }));
              if (next[turn]) next[turn].pos = pos;
              return next;
            });
            await sleep(150);
          }
        } else {
          setNotice('⛔ Need exact roll');
          await sleep(140);
        }

        // snake / ladder
        const jumped = jumps[target];
        let finalPos = target;
        if (jumped && jumped !== target) {
          if (jumped > target) {
            setNotice('🪜 Ladder!');
            spawnBurst('🪜', 12);
            await playSfx('ladder');
          } else {
            setNotice('🐍 Snake!');
            spawnBurst('🐍', 10);
            await playSfx('snake');
          }

          await sleep(220);
          setPlayers((ps) => {
            const next = ps.map((p) => ({ ...p }));
            if (next[turn]) next[turn].pos = jumped;
            return next;
          });
          finalPos = jumped;
          await sleep(220);
        }

        // special cell
        finalPos = await applySpecial(finalPos);

        if (finalPos === boardSize) {
          const name = players[turn]?.name || `P${turn + 1}`;
          setNotice(`🏆 ${name} wins!`);
          spawnBurst('🎉', 20);
          await playSfx('win');
        }
      } else {
        await playSfx('fail');
        setNotice('❌ Stay put');
      }

      setTurn((t) => (players.length ? (t + 1) % players.length : 0));
      setPending(null);
    } finally {
      setAnimating(false);
    }
  };

  const selectedPackLabel = selectedPacks.length
    ? selectedPacks.length === 1
      ? selectedPacks[0]
      : `Mix ×${selectedPacks.length}`
    : 'All packs';

  const selectedLevelLabel = selectedLevels.length
    ? selectedLevels.length === 1
      ? selectedLevels[0]
      : `Lv ×${selectedLevels.length}`
    : 'All lv';

  return (
    <div className="gamePage">
      <header className="hudBar">
        <div className="brandBlock">
          <div className="brandIcon">🐍🪜🎲</div>
          <div>
            <div className="brandTitle">Snakes & Ladders ESL</div>
            <div className="brandSub">Play • Speak • Learn</div>
          </div>
        </div>

        <div className="hudActions">
          <button className="iconBtn" onClick={() => setSoundOn((v) => !v)} title="Sound">
            {soundOn ? '🔊' : '🔈'}
          </button>
          <button className="iconBtn" onClick={resetSession} title="New game">
            🆕
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="leftPane">
          <div className="miniStats cardy">
            <div className="pill">{selectedPackLabel}</div>
            <div className="pill">{selectedLevelLabel}</div>
            <div className="pill">🎯 {filtered.length}</div>
          </div>

          <details className="picker cardy">
            <summary>🎒 Packs</summary>
            <div className="pickerGrid">
              {packs.map((p) => {
                const checked = selectedPacks.includes(p.name);
                return (
                  <button key={p.name} className={`chip ${checked ? 'on' : ''}`} onClick={() => togglePack(p.name)}>
                    <span>{p.name}</span>
                    <em>{p.count}</em>
                  </button>
                );
              })}
            </div>
            <div className="pickerActions">
              <button className="chipAction" onClick={() => setSelectedPacks([])}>Clear</button>
              <button className="chipAction" onClick={() => setSelectedPacks(packs.map((p) => p.name))}>All</button>
            </div>
          </details>

          <details className="picker cardy">
            <summary>📚 Levels</summary>
            <div className="pickerGrid levels">
              {levels.map((lv) => {
                const checked = selectedLevels.includes(lv);
                return (
                  <button key={lv} className={`chip ${checked ? 'on' : ''}`} onClick={() => toggleLevel(lv)}>
                    <span>{lv}</span>
                  </button>
                );
              })}
            </div>
            <div className="pickerActions">
              <button className="chipAction" onClick={() => setSelectedLevels([])}>Clear</button>
              <button className="chipAction" onClick={() => setSelectedLevels(levels.slice())}>All</button>
            </div>
          </details>

          <div className="players cardy">
            <div className="playersHead">
              <span>👥</span>
              <select value={numPlayers} onChange={(e) => setPlayerCount(parseInt(e.target.value, 10))}>
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>{n}P</option>
                ))}
              </select>
              <select value={boardSize} onChange={(e) => setBoardSizeAndReset(parseInt(e.target.value, 10))}>
                {[40, 50, 60, 70, 80, 90, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>

            <div className="nameRows">
              {players.map((p, i) => (
                <label key={i} className={`nameRow ${i === turn ? 'active' : ''}`}>
                  <span className="nameLead">
                    <PlayerChip idx={i} active={i === turn} tiny />
                    <span className="monoTiny">{p.pos}</span>
                    {(p.skip || 0) > 0 ? <span title="Skip next turn">🧊</span> : null}
                  </span>
                  <input value={p.name || ''} onChange={(e) => setPlayerName(i, e.target.value)} />
                </label>
              ))}
            </div>
          </div>

          <div className="taskCard cardy">
            <div className="taskTop">
              <div className="taskType">{current ? `${TYPE_ICON[current.type] || '🎯'} ${typeLabel(current.type)}` : '🎯 Task'}</div>
              <button className="tinyBtn" onClick={() => setShowAnswer((v) => !v)} disabled={!current || !current.target}>
                {showAnswer ? '🙈' : '💡'}
              </button>
            </div>

            <div className="taskPrompt">
              {loading ? 'Loading…' : error ? 'Could not load tasks' : current ? current.prompt : 'Tap 🎲'}
            </div>

            {showAnswer && current?.target ? <div className="taskAnswer">{current.target}</div> : null}

            <div className="taskBottom">
              {current?.grammarTags?.slice(0, 3).map((t) => (
                <span key={t} className="miniTag">{t}</span>
              ))}
            </div>
          </div>

          <div className="actionBar cardy">
            <Dice value={dice} rolling={rolling} />
            <button
              className="goBtn"
              onClick={rollAndDraw}
              disabled={loading || !!error || !filtered.length || winnerIdx >= 0 || animating || rolling}
            >
              🎲
            </button>
            <button className="okBtn" onClick={() => applyMove(true)} disabled={!pending || winnerIdx >= 0 || animating || rolling}>
              ✅
            </button>
            <button className="noBtn" onClick={() => applyMove(false)} disabled={!pending || winnerIdx >= 0 || animating || rolling}>
              ❌
            </button>
          </div>

          <div className="notice cardy" role="status">{notice}</div>

          {winnerIdx >= 0 ? <div className="winner cardy">🏆 {players[winnerIdx]?.name || `P${winnerIdx + 1}`}!</div> : null}

          {error ? <div className="error cardy">⚠️ {error}</div> : null}
        </section>

        <section className="boardPane">
          <div className="boardShell cardy">
            <div
              className="boardGrid"
              ref={boardGridRef}
              role="grid"
              aria-label="Snakes and Ladders board"
              style={{ gridTemplateColumns: 'repeat(10, 1fr)', gridTemplateRows: `repeat(${rows}, 1fr)` }}
            >
              <JumpOverlay boardRef={boardGridRef} jumps={jumps} />
              {boardCells.map((n, idx) => {
                if (n == null) return <div key={`blank-${idx}`} className="cell blank" />;

                const occupants = players
                  .map((p, i) => ({ i, on: p.pos === n }))
                  .filter((x) => x.on)
                  .map((x) => x.i);

                const isTurnCell = players[turn]?.pos === n;
                const jumpTo = jumps[n];
                const jumpKind = jumpTo ? (jumpTo > n ? 'ladder' : 'snake') : '';
                const special = specials[n] || '';

                return (
                  <div
                    key={n}
                    className={`cell ${jumpKind} ${special} ${isTurnCell ? 'turnCell' : ''}`}
                    role="gridcell"
                    data-cell-number={n}
                  >
                    <div className="cellNum">{n}</div>
                    {n === boardSize ? <div className="cellWin">🏁</div> : null}
                    {!jumpTo && special ? (
                      <div className="cellIcon">
                        {special === 'boost' ? '⭐' : special === 'trap' ? '⚠️' : special === 'freeze' ? '🧊' : '🍀'}
                      </div>
                    ) : null}
                    <div className="cellOcc">
                      {occupants.map((i) => (
                        <PlayerChip key={i} idx={i} active={i === turn} tiny />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="burstLayer" aria-hidden>
              {bursts.map((b) => (
                <span
                  key={b.id}
                  className="burst"
                  style={{
                    left: `${b.x}%`,
                    top: `${b.y}%`,
                    '--dx': `${b.dx}px`,
                    '--dy': `${b.dy}px`,
                    '--rot': `${b.rot}deg`,
                    '--life': `${b.life}ms`,
                  }}
                >
                  {b.emoji}
                </span>
              ))}
            </div>
          </div>

          <div className="legend cardy">
            <span>🪜 up</span>
            <span>🐍 down</span>
            <span>⭐ +2</span>
            <span>⚠️ -2</span>
            <span>🧊 skip</span>
            <span>🍀 +1</span>
          </div>

          <details className="history cardy">
            <summary>🧾 Last draws ({history.length})</summary>
            <div className="historyList">
              {history.slice(0, 12).map((t) => (
                <button
                  key={`${t.id}-${t.prompt}`}
                  className="historyItem"
                  onClick={() => {
                    setShowAnswer(false);
                    setHistory((h) => [t, ...h.filter((x) => x !== t)]);
                  }}
                >
                  <span>{TYPE_ICON[t.type] || '🎯'}</span>
                  <span>{t.prompt}</span>
                </button>
              ))}
            </div>
          </details>
        </section>
      </main>
    </div>
  );
}
