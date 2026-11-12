// Small hand-drawn charts for the monitoring screens: SVG and plain HTML, Pleat's colours only (styles.css tokens),
// no chart library. Every chart says its numbers in text too (a readout line or a legend), so colour is never the
// only way to read it; tapping or hovering a bar or point shows its exact value.
import { useState } from 'preact/hooks';
import { pctText, quotaTone } from './labels.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtN = (v) => Math.round(Number(v || 0)).toLocaleString('en-US');

// A ring for one daily allowance: the solid arc is used so far, the pale arc after it is where today's pace ends
// the day. The colour follows the larger of the two (fine / watch / near the cap) and the label says it in words.
export function Ring({ pct, proj, label, value, size = 104 }) {
  const r = 40, c = 2 * Math.PI * r;
  const used = clamp(pct || 0, 0, 100), end = proj != null ? clamp(proj, 0, 100) : used;
  const tone = quotaTone(Math.max(pct || 0, proj || 0));
  const word = { ok: 'Fine', warn: 'Watch', bad: 'Near cap' }[tone];
  return (
    <div class="ring" role="img" aria-label={`${label}: ${pctText(pct)} used${proj != null ? `, about ${pctText(proj)} by the end of the day` : ''}`}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle class="trk" cx="50" cy="50" r={r} />
        {end > used ? <circle class={'prj ' + tone} cx="50" cy="50" r={r} stroke-dasharray={`${(end / 100) * c} ${c}`} transform="rotate(-90 50 50)" /> : null}
        {used > 0 ? <circle class={'val ' + tone} cx="50" cy="50" r={r} stroke-dasharray={`${Math.max(1.5, (used / 100) * c)} ${c}`} transform="rotate(-90 50 50)" /> : null}
        <text x="50" y="49" class="big">{pctText(pct)}</text>
        <text x="50" y="65" class="small">{word}</text>
      </svg>
      <b>{label}</b>
      <small>{value}</small>
      {proj != null ? <small class={tone === 'ok' ? '' : tone + '-t'}>≈ {pctText(proj)} by day end{proj >= 100 ? ' ⚠' : ''}</small> : <small>&nbsp;</small>}
    </div>
  );
}

// 24 hourly bars (oldest first): requests in blue, the hour's errors stacked on top in red. Tap a bar for its numbers.
export function HourBars({ hours, fmtTime }) {
  const [sel, setSel] = useState(hours.length - 1);
  const max = Math.max(1, ...hours.map((h) => h.requests));
  const W = 24 * 12, H = 96;
  const h = hours[clamp(sel, 0, hours.length - 1)];
  return (
    <div class="chart">
      <div class="readout"><b>{fmtTime(h.hour)}</b> · {fmtN(h.requests)} requests{h.errors ? <> · <span class="alert-t">{fmtN(h.errors)} errors</span></> : ' · no errors'}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="plot" role="img" aria-label="Requests per hour, last 24 hours">
        <line class="base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
        {hours.map((x, i) => {
          const tot = (x.requests / max) * (H - 4);
          const err = x.requests ? Math.min(tot, Math.max(x.errors ? 2 : 0, (x.errors / x.requests) * tot)) : 0;
          const ok = Math.max(0, tot - err - (err && tot - err > 2 ? 2 : 0));
          const X = i * 12 + 2;
          return (
            <g class={i === sel ? 'on' : ''}>
              {ok > 0 ? <rect class="b-blue" x={X} y={H - ok} width="8" height={ok} rx="2" /> : <rect class="b-zero" x={X} y={H - 2} width="8" height="2" rx="1" />}
              {err > 0 ? <rect class="b-red" x={X} y={H - tot} width="8" height={err} rx="2" /> : null}
              <rect class="hit" x={i * 12} y="0" width="12" height={H} onPointerEnter={() => setSel(i)} onClick={() => setSel(i)} />
            </g>
          );
        })}
      </svg>
      <div class="xaxis">{[0, 6, 12, 18, 23].map((i) => <span style={{ left: `${((i * 12 + 6) / W) * 100}%` }}>{i === 23 ? 'now' : fmtTime(hours[i].hour)}</span>)}</div>
    </div>
  );
}

// CPU per hour (worst p99) as a line, with the Free plan's 10 ms cap as a dashed line. Tap for the hour's value.
export function CpuLine({ hours, cap, fmtTime }) {
  const pts = hours.map((h, i) => ({ i, v: h.requests ? h.p99 : null, hour: h.hour }));
  const live = pts.filter((p) => p.v != null);
  const [sel, setSel] = useState(live.length ? live[live.length - 1].i : 0);
  const max = Math.max(cap * 1.25, ...live.map((p) => p.v));
  const W = 24 * 12, H = 80;
  const y = (v) => H - 4 - (v / max) * (H - 10);
  const x = (i) => i * 12 + 6;
  const path = live.map((p, k) => `${k && live[k - 1].i === p.i - 1 ? 'L' : 'M'}${x(p.i)},${y(p.v).toFixed(1)}`).join(' ');
  const s = pts[sel];
  return (
    <div class="chart">
      <div class="readout"><b>{fmtTime(s.hour)}</b> · {s.v == null ? 'no requests' : <>worst 1% of requests: <span class={s.v >= cap ? 'alert-t' : s.v >= cap * 0.7 ? 'amber-t' : ''}>{s.v.toFixed(1)} ms</span> of {cap} ms</>}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="plot" role="img" aria-label="CPU time per hour against the 10 ms cap">
        <line class="cap" x1="0" x2={W} y1={y(cap)} y2={y(cap)} />
        <path class="ln" d={path} />
        {s.v != null ? <circle class="pt" cx={x(s.i)} cy={y(s.v)} r="3.5" /> : null}
        {pts.map((p) => <rect class="hit" x={p.i * 12} y="0" width="12" height={H} onPointerEnter={() => setSel(p.i)} onClick={() => setSel(p.i)} />)}
      </svg>
      <div class="legend"><span><i class="sw ln" />CPU, worst hour (p99)</span><span><i class="sw cap" />{cap} ms Free plan cap</span></div>
    </div>
  );
}

// One horizontal bar split into parts (2px gaps), with a legend that says each part's number and share.
export function StackBar({ parts }) {
  const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div class="stack-bar" role="img" aria-label={shown.map((p) => `${p.label} ${fmtN(p.value)}`).join(', ')}>
        {shown.map((p) => <i class={'s-' + (p.tone || 'blue')} style={{ flexGrow: p.value, minWidth: '3px' }} />)}
      </div>
      <div class="legend col">
        {shown.map((p) => <span><i class={'sw s-' + (p.tone || 'blue')} /><em>{p.label}</em><b class="num">{fmtN(p.value)}</b><small>{((100 * p.value) / tot).toFixed(p.value / tot < 0.01 ? 2 : 1)}%</small></span>)}
      </div>
    </div>
  );
}

// A half dial: how much of what the Free plan can carry is in use (active users today against the estimate).
export function Gauge({ value, max, label, sub }) {
  const p = clamp(max ? value / max : 0, 0, 1);
  const tone = quotaTone(p * 100);
  const r = 70, len = Math.PI * r;
  return (
    <div class="gauge" role="img" aria-label={`${label}: ${sub}`}>
      <svg viewBox="0 0 180 100" aria-hidden="true">
        <path class="trk" d="M20 90 A70 70 0 0 1 160 90" />
        {p > 0 ? <path class={'val ' + tone} d="M20 90 A70 70 0 0 1 160 90" stroke-dasharray={`${Math.max(2, p * len)} ${len}`} /> : null}
        <text x="90" y="72" class="big">{label}</text>
        <text x="90" y="92" class="small">{sub}</text>
      </svg>
    </div>
  );
}

// Columns for a few days of one measure as a share of its daily cap (same 0-100% scale for every metric, so the
// small multiples compare). A dashed line marks the cap; a column over 85% turns red. Tap a column for its value.
export function DayColumns({ days, label, unit = '%' }) {
  const [sel, setSel] = useState(days.length - 1);
  const max = Math.max(100, ...days.map((d) => d.value || 0));
  const W = days.length * 40, H = 70;
  const d = days[clamp(sel, 0, days.length - 1)];
  return (
    <div class="chart mini">
      <div class="readout"><b>{label}</b> · {d.label}: {d.value == null ? 'no data' : <span class={d.value >= 85 ? 'alert-t' : ''}>{unit === '%' ? pctText(d.value) : fmtN(d.value)}</span>}{d.extra ? ` · ${d.extra}` : ''}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="plot" role="img" aria-label={`${label}, ${days.length} days`}>
        <line class="cap" x1="0" x2={W} y1={H - (100 / max) * (H - 4)} y2={H - (100 / max) * (H - 4)} />
        {days.map((x, i) => {
          const h = x.value == null ? 0 : Math.max(2, (x.value / max) * (H - 4));
          return (
            <g class={i === sel ? 'on' : ''}>
              {x.value == null ? <rect class="b-zero" x={i * 40 + 10} y={H - 2} width="20" height="2" rx="1" />
                : <rect class={x.value >= 85 ? 'b-red' : x.value >= 60 ? 'b-amber' : 'b-blue'} x={i * 40 + 10} y={H - h} width="20" height={h} rx="3" />}
              <rect class="hit" x={i * 40} y="0" width="40" height={H} onPointerEnter={() => setSel(i)} onClick={() => setSel(i)} />
            </g>
          );
        })}
      </svg>
      <div class="xlabels">{days.map((x) => <span>{x.short}</span>)}</div>
    </div>
  );
}

// Columns stacked from parts (priorities per day on the health-report screen). Tap a column for its numbers.
export function StackColumns({ cols, parts }) {
  const [sel, setSel] = useState(cols.length - 1);
  const tot = (c) => parts.reduce((a, p) => a + (c[p.k] || 0), 0);
  const max = Math.max(1, ...cols.map(tot));
  const W = cols.length * 40, H = 80;
  const c = cols[clamp(sel, 0, cols.length - 1)];
  return (
    <div class="chart">
      <div class="readout"><b>{c.label}</b> · {tot(c) ? parts.filter((p) => c[p.k]).map((p) => `${fmtN(c[p.k])} ${p.label.toLowerCase()}`).join(' · ') : 'nothing reported'}</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="plot" role="img" aria-label="Reports per day">
        <line class="base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
        {cols.map((x, i) => {
          let y = H;
          return (
            <g class={i === sel ? 'on' : ''}>
              {tot(x) ? parts.map((p) => {
                const h = ((x[p.k] || 0) / max) * (H - 4);
                if (!h) return null;
                const hh = Math.max(2, h - (y < H ? 2 : 0));
                y -= h;
                return <rect class={'s-' + p.tone} x={i * 40 + 10} y={y} width="20" height={hh} rx="3" />;
              }) : <rect class="b-zero" x={i * 40 + 10} y={H - 2} width="20" height="2" rx="1" />}
              <rect class="hit" x={i * 40} y="0" width="40" height={H} onPointerEnter={() => setSel(i)} onClick={() => setSel(i)} />
            </g>
          );
        })}
      </svg>
      <div class="xlabels">{cols.map((x) => <span>{x.short}</span>)}</div>
      <div class="legend">{parts.map((p) => <span><i class={'sw s-' + p.tone} />{p.label}</span>)}</div>
    </div>
  );
}

// A row with a bar for its share (the costly-queries list)
export function ShareRow({ share, title, sub, tone = 'blue' }) {
  return (
    <div class="share">
      <div class="share-top"><b class="num">{pctText(share)}</b><small>{sub}</small></div>
      <div class="share-bar"><i class={'s-' + tone} style={{ width: `${clamp(share, 1.5, 100)}%` }} /></div>
      <div class="mono share-q">{title}</div>
    </div>
  );
}
