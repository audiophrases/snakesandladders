import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { DEFAULT_TYPE_WEIGHTS, TASKS_CSV_URL } from './config';
import { fetchTasks, listGamePacks, weightedPick } from './tasks';

const STORAGE_KEY = 'snl_party_v4';
const DEFAULT_BOARD_SIZE = 60;

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

// Translation types carry no icon: the CA/EN initials in typeLabel say it
// better than a picture of food.
const TYPE_ICON = {
  speaking: '🗣️',
  error_correction: '🛠️',
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
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

function isTranslation(t) {
  return t === 'translate_ca_en' || t === 'translate_en_ca';
}

function typeIcon(t) {
  if (isTranslation(t)) return '';
  return TYPE_ICON[t] || '🎯';
}

// Icon plus label, minus the icon for translations so it reads "EN → CA"
// rather than repeating itself.
function typeBadge(t) {
  const icon = typeIcon(t);
  return icon ? `${icon} ${typeLabel(t)}` : typeLabel(t);
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

function Dice({ value, phase = 'idle' }) {
  return (
    <div
      className={`dice ${phase === 'idle' ? '' : `dice-${phase}`}`}
      role="img"
      aria-label={`Dice ${value}`}
    >
      <div className={`pipgrid pips-${value}`}>
        {Array.from({ length: 9 }).map((_, i) => (
          <span key={i} className="pip" />
        ))}
      </div>
    </div>
  );
}

function jumpSeed(s, e) {
  return mulberry32((((s + 1) * 73856093) ^ ((e + 1) * 19349663)) >>> 0)();
}

function cubicAt(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const w0 = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * c1.x + w2 * c2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * c1.y + w2 * c2.y + w3 * p3.y,
  };
}

function cubicTangent(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const w0 = 3 * mt * mt;
  const w1 = 6 * mt * t;
  const w2 = 3 * t * t;
  return {
    x: w0 * (c1.x - p0.x) + w1 * (c2.x - c1.x) + w2 * (p3.x - c2.x),
    y: w0 * (c1.y - p0.y) + w1 * (c2.y - c1.y) + w2 * (p3.y - c2.y),
  };
}

// Width stays near full through the front half, then tapers to a point at the tail.
function taperProfile(t) {
  if (t < 0.5) return 1 - t * 0.22;
  const k = (t - 0.5) / 0.5;
  return 0.75 * (1 - Math.pow(k, 1.7)) + 0.14;
}

// Snake bodies need a real taper, and SVG strokes cannot taper. Sample the
// centerline and emit a closed outline instead.
function taperedOutline(p0, c1, c2, p3, width, steps = 40) {
  const left = [];
  const right = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = cubicAt(p0, c1, c2, p3, t);
    const d = cubicTangent(p0, c1, c2, p3, t);
    const l = Math.hypot(d.x, d.y) || 1;
    const nx = -d.y / l;
    const ny = d.x / l;
    const hw = (width * taperProfile(t)) / 2;
    left.push(`${(p.x + nx * hw).toFixed(2)} ${(p.y + ny * hw).toFixed(2)}`);
    right.push(`${(p.x - nx * hw).toFixed(2)} ${(p.y - ny * hw).toFixed(2)}`);
  }

  return `M ${left.join(' L ')} L ${right.reverse().join(' L ')} Z`;
}

// Geometry is shared by the under-layer (bodies, rails) and the over-layer
// (heads, feet), so both draw from one pass.
function buildJumpGeometry(jumps, points, cellMin) {
  const out = [];

  Object.entries(jumps).forEach(([sStr, e]) => {
    const s = Number(sStr);
    const A = points[s];
    const B = points[e];
    if (!A || !B) return;

    const rawDx = B.x - A.x;
    const rawDy = B.y - A.y;
    const rawLen = Math.hypot(rawDx, rawDy) || 1;
    const ux = rawDx / rawLen;
    const uy = rawDy / rawLen;

    // Pull the endpoints off the cell centre so the art clears the cell number
    // and the player chips.
    const inset = Math.min(cellMin * 0.2, rawLen * 0.28);
    const a = { x: A.x + ux * inset, y: A.y + uy * inset };
    const b = { x: B.x - ux * inset, y: B.y - uy * inset };

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;

    out.push({
      s,
      e,
      a,
      b,
      len,
      nx: -dy / len,
      ny: dx / len,
      ladder: e > s,
    });
  });

  return out;
}

function ladderParts(g, cellMin) {
  const { a, b, len, nx, ny } = g;
  const railW = clamp(cellMin * 0.075, 2.4, 5);
  // Slight convergence toward the top reads as perspective.
  const baseOff = clamp(len * 0.075, cellMin * 0.16, cellMin * 0.34);
  const topOff = baseOff * 0.82;

  const rails = [
    [a.x + nx * baseOff, a.y + ny * baseOff, b.x + nx * topOff, b.y + ny * topOff],
    [a.x - nx * baseOff, a.y - ny * baseOff, b.x - nx * topOff, b.y - ny * topOff],
  ];

  const rungCount = clamp(Math.round(len / (cellMin * 0.62)), 3, 9);
  const rungs = [];
  for (let i = 1; i <= rungCount; i++) {
    const t = i / (rungCount + 1);
    const off = baseOff + (topOff - baseOff) * t;
    const cx = a.x + (b.x - a.x) * t;
    const cy = a.y + (b.y - a.y) * t;
    rungs.push([cx + nx * off, cy + ny * off, cx - nx * off, cy - ny * off]);
  }

  return { railW, rails, rungs };
}

function snakeParts(g, cellMin) {
  const { s, e, a, b, len, nx, ny } = g;
  const r = jumpSeed(s, e);
  const sign = r < 0.5 ? -1 : 1;
  // Seeded so jumps sharing a corridor bend apart, and so a given board always
  // renders identically.
  const amp = sign * clamp(len * 0.13 + cellMin * r * 0.5, cellMin * 0.4, cellMin * 1.5);

  const c1 = { x: a.x + (b.x - a.x) * 0.3 + nx * amp, y: a.y + (b.y - a.y) * 0.3 + ny * amp };
  const c2 = { x: a.x + (b.x - a.x) * 0.7 - nx * amp, y: a.y + (b.y - a.y) * 0.7 - ny * amp };

  const bodyW = clamp(cellMin * 0.19, 5, 13);
  const centerline = `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)}, ${c2.x.toFixed(2)} ${c2.y.toFixed(2)}, ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
  const outline = taperedOutline(a, c1, c2, b, bodyW);

  // The head belongs on the high square — that is the one that swallows you.
  const t0 = cubicTangent(a, c1, c2, b, 0);
  const tl = Math.hypot(t0.x, t0.y) || 1;
  const fx = -t0.x / tl;
  const fy = -t0.y / tl;
  const hx = -fy;
  const hy = fx;

  const headLen = bodyW * 1.45;
  const headW = bodyW * 1.15;
  const tip = { x: a.x + fx * headLen, y: a.y + fy * headLen };
  const shoulder = headLen * 0.86;

  const head = [
    `M ${(a.x + hx * (headW / 2)).toFixed(2)} ${(a.y + hy * (headW / 2)).toFixed(2)}`,
    `Q ${(a.x + fx * shoulder + hx * headW * 0.52).toFixed(2)} ${(a.y + fy * shoulder + hy * headW * 0.52).toFixed(2)}`,
    `${tip.x.toFixed(2)} ${tip.y.toFixed(2)}`,
    `Q ${(a.x + fx * shoulder - hx * headW * 0.52).toFixed(2)} ${(a.y + fy * shoulder - hy * headW * 0.52).toFixed(2)}`,
    `${(a.x - hx * (headW / 2)).toFixed(2)} ${(a.y - hy * (headW / 2)).toFixed(2)}`,
    'Z',
  ].join(' ');

  const eyeR = Math.max(1.1, bodyW * 0.17);
  const eyes = [1, -1].map((side) => ({
    x: a.x + fx * headLen * 0.38 + hx * side * headW * 0.27,
    y: a.y + fy * headLen * 0.38 + hy * side * headW * 0.27,
  }));

  const tongueLen = bodyW;
  const forkAt = { x: tip.x + fx * tongueLen * 0.55, y: tip.y + fy * tongueLen * 0.55 };
  const tongue = [
    `M ${tip.x.toFixed(2)} ${tip.y.toFixed(2)} L ${forkAt.x.toFixed(2)} ${forkAt.y.toFixed(2)}`,
    `M ${forkAt.x.toFixed(2)} ${forkAt.y.toFixed(2)} L ${(forkAt.x + fx * tongueLen * 0.45 + hx * tongueLen * 0.34).toFixed(2)} ${(forkAt.y + fy * tongueLen * 0.45 + hy * tongueLen * 0.34).toFixed(2)}`,
    `M ${forkAt.x.toFixed(2)} ${forkAt.y.toFixed(2)} L ${(forkAt.x + fx * tongueLen * 0.45 - hx * tongueLen * 0.34).toFixed(2)} ${(forkAt.y + fy * tongueLen * 0.45 - hy * tongueLen * 0.34).toFixed(2)}`,
  ].join(' ');

  return { bodyW, centerline, outline, head, eyes, eyeR, tongue };
}

function useBoardLayout(boardRef, jumps, cellMap, rows, cols) {
  const [layout, setLayout] = useState({ width: 0, height: 0, points: {}, cellMin: 0 });
  // The overlays live inside the board, so their own renders trip the
  // MutationObserver. Only commit when the measurement actually moved.
  const lastSig = useRef('');

  useLayoutEffect(() => {
    let raf = 0;
    let retryTimer = 0;
    let ro = null;
    let mo = null;
    let onResize = null;
    let disposed = false;

    const measure = (boardEl, retry = 0) => {
      if (disposed) return;

      const rect = boardEl.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        if (retry < 6) raf = requestAnimationFrame(() => measure(boardEl, retry + 1));
        return;
      }

      const uniqueCells = new Set();
      Object.entries(jumps).forEach(([s, e]) => {
        uniqueCells.add(Number(s));
        uniqueCells.add(Number(e));
      });

      const points = {};
      const style = window.getComputedStyle(boardEl);
      const colGap = parseFloat(style.columnGap || style.gap || '0') || 0;
      const rowGap = parseFloat(style.rowGap || style.gap || '0') || 0;
      const cellW = (rect.width - (cols - 1) * colGap) / cols;
      const cellH = (rect.height - (rows - 1) * rowGap) / rows;

      uniqueCells.forEach((cell) => {
        const el = boardEl.querySelector(`[data-cell-number="${cell}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          points[cell] = {
            x: r.left - rect.left + r.width / 2,
            y: r.top - rect.top + r.height / 2,
          };
          return;
        }

        const gc = cellMap?.get?.(cell);
        if (!gc) return;
        points[cell] = {
          x: gc.col * (cellW + colGap) + cellW / 2,
          y: gc.row * (cellH + rowGap) + cellH / 2,
        };
      });

      const cellMin = Math.max(1, Math.min(cellW, cellH));
      const sig = `${rect.width.toFixed(1)}|${rect.height.toFixed(1)}|${cellMin.toFixed(1)}|${Object.keys(points)
        .sort((x, y) => Number(x) - Number(y))
        .map((k) => `${k}:${points[k].x.toFixed(1)},${points[k].y.toFixed(1)}`)
        .join(';')}`;

      if (sig !== lastSig.current) {
        lastSig.current = sig;
        setLayout({ width: rect.width, height: rect.height, points, cellMin });
      }

      // Initial mount can race with DOM/layout in some browsers; retry a few frames
      // if not enough endpoints were captured yet.
      if (Object.keys(points).length < 4 && retry < 6) {
        raf = requestAnimationFrame(() => measure(boardEl, retry + 1));
      }
    };

    // React attaches a parent's ref after this child's layout effect runs, so the
    // board element is not there yet on first mount. Wait for it instead of
    // bailing out — the effect deps never change, so bailing meant never drawing.
    const attach = (tries = 0) => {
      if (disposed) return;

      const boardEl = boardRef.current;
      if (!boardEl) {
        if (tries < 30) raf = requestAnimationFrame(() => attach(tries + 1));
        return;
      }

      const requestMeasure = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => measure(boardEl, 0));
      };

      requestMeasure();
      retryTimer = window.setTimeout(requestMeasure, 120);

      ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(requestMeasure) : null;
      if (ro) ro.observe(boardEl);

      mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(requestMeasure) : null;
      if (mo) mo.observe(boardEl, { childList: true, subtree: true });

      onResize = requestMeasure;
      window.addEventListener('resize', onResize);
    };

    attach();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(retryTimer);
      if (ro) ro.disconnect();
      if (mo) mo.disconnect();
      if (onResize) window.removeEventListener('resize', onResize);
    };
  }, [boardRef, jumps, cellMap, rows, cols]);

  return layout;
}

// Long connectors sit under the cells (cell backgrounds are translucent, so they
// stay readable) and heads/feet sit above, so nothing paints over a cell number.
function JumpOverlay({ boardRef, jumps, cellMap, rows, cols = 10, activeJumps = null, layer = 'under' }) {
  const layout = useBoardLayout(boardRef, jumps, cellMap, rows, cols);

  const geometry = useMemo(
    () => (layout.width ? buildJumpGeometry(jumps, layout.points, layout.cellMin) : []),
    [jumps, layout],
  );

  if (!layout.width || !layout.height) return null;

  const under = layer === 'under';
  const suffix = under ? 'u' : 'o';

  return (
    <svg
      className={`jumpOverlay ${under ? 'jumpUnder' : 'jumpOver'}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      <defs>
        <linearGradient id={`ladderWood-${suffix}`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="var(--ladder-dark)" />
          <stop offset="55%" stopColor="var(--ladder)" />
          <stop offset="100%" stopColor="var(--ladder-lit)" />
        </linearGradient>
        <linearGradient id={`snakeSkin-${suffix}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--snake-lit)" />
          <stop offset="60%" stopColor="var(--snake)" />
          <stop offset="100%" stopColor="var(--snake-dark)" />
        </linearGradient>
      </defs>

      {geometry.map((g) => {
        const isolating = !!(activeJumps && activeJumps.length);
        const hot = isolating && activeJumps.includes(g.s);
        const cls = `jumpG ${g.ladder ? 'ladderPath' : 'snakePath'}${
          isolating && !hot ? ' dim' : ''
        }${hot ? ' hot' : ''}`;

        if (g.ladder) {
          const { railW, rails, rungs } = ladderParts(g, layout.cellMin);

          if (!under) {
            // Ladders draw entirely on the under-layer: feet land in the same
            // corner as the endpoint badge, and above the cells they covered it.
            return null;
          }

          return (
            <g key={`${g.s}-${g.e}`} className={cls}>
              {rails.map(([x1, y1, x2, y2], i) => (
                <line key={`rail-halo-${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="jumpHalo" strokeWidth={railW + 2.2} strokeLinecap="round" />
              ))}
              {rungs.map(([x1, y1, x2, y2], i) => (
                <line key={`rung-halo-${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="jumpHalo" strokeWidth={railW * 0.78 + 1.6} strokeLinecap="round" />
              ))}
              {rungs.map(([x1, y1, x2, y2], i) => (
                <line key={`rung-${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="ladderRung" strokeWidth={railW * 0.78} strokeLinecap="round" />
              ))}
              {rails.map(([x1, y1, x2, y2], i) => (
                <line
                  key={`rail-${i}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={`url(#ladderWood-${suffix})`}
                  strokeWidth={railW}
                  strokeLinecap="round"
                  fill="none"
                />
              ))}
              {rails.map(([x1, y1, x2, y2], i) => (
                <g key={`end-${i}`}>
                  <circle cx={x1} cy={y1} r={railW * 0.85} className="ladderFoot" />
                  <circle cx={x2} cy={y2} r={railW * 0.68} className="ladderCap" />
                </g>
              ))}
              <title>{`Ladder: ${g.s} up to ${g.e}`}</title>
            </g>
          );
        }

        const sp = snakeParts(g, layout.cellMin);

        if (!under) {
          return (
            <g key={`${g.s}-${g.e}`} className={cls}>
              <path d={sp.tongue} className="snakeTongue" strokeWidth={Math.max(1, sp.bodyW * 0.16)} strokeLinecap="round" fill="none" />
              <path d={sp.head} className="jumpHalo" strokeWidth={2.4} strokeLinejoin="round" />
              <path d={sp.head} fill={`url(#snakeSkin-${suffix})`} strokeLinejoin="round" />
              {sp.eyes.map((p, i) => (
                <g key={i}>
                  <circle cx={p.x} cy={p.y} r={sp.eyeR} className="snakeEye" />
                  <circle cx={p.x} cy={p.y} r={sp.eyeR * 0.45} className="snakePupil" />
                </g>
              ))}
            </g>
          );
        }

        return (
          <g key={`${g.s}-${g.e}`} className={cls}>
            <path d={sp.outline} className="jumpHalo" strokeWidth={2.6} strokeLinejoin="round" />
            <path d={sp.outline} fill={`url(#snakeSkin-${suffix})`} strokeLinejoin="round" />
            <path
              d={sp.centerline}
              className="snakeScales"
              strokeWidth={sp.bodyW * 0.5}
              strokeDasharray={`${(sp.bodyW * 0.42).toFixed(2)} ${(sp.bodyW * 0.78).toFixed(2)}`}
              strokeLinecap="round"
              fill="none"
            />
            <title>{`Snake: ${g.s} down to ${g.e}`}</title>
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
  const [dicePhase, setDicePhase] = useState('idle'); // idle | throw | land
  const landTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(landTimer.current), []);
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
  const numberToGrid = useMemo(() => buildNumberToGrid(boardCells, 10), [boardCells]);
  const jumps = useMemo(() => buildJumps(boardSize), [boardSize]);
  const specials = useMemo(() => buildSpecialCells(boardSize, jumps), [boardSize, jumps]);

  // Both ends of a jump need a marker: without one, the landing square is
  // unlabelled and players have to trace the curve to find it. A square can
  // collect more than one arrival (on a 70 board, a ladder from 28 and a snake
  // from 45 both land on 41), so every role is kept, not just the first.
  const jumpRoles = useMemo(() => {
    const map = new Map();
    const push = (cell, role) => {
      const list = map.get(cell);
      if (list) list.push(role);
      else map.set(cell, [role]);
    };

    Object.entries(jumps).forEach(([sStr, e]) => {
      const s = Number(sStr);
      const kind = e > s ? 'ladder' : 'snake';
      push(s, { kind, pos: 'start', partner: e, jump: s });
      push(e, { kind, pos: 'end', partner: s, jump: s });
    });

    // Starts first, so the square's own exit reads before its arrivals.
    map.forEach((list) => list.sort((a, b) => (a.pos === b.pos ? a.partner - b.partner : a.pos === 'start' ? -1 : 1)));
    return map;
  }, [jumps]);

  // Hover previews a jump; a tap pins it, so touch devices (which never hover)
  // get the same isolation. A pin wins over whatever is hovered.
  const [hoverJumps, setHoverJumps] = useState(null);
  const [pinnedJumps, setPinnedJumps] = useState(null);
  const activeJumps = pinnedJumps || hoverJumps;

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
      // Clicks thin out in step with the tumble slowing down.
      const gaps = [0, 90, 105, 130, 165, 210, 260, 320, 380];
      const tones = [300, 360, 330, 400, 350, 430, 380, 450, 410];
      for (let i = 0; i < gaps.length; i++) {
        if (gaps[i]) await sleep(gaps[i]);
        await beep(tones[i], 55, 'triangle', 0.035);
      }
      return;
    }
    if (kind === 'land') {
      await beep(180, 130, 'triangle', 0.05);
      await beep(520, 70, 'sine', 0.03);
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
    window.clearTimeout(landTimer.current);
    setDicePhase('idle');
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
    window.clearTimeout(landTimer.current);
    setDicePhase('idle');
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
    const reduced = prefersReducedMotion();

    // Decide the result up front so the animation can never bias it: the
    // in-between faces skip repeats, and that filtering must not touch the roll.
    const finalVal = 1 + Math.floor(rng() * 6);

    window.clearTimeout(landTimer.current);
    setRolling(true);
    setDicePhase('throw');
    // Not awaited: the rattle should run under the tumble, not delay it.
    void playSfx('roll');

    const steps = reduced ? 3 : 15;
    let shown = dice;

    for (let i = 0; i < steps; i++) {
      const isLast = i === steps - 1;
      // A repeat reads as a dropped frame rather than a tumble, and the last
      // in-between face must differ from the result so the landing is visible.
      // Only the in-between faces are constrained; finalVal was drawn fairly.
      let next = 1 + Math.floor(rng() * 6);
      for (let guard = 0; guard < 12; guard++) {
        if (next !== shown && !(isLast && next === finalVal)) break;
        next = 1 + Math.floor(rng() * 6);
      }
      shown = next;
      setDice(shown);

      // Faces slow from ~50ms to ~250ms, so the die visibly loses energy
      // instead of stopping dead. Roughly 1.7s in total.
      const t = steps > 1 ? i / (steps - 1) : 1;
      await sleep(reduced ? 55 : 50 + Math.pow(t, 2.2) * 200);
    }

    setDice(finalVal);
    setDicePhase('land');
    setRolling(false);
    void playSfx('land');
    landTimer.current = window.setTimeout(() => setDicePhase('idle'), reduced ? 140 : 380);

    return finalVal;
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
    setNotice(typeBadge(picked.type));
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
              <div className="taskType">{current ? typeBadge(current.type) : '🎯 Task'}</div>
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
            <Dice value={dice} phase={dicePhase} />
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
              {boardCells.map((n, idx) => {
                if (n == null) return <div key={`blank-${idx}`} className="cell blank" />;

                const occupants = players
                  .map((p, i) => ({ i, on: p.pos === n }))
                  .filter((x) => x.on)
                  .map((x) => x.i);

                const isTurnCell = players[turn]?.pos === n;
                const roles = jumpRoles.get(n);
                const special = specials[n] || '';
                const roleClass = roles
                  ? [...new Set(roles.map((r) => `${r.kind}${r.pos === 'start' ? 'Start' : 'End'}`))].join(' ')
                  : '';
                const label = roles
                  ? `Cell ${n}, ${roles
                      .map((r) => `${r.kind} ${r.pos === 'start' ? `to ${r.partner}` : `from ${r.partner}`}`)
                      .join(', ')}`
                  : `Cell ${n}`;
                const cellJumps = roles ? roles.map((r) => r.jump) : null;
                const isHot = !!(activeJumps && cellJumps && cellJumps.some((j) => activeJumps.includes(j)));
                // Touch has no hover, so a tap toggles the same isolation.
                const togglePin = cellJumps
                  ? () => setPinnedJumps((cur) => (cur && cur[0] === cellJumps[0] ? null : cellJumps))
                  : undefined;

                return (
                  <div
                    key={n}
                    className={`cell ${roleClass} ${special} ${isTurnCell ? 'turnCell' : ''} ${
                      isHot ? 'jumpHot' : ''
                    }`}
                    role="gridcell"
                    aria-label={label}
                    data-cell-number={n}
                    onMouseEnter={cellJumps ? () => setHoverJumps(cellJumps) : undefined}
                    onMouseLeave={cellJumps ? () => setHoverJumps(null) : undefined}
                    onClick={togglePin}
                  >
                    <div className="cellNum">{n}</div>
                    {n === boardSize ? <div className="cellWin">🏁</div> : null}
                    {roles ? (
                      <div className={`cellJumps ${roles.length > 1 ? 'multi' : ''}`}>
                        {roles.map((r) => (
                          <span key={`${r.jump}-${r.pos}`} className={`cellJump ${r.kind} ${r.pos}`}>
                            <span className="cellJumpGlyph">{r.kind === 'ladder' ? '🪜' : '🐍'}</span>
                            <span className="cellJumpNum">
                              {r.pos === 'start' ? `→${r.partner}` : `←${r.partner}`}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : special ? (
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
              <JumpOverlay
                boardRef={boardGridRef}
                jumps={jumps}
                cellMap={numberToGrid}
                rows={rows}
                cols={10}
                activeJumps={activeJumps}
                layer="under"
              />
              <JumpOverlay
                boardRef={boardGridRef}
                jumps={jumps}
                cellMap={numberToGrid}
                rows={rows}
                cols={10}
                activeJumps={activeJumps}
                layer="over"
              />
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
                  <span className="historyTag">{typeIcon(t.type) || typeLabel(t.type)}</span>
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
