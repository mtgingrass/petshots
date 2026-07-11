// Hand-rolled charts for the Trends tab — no charting library in the project
// (bundle size), and the rest of the app already hand-rolls its own SVGs
// (TabBar icons) rather than pulling in dependencies for small visual
// pieces. Visual language borrows from health-tracker dashboards (gradient
// sparkline with a glowing latest-point, a colored status label under a
// headline number, a ring gauge, a gradient completion bar) — adapted to
// pet-care data, which has no real equivalent of "cardio load" or "stress,"
// so the metrics themselves stay ours (mood, weight, checklist completion).
import { useId } from 'react';
import type { TrendsSeriesPoint, TrendsChecklistDots } from '../api';

// A line + gradient-fill chart for a series with possible gaps (days
// nothing was logged). Gaps break the line rather than interpolating across
// them — a straight line through a missing week would imply data that isn't
// there. The most recent present point gets a soft glow halo.
export function Sparkline({
  points,
  width = 280,
  height = 64,
  color = 'var(--primary)',
}: {
  points: TrendsSeriesPoint[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const gradientId = useId();
  const present = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (present.length === 0) {
    return <p className="sparkline__empty">Not enough data yet</p>;
  }
  const min = Math.min(...present);
  const max = Math.max(...present);
  const span = max - min || 1;
  const pad = 6;
  const xStep = (width - pad * 2) / Math.max(points.length - 1, 1);
  const coords = points.map((p, i) =>
    p.value === null
      ? null
      : { x: pad + i * xStep, y: pad + (1 - (p.value - min) / span) * (height - pad * 2) },
  );

  // Contiguous runs of present points — each run gets its own line + fill
  // so gaps render as a real break, not a diagonal line skipping the
  // missing days.
  const runs: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  for (const c of coords) {
    if (c === null) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push(c);
    }
  }
  if (current.length) runs.push(current);

  const lastPoint = [...coords].reverse().find((c) => c !== null) ?? null;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label="Trend over time"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {runs.map((run, i) => (
        <path
          key={`fill-${i}`}
          d={`M${run.map((c) => `${c.x},${c.y}`).join(' L')} L${run[run.length - 1].x},${height - pad} L${run[0].x},${height - pad} Z`}
          fill={`url(#${gradientId})`}
        />
      ))}
      {runs.map((run, i) => (
        <polyline
          key={`line-${i}`}
          points={run.map((c) => `${c.x},${c.y}`).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {lastPoint && (
        <>
          <circle cx={lastPoint.x} cy={lastPoint.y} r={7} fill={color} opacity={0.25} />
          <circle cx={lastPoint.x} cy={lastPoint.y} r={3.5} fill={color} />
        </>
      )}
    </svg>
  );
}

// Ring gauge (CSS conic-gradient, not SVG arc math — simpler and plenty
// precise at this size) — one colored ring + a value/label pair in the
// center hole. Caller resolves the color (see statusColor()) so this stays
// a dumb rendering component.
export function GaugeDial({
  pct,
  value,
  label,
  color,
  size = 84,
}: {
  pct: number;
  value: string;
  label: string;
  color: string;
  size?: number;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="gauge-dial"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${clamped * 3.6}deg, var(--border) 0deg)`,
      }}
    >
      <div className="gauge-dial__hole">
        <span className="gauge-dial__value">{value}</span>
        <span className="gauge-dial__label" style={{ color }}>{label}</span>
      </div>
    </div>
  );
}

// A completion bar whose fill is always positioned along the SAME
// fixed red->amber->green track (a solid color mask hides the ungained
// portion from the right) — so the color at the fill edge always reflects
// where that percentage actually sits on the 0-100 scale, not a
// bar-relative gradient that would look identical at 20% and 80%.
export function PercentBar({ pct, caption }: { pct: number; caption?: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="percent-bar">
      <div className="percent-bar__track">
        <div className="percent-bar__mask" style={{ width: `${100 - clamped}%` }} />
      </div>
      <div className="percent-bar__meta">
        <span className="percent-bar__value">{clamped}%</span>
        {caption && <span className="percent-bar__caption">{caption}</span>}
      </div>
    </div>
  );
}

// One row per checklist item: label + its PercentBar.
export function ChecklistPercentRow({
  item,
  pct,
  caption,
}: {
  item: TrendsChecklistDots | { id: string; label: string };
  pct: number;
  caption?: string;
}) {
  return (
    <div className="trends-dotrow">
      <span className="trends-dotrow__label">{item.label}</span>
      <div className="trends-dotrow__bar">
        <PercentBar pct={pct} caption={caption} />
      </div>
    </div>
  );
}

// 1-5 mood scale -> a short status word + a semantic color, same spirit as
// the backend's MOOD_LABEL (infra/lambda/reminder/index.ts) but this is
// pure display, so it stays client-side rather than round-tripping copy.
const MOOD_STATUS: Record<number, { label: string; color: string }> = {
  1: { label: 'Rough', color: 'var(--overdue)' },
  2: { label: 'Off', color: 'var(--warn)' },
  3: { label: 'Okay', color: 'var(--subtle)' },
  4: { label: 'Good', color: 'var(--ok)' },
  5: { label: 'Great', color: 'var(--ok)' },
};
export function moodStatus(avg: number): { label: string; color: string } {
  return MOOD_STATUS[Math.max(1, Math.min(5, Math.round(avg)))];
}

// Generic 0-100% -> red/amber/green, for the gauge and anything else that
// wants "is this number good" at a glance.
export function statusColor(pct: number): string {
  if (pct < 50) return 'var(--overdue)';
  if (pct < 80) return 'var(--warn)';
  return 'var(--ok)';
}
