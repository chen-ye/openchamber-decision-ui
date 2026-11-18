import { connectHost } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import type { AutoPresentationMode, AutoVisualResult } from '../src/core/auto-block.ts';

const DARK_SERIES_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#fb923c'];
const LIGHT_SERIES_COLORS = ['#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#ea580c'];

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let currentRawContent = '';
let currentBaseIntent = '';
let activeSelectionKey = 'auto';
let requestSeq = 0;

function seriesPalette(): ReadonlyArray<string> {
  return document.documentElement.dataset.ocTheme === 'light'
    ? LIGHT_SERIES_COLORS
    : DARK_SERIES_COLORS;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function syncFrameHeight(): void {
  const h = Math.ceil(root.getBoundingClientRect().height);
  if (h > 0) {
    void host.setHeight(h).catch(() => {});
  }
}

new ResizeObserver(() => {
  syncFrameHeight();
}).observe(root);

void document.fonts?.ready.then(() => {
  syncFrameHeight();
});

function formatCompact(num: number, unit?: string): string {
  const abs = Math.abs(num);
  let text: string;
  if (abs >= 1_000_000) text = `${(num / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  else if (abs >= 10_000) text = `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  else if (Number.isInteger(num)) text = String(num);
  else text = num.toFixed(2).replace(/\.?0+$/, '');

  if (!unit) return text;
  if (unit === '$' || unit === '€' || unit === '£') return `${unit}${text}`;
  if (unit === '%') return `${text}%`;
  return `${text} ${unit}`;
}

function isIntensiveColumn(name: string, unit?: string, looksLikeShare?: boolean): boolean {
  return Boolean(
    looksLikeShare ||
      (unit !== undefined && /^(?:%|ms|s|us|ns|Hz|x)$/i.test(unit)) ||
      /\b(?:latency|p50|p90|p95|p99|rate|ratio|score|ece|err|error|avg|mean|duration)\b/i.test(
        name,
      ),
  );
}

function renderMarkdownSafe(markdown: string): HTMLElement {
  const container = el('div', 'av-md');
  const lines = markdown.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? '';
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[i] ?? '');
        i += 1;
      }
      i += 1;
      const pre = el('pre');
      pre.appendChild(el('code', undefined, codeLines.join('\n')));
      container.appendChild(pre);
      continue;
    }

    const nextTrimmed = (lines[i + 1] ?? '').trim();
    if (trimmed.includes('|') && /^\|?[\s:-]+\|[\s|:-]+$/.test(nextTrimmed)) {
      const splitPipe = (l: string) =>
        l
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = splitPipe(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().includes('|')) {
        rows.push(splitPipe((lines[i] ?? '').trim()));
        i += 1;
      }
      const wrap = el('div', 'av-table-wrap');
      const table = el('table', 'av-table');
      const thead = el('thead');
      const trHead = el('tr');
      for (const h of headers) {
        trHead.appendChild(el('th', undefined, h));
      }
      thead.appendChild(trHead);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        for (const c of r) {
          const td = el('td');
          appendInlineFormatted(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      container.appendChild(wrap);
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch?.[2]) {
      const hTag = (headingMatch[1]?.length ?? 3) <= 2 ? 'h3' : 'h4';
      const hNode = el(hTag);
      appendInlineFormatted(hNode, headingMatch[2]);
      container.appendChild(hNode);
      i += 1;
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      const ul = el('ul');
      while (i < lines.length && /^[-*•]\s+/.test((lines[i] ?? '').trim())) {
        const liText = (lines[i] ?? '').trim().replace(/^[-*•]\s+/, '');
        const li = el('li');
        appendInlineFormatted(li, liText);
        ul.appendChild(li);
        i += 1;
      }
      container.appendChild(ul);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const ol = el('ol');
      while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] ?? '').trim())) {
        const liText = (lines[i] ?? '').trim().replace(/^\d+[.)]\s+/, '');
        const li = el('li');
        appendInlineFormatted(li, liText);
        ol.appendChild(li);
        i += 1;
      }
      container.appendChild(ol);
      continue;
    }

    const p = el('p');
    appendInlineFormatted(p, trimmed);
    container.appendChild(p);
    i += 1;
  }

  return container;
}

function appendInlineFormatted(parent: HTMLElement, text: string): void {
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    const tok = match[0]!;
    if (tok.startsWith('`') && tok.endsWith('`')) {
      parent.appendChild(el('code', undefined, tok.slice(1, -1)));
    } else if (tok.startsWith('**') && tok.endsWith('**')) {
      parent.appendChild(el('strong', undefined, tok.slice(2, -2)));
    }
    lastIdx = match.index + tok.length;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function renderToolbar(res: AutoVisualResult): HTMLElement | null {
  if (res.availableModes.length <= 1) {
    return null;
  }

  const bar = el('div', 'av-toolbar');
  const metaText =
    res.mode === 'verbatim'
      ? res.manualOverride
        ? 'Verbatim (manual)'
        : `Verbatim · p(vis)=${res.shouldVisualizeProbability.toFixed(2)}`
      : `${res.mode === 'chart' ? res.compiled?.plan.chartKind ?? 'chart' : res.mode} · ${res.ms} ms`;
  bar.appendChild(el('span', 'av-meta', metaText));

  const pills = el('div', 'av-pills');
  const options: Array<{ key: string; label: string; forceMode: AutoPresentationMode; edit?: string }> = [
    { key: 'verbatim', label: 'Verbatim', forceMode: 'verbatim' },
  ];

  if (res.availableModes.includes('chart')) {
    options.push(
      { key: 'bar_ranked', label: 'Bar', forceMode: 'chart', edit: 'bar_ranked sorted descending' },
      { key: 'bar_whole_share', label: 'Share', forceMode: 'chart', edit: 'bar_whole_share' },
      { key: 'line_trend', label: 'Line', forceMode: 'chart', edit: 'line_trend preserve order' },
      { key: 'progress_bars', label: 'Progress', forceMode: 'chart', edit: 'progress_bars' },
    );
  }
  if (res.availableModes.includes('stats_kv')) {
    options.push({ key: 'stats_kv', label: 'Stats/KV', forceMode: 'stats_kv' });
  }
  if (res.availableModes.includes('steps_flow')) {
    options.push({ key: 'steps_flow', label: 'Steps', forceMode: 'steps_flow' });
  }

  const resolvedActiveKey =
    activeSelectionKey !== 'auto'
      ? activeSelectionKey
      : res.mode === 'chart'
        ? res.compiled?.plan.chartKind ?? 'bar_ranked'
        : res.mode;

  for (const opt of options) {
    const btn = el('button', 'av-pill', opt.label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(opt.key === resolvedActiveKey));
    btn.addEventListener('click', () => {
      activeSelectionKey = opt.key;
      void evaluateAndRender(currentRawContent, opt.edit ?? currentBaseIntent, opt.forceMode);
    });
    pills.appendChild(btn);
  }

  bar.appendChild(pills);
  return bar;
}

function renderChartView(res: AutoVisualResult, container: HTMLElement): void {
  const compiled = res.compiled;
  if (!compiled || compiled.dataset.rows.length === 0) {
    container.appendChild(renderMarkdownSafe(res.rawContent));
    return;
  }

  const { dataset, plan } = compiled;
  if (dataset.title) {
    container.appendChild(el('div', 'av-title', dataset.title));
  }

  const labelCol = dataset.columns[plan.labelColumnIndex] ?? dataset.columns[0]!;
  const numCols = dataset.columns.filter((c) => c.kind === 'number' && c.index !== labelCol.index);
  const primaryCol =
    numCols.find((c) => plan.columnRoles[c.index] === 'primary_series') ?? numCols[0];
  const secondaryBarCol = numCols.find((c) => c !== primaryCol && plan.columnRoles[c.index] !== 'omit');

  const rows = [...dataset.rows];
  if (primaryCol && plan.sortOrder !== 'preserve') {
    const idx = primaryCol.index;
    rows.sort((a, b) => {
      const av = typeof a[idx] === 'number' ? (a[idx] as number) : -Infinity;
      const bv = typeof b[idx] === 'number' ? (b[idx] as number) : -Infinity;
      return plan.sortOrder === 'desc_primary' ? bv - av : av - bv;
    });
  }

  // 1. Hero Stats (intensive units like ms/% show Peak + avg instead of nonsensical sums)
  if (plan.includeStats && primaryCol && rows.length > 0) {
    const statsGrid = el('div', 'av-stats');
    const statCols = [
      primaryCol,
      ...numCols.filter((c) => c !== primaryCol && plan.columnRoles[c.index] !== 'omit'),
    ].slice(0, 3);

    statCols.forEach((col, idx) => {
      const vals = rows
        .map((r) => r[col.index])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (vals.length === 0) return;

      const topRow = rows.reduce((best, cur) => {
        const bv = typeof best[col.index] === 'number' ? (best[col.index] as number) : -Infinity;
        const cv = typeof cur[col.index] === 'number' ? (cur[col.index] as number) : -Infinity;
        return cv > bv ? cur : best;
      }, rows[0]!);
      const leaderVal =
        typeof topRow[col.index] === 'number' ? (topRow[col.index] as number) : vals[0]!;
      const leaderLabel = String(topRow[labelCol.index] ?? '');
      const intensive = isIntensiveColumn(col.name, col.unit, col.looksLikePercentageShare);

      const tile = el('div', 'av-stat');
      if (intensive) {
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        tile.appendChild(el('div', 'av-stat-label', `Peak ${col.name}`));
        const valNode = el('div', 'av-stat-val', formatCompact(leaderVal, col.unit));
        if (idx === 0) valNode.dataset.tone = 'info';
        tile.appendChild(valNode);
        tile.appendChild(
          el('div', 'av-stat-sub', `${leaderLabel} · avg ${formatCompact(mean, col.unit)}`),
        );
      } else {
        tile.appendChild(el('div', 'av-stat-label', `Total ${col.name}`));
        const valNode = el(
          'div',
          'av-stat-val',
          formatCompact(
            vals.reduce((a, b) => a + b, 0),
            col.unit,
          ),
        );
        if (idx === 0) valNode.dataset.tone = 'info';
        tile.appendChild(valNode);
        tile.appendChild(el('div', 'av-stat-sub', `Max: ${leaderLabel}`));
      }
      statsGrid.appendChild(tile);
    });
    container.appendChild(statsGrid);
  }

  // 2. Main Chart
  const palette = seriesPalette();
  if (primaryCol && rows.length > 0 && plan.chartKind !== 'stat_tiles_only') {
    const labels = rows.map((r, idx) => String(r[labelCol.index] ?? `Item ${idx + 1}`));
    const values = rows.map((r) =>
      typeof r[primaryCol.index] === 'number' ? (r[primaryCol.index] as number) : 0,
    );

    if (plan.chartKind === 'bar_whole_share') {
      const total = Math.max(
        1e-6,
        values.reduce((acc, v) => acc + Math.max(0, v), 0),
      );
      const wrap = el('div');
      const track = el('div', 'av-whole-bar');
      const legend = el('div', 'av-whole-legend');

      rows.forEach((_, idx) => {
        const val = Math.max(0, values[idx] ?? 0);
        const sharePct = (val / total) * 100;
        const color = palette[idx % palette.length]!;
        const seg = el('div');
        seg.style.width = `${sharePct.toFixed(2)}%`;
        seg.style.background = color;
        seg.title = `${labels[idx]}: ${formatCompact(val, primaryCol.unit)} (${sharePct.toFixed(1)}%)`;
        track.appendChild(seg);

        const item = el('div', 'av-legend-item');
        const left = el('div', 'av-legend-left');
        const dot = el('span', 'av-dot');
        dot.style.background = color;
        left.appendChild(dot);
        left.appendChild(el('span', 'av-legend-name', labels[idx] ?? ''));
        item.appendChild(left);
        item.appendChild(el('span', 'av-bar-num', `${sharePct.toFixed(1)}%`));
        legend.appendChild(item);
      });

      wrap.appendChild(track);
      wrap.appendChild(legend);
      container.appendChild(wrap);
    } else if (plan.chartKind === 'line_trend') {
      const svgBox = el('div', 'av-svg-box');
      const w = 520;
      const h = 136;
      const padX = 28;
      const padY = 20;
      const minV = Math.min(0, ...values);
      const maxV = Math.max(minV + 1e-6, ...values);

      const pts = values.map((v, idx) => {
        const x =
          values.length === 1
            ? w / 2
            : padX + (idx / (values.length - 1)) * (w - padX * 2);
        const y = h - padY - ((v - minV) / (maxV - minV)) * (h - padY * 2);
        return { x, y, v, label: labels[idx] ?? '' };
      });

      const polyPoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      const areaPoints = `${pts[0]!.x.toFixed(1)},${(h - padY).toFixed(1)} ${polyPoints} ${pts.at(-1)!.x.toFixed(1)},${(h - padY).toFixed(1)}`;

      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '136');

      const area = document.createElementNS(svgNS, 'polygon');
      area.setAttribute('points', areaPoints);
      area.setAttribute('fill', 'var(--oc-selection, rgba(59, 130, 246, 0.16))');
      svg.appendChild(area);

      const line = document.createElementNS(svgNS, 'polyline');
      line.setAttribute('points', polyPoints);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', 'var(--oc-info, #3b82f6)');
      line.setAttribute('stroke-width', '2.25');
      svg.appendChild(line);

      pts.forEach((p, idx) => {
        const circle = document.createElementNS(svgNS, 'circle');
        circle.setAttribute('cx', p.x.toFixed(1));
        circle.setAttribute('cy', p.y.toFixed(1));
        circle.setAttribute('r', '3.4');
        circle.setAttribute('fill', 'var(--oc-info, #3b82f6)');
        svg.appendChild(circle);

        if (idx === 0 || idx === pts.length - 1 || pts.length <= 6) {
          const lbl = document.createElementNS(svgNS, 'text');
          lbl.setAttribute('x', p.x.toFixed(1));
          lbl.setAttribute('y', String(h - 4));
          lbl.setAttribute(
            'text-anchor',
            idx === 0 ? 'start' : idx === pts.length - 1 ? 'end' : 'middle',
          );
          lbl.setAttribute('fill', 'var(--oc-muted, #64748b)');
          lbl.setAttribute('font-size', '10');
          lbl.textContent = p.label.slice(0, 12);
          svg.appendChild(lbl);
        }
      });

      svgBox.appendChild(svg);
      container.appendChild(svgBox);
    } else {
      const maxVal =
        plan.chartKind === 'progress_bars'
          ? Math.max(100, ...values)
          : Math.max(1e-6, ...values.map((v) => Math.abs(v)));
      const barsWrap = el('div', 'av-bars');

      rows.slice(0, 14).forEach((rowCells, idx) => {
        const val = values[idx] ?? 0;
        const pct = Math.min(100, Math.max(1, (Math.abs(val) / maxVal) * 100));
        const row = el('div', 'av-bar-row');
        const head = el('div', 'av-bar-head');
        head.appendChild(el('span', 'av-bar-label', labels[idx] ?? ''));

        let readout = formatCompact(val, primaryCol.unit);
        if (!plan.includeTable && secondaryBarCol) {
          const secVal = rowCells[secondaryBarCol.index];
          if (typeof secVal === 'number' && Number.isFinite(secVal)) {
            readout += ` · ${formatCompact(secVal, secondaryBarCol.unit)}`;
          }
        }
        head.appendChild(el('span', 'av-bar-num', readout));
        row.appendChild(head);

        const track = el('div', 'av-bar-track');
        const fill = el('div', 'av-bar-fill');
        fill.style.width = `${pct.toFixed(2)}%`;
        if (plan.chartKind === 'progress_bars') {
          fill.dataset.tone = 'success';
        }
        track.appendChild(fill);
        row.appendChild(track);
        barsWrap.appendChild(row);
      });

      container.appendChild(barsWrap);
    }
  }

  // 3. Companion Detail Table
  const visibleCols = dataset.columns.filter((c) => plan.columnRoles[c.index] !== 'omit');
  if (plan.includeTable && visibleCols.length >= 2 && rows.length > 1) {
    const wrap = el('div', 'av-table-wrap');
    const tbl = el('table', 'av-table');
    const thead = el('thead');
    const trH = el('tr');
    for (const c of visibleCols) {
      const th = el('th', undefined, c.name);
      if (c.kind === 'number') th.dataset.num = 'true';
      trH.appendChild(th);
    }
    thead.appendChild(trH);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    for (const r of rows.slice(0, 20)) {
      const tr = el('tr');
      for (const c of visibleCols) {
        const cell = r[c.index];
        const text =
          cell === null || cell === undefined
            ? '—'
            : typeof cell === 'number'
              ? formatCompact(cell, c.unit)
              : String(cell);
        const td = el('td', undefined, text);
        if (c.kind === 'number') td.dataset.num = 'true';
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    container.appendChild(wrap);
  }

  // 4. Preserved Accompanying Prose
  if (res.keepProse && res.accompanyingProse.trim()) {
    container.appendChild(renderMarkdownSafe(res.accompanyingProse.trim()));
  }
}

function renderKvView(res: AutoVisualResult, container: HTMLElement): void {
  const items = res.kvItems ?? [];
  const gauges = items.filter((i) => i.numericPercent !== undefined);
  if (gauges.length > 0) {
    const barsWrap = el('div', 'av-bars');
    for (const g of gauges) {
      const row = el('div', 'av-bar-row');
      const head = el('div', 'av-bar-head');
      head.appendChild(el('span', 'av-bar-label', g.label));
      head.appendChild(el('span', 'av-bar-num', g.value));
      row.appendChild(head);
      const track = el('div', 'av-bar-track');
      const fill = el('div', 'av-bar-fill');
      fill.dataset.tone = 'success';
      fill.style.width = `${Math.min(100, Math.max(1, g.numericPercent!)).toFixed(1)}%`;
      track.appendChild(fill);
      row.appendChild(track);
      barsWrap.appendChild(row);
    }
    container.appendChild(barsWrap);
  }

  const grid = el('div', 'av-kv-grid');
  for (const item of items) {
    const cell = el('div', 'av-kv-item');
    cell.appendChild(el('span', 'av-kv-k', item.label));
    const v = el('span', 'av-kv-v', item.value);
    if (item.tone) {
      v.className = 'av-stat-val';
      v.dataset.tone = item.tone;
      v.style.fontSize = '0.8rem';
    }
    cell.appendChild(v);
    grid.appendChild(cell);
  }
  container.appendChild(grid);

  if (res.keepProse && res.accompanyingProse.trim()) {
    container.appendChild(renderMarkdownSafe(res.accompanyingProse.trim()));
  }
}

function renderStepsView(res: AutoVisualResult, container: HTMLElement): void {
  const steps = res.stepItems ?? [];
  const wrap = el('div', 'av-steps');
  const icons: Record<string, string> = {
    done: '✓',
    current: '●',
    blocked: '!',
    todo: '○',
  };

  for (const s of steps) {
    const row = el('div', 'av-step');
    const rail = el('div', 'av-step-rail');
    const badge = el('span', 'av-step-badge', icons[s.status] ?? '○');
    badge.dataset.status = s.status;
    rail.appendChild(badge);
    rail.appendChild(el('div', 'av-step-line'));
    row.appendChild(rail);

    const body = el('div', 'av-step-body');
    body.appendChild(el('div', 'av-step-title', s.title));
    if (s.detail) {
      body.appendChild(el('div', 'av-step-detail', s.detail));
    }
    row.appendChild(body);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);

  if (res.keepProse && res.accompanyingProse.trim()) {
    container.appendChild(renderMarkdownSafe(res.accompanyingProse.trim()));
  }
}

function drawAutoVisualResult(res: AutoVisualResult): void {
  root.replaceChildren();
  const bar = renderToolbar(res);
  if (bar) root.appendChild(bar);

  if (res.mode === 'verbatim') {
    root.appendChild(renderMarkdownSafe(res.rawContent));
  } else if (res.mode === 'chart') {
    renderChartView(res, root);
  } else if (res.mode === 'stats_kv') {
    renderKvView(res, root);
  } else if (res.mode === 'steps_flow') {
    renderStepsView(res, root);
  }

  requestAnimationFrame(syncFrameHeight);
}

async function evaluateAndRender(
  content: string,
  intent: string,
  forceMode?: AutoPresentationMode,
): Promise<void> {
  const seq = ++requestSeq;
  try {
    const res = await host.serviceRequest({
      method: 'POST',
      path: '/auto-visual',
      body: JSON.stringify({
        content,
        intent: intent || undefined,
        forceMode,
      }),
    });
    if (seq !== requestSeq) return;
    if (res.status >= 200 && res.status < 300 && res.body) {
      const parsed = JSON.parse(res.body) as AutoVisualResult;
      drawAutoVisualResult(parsed);
      return;
    }
  } catch {
    // Graceful fallback: render verbatim cleanly if service is asleep/unapproved
  }

  if (seq !== requestSeq) return;
  root.replaceChildren(renderMarkdownSafe(content));
  requestAnimationFrame(syncFrameHeight);
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  requestAnimationFrame(syncFrameHeight);
});

host.onBlock(({ args }) => {
  const content = (args.content ?? '').trim();
  const intent = (args.intent ?? '').trim();
  if (!content) {
    root.replaceChildren(el('div', 'av-meta', 'Empty AutoVisual block'));
    syncFrameHeight();
    return;
  }
  currentRawContent = content;
  currentBaseIntent = intent;
  activeSelectionKey = 'auto';
  void evaluateAndRender(content, intent);
});
