// Graphiques SVG (chaînes sûres). Styles via classes CSS (thème clair/sombre automatique).
import { raw, fmtInt } from './text.js';

/** Graduations « jolies » (1-2-5) couvrant [min,max]. Gère min===max. */
export function niceTicks(min, max, count = 4) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (min === max) { min = Math.max(0, min - 1); max = max + 1; }
  const rough = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { min: lo, max: hi, step, ticks };
}

/**
 * Courbe d'évolution. `points` : [{label, value}] ordonnés. Retourne un SVG responsive
 * (viewBox) avec grille, axe Y gradué, étiquettes X espacées et surface sous la courbe.
 */
export function lineChart(points, { width = 340, height = 170, title = 'Évolution', unit = '' } = {}) {
  const pad = { l: 38, r: 10, t: 10, b: 22 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  if (!points.length) return raw(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title} : aucune donnée"></svg>`);
  const vals = points.map((p) => p.value);
  const { min, max, ticks } = niceTicks(Math.min(...vals), Math.max(...vals));
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (iw * i) / (points.length - 1));
  const y = (v) => pad.t + ih - ((v - min) / (max - min || 1)) * ih;
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)} ${pad.t + ih}L${x(0).toFixed(1)} ${pad.t + ih}Z`;
  const grid = ticks.map((t) => `<line class="chart__grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="chart__label" x="${pad.l - 6}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${fmtInt(t)}</text>`).join('');
  const every = Math.max(1, Math.ceil(points.length / 5));
  const xl = points.map((p, i) => (i % every === 0 || i === points.length - 1 ? `<text class="chart__label" x="${x(i).toFixed(1)}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${p.label}</text>` : '')).join('');
  const first = vals[0], last = vals.at(-1);
  const aria = `${title} : de ${fmtInt(first)} à ${fmtInt(last)}${unit} sur ${points.length} points`;
  const lastDot = `<circle class="chart__dot" cx="${x(points.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5"/>`;
  return raw(`<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${aria}">${grid}<path class="chart__area" d="${area}"/><path class="chart__line" d="${line}"/>${lastDot}${xl}</svg>`);
}

/** Mini-courbe sans axes pour les tuiles KPI. */
export function sparkline(values, { width = 80, height = 24 } = {}) {
  if (values.length < 2) return raw('');
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)} ${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join('');
  return raw(`<svg class="spark" viewBox="0 0 ${width} ${height}" aria-hidden="true"><path d="${d}"/></svg>`);
}
