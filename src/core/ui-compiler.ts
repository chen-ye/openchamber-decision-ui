import { lintOpenUiSource } from './ast-linter.ts';
import {
  getChoiceAnswer,
  getNoulAnswer,
  sanitizeChoiceKey,
  type DecisionBridgeClient,
} from './client.ts';
import type {
  ColumnProfile,
  CompileUiResult,
  CompilerChartKind,
  CompilerColumnRole,
  CompilerPlan,
  CompilerSortOrder,
  DecisionQuestion,
  StructuredDataset,
} from './types.ts';

const CHART_KINDS: ReadonlyArray<CompilerChartKind> = [
  'bar_ranked',
  'bar_whole_share',
  'line_trend',
  'progress_bars',
  'stat_tiles_only',
];

const SORT_ORDERS: ReadonlyArray<CompilerSortOrder> = ['preserve', 'desc_primary', 'asc_primary'];

const COLUMN_ROLES: ReadonlyArray<CompilerColumnRole> = [
  'primary_series',
  'secondary_series',
  'hero_stat',
  'table_only',
  'omit',
];

const TEMPORAL_PATTERNS =
  /^(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|Q[1-4]\s*\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{0,4}|W\d{1,2}|Day\s*\d+|Step\s*\d+|\d{1,2}:\d{2})$/i;

function parseNumericCell(raw: unknown): { value: number; unit?: string } | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: raw };
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const match =
    /^([+-]?)([$€£])?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?\s*(%|ms|us|ns|s|x|Hz|KiB|MiB|GiB|TiB|KB|MB|GB|TB|G|T|k|M|B)?$/i.exec(
      trimmed,
    );
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const currency = match[2];
  const intPart = (match[3] ?? '0').replace(/,/g, '');
  const fracPart = match[4] ? `.${match[4]}` : '';
  const suffix = match[5];

  let multiplier = 1;
  let unit = currency ?? suffix;
  if (suffix === 'G') {
    unit = 'GB';
  } else if (suffix === 'T') {
    unit = 'TB';
  } else if (suffix === 'k') {
    multiplier = 1_000;
    unit = currency;
  } else if (suffix === 'M' && currency) {
    multiplier = 1_000_000;
    unit = currency;
  } else if (suffix === 'B' && currency) {
    multiplier = 1_000_000_000;
    unit = currency;
  }

  const num = sign * Number(`${intPart}${fracPart}`) * multiplier;
  if (!Number.isFinite(num)) return null;
  return unit ? { value: num, unit } : { value: num };
}

function buildColumnProfiles(
  headers: ReadonlyArray<string>,
  rawRows: ReadonlyArray<ReadonlyArray<unknown>>,
): { columns: ColumnProfile[]; normalizedRows: Array<Array<string | number | null>> } {
  const colCount = headers.length;
  const normalizedRows: Array<Array<string | number | null>> = rawRows.map((row) =>
    Array.from({ length: colCount }, (_, idx) => {
      const cell = row[idx];
      if (cell === null || cell === undefined || cell === '') return null;
      const parsedNum = parseNumericCell(cell);
      if (parsedNum !== null) return parsedNum.value;
      return String(cell).trim();
    }),
  );

  const usedKeys = new Set<string>();
  const columns: ColumnProfile[] = headers.map((rawHeader, index) => {
    const name = rawHeader.trim() || `Column ${index + 1}`;
    let safeKey = sanitizeChoiceKey(`c${index}_${name.replace(/[^A-Za-z0-9_-]/g, '_')}`, index);
    while (usedKeys.has(safeKey)) {
      safeKey = `${safeKey}_${index}`;
    }
    usedKeys.add(safeKey);

    const nums: number[] = [];
    const samples: Array<string | number> = [];
    let temporalHits = 0;
    let nonEmptyCount = 0;
    let detectedUnit: string | undefined;

    for (let r = 0; r < rawRows.length; r += 1) {
      const orig = rawRows[r]?.[index];
      const norm = normalizedRows[r]?.[index] ?? null;
      if (norm === null) continue;
      nonEmptyCount += 1;
      if (samples.length < 4) samples.push(norm);

      const parsedNum = parseNumericCell(orig);
      if (parsedNum !== null) {
        nums.push(parsedNum.value);
        if (!detectedUnit && parsedNum.unit) detectedUnit = parsedNum.unit;
      } else if (typeof norm === 'string' && TEMPORAL_PATTERNS.test(norm)) {
        temporalHits += 1;
      }
    }

    const headerUnitMatch = /\((%|ms|s|USD|\$|MB|GB|KB|req\/s|ops\/s)\)/i.exec(name);
    if (!detectedUnit && headerUnitMatch?.[1]) {
      detectedUnit = headerUnitMatch[1];
    }

    const isNumeric = nonEmptyCount > 0 && nums.length >= Math.ceil(nonEmptyCount * 0.65);
    const isTemporal =
      !isNumeric &&
      ((nonEmptyCount > 0 && temporalHits >= Math.ceil(nonEmptyCount * 0.6)) ||
        /\b(?:date|time|month|quarter|year|week|day|timestamp)\b/i.test(name));

    const sum = isNumeric && nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
    const min = isNumeric && nums.length > 0 ? Math.min(...nums) : null;
    const max = isNumeric && nums.length > 0 ? Math.max(...nums) : null;
    const mean = sum !== null && nums.length > 0 ? sum / nums.length : null;
    const looksLikePercentageShare =
      isNumeric &&
      nums.length >= 2 &&
      min !== null &&
      min >= 0 &&
      sum !== null &&
      ((sum >= 98 && sum <= 102) || (sum >= 0.98 && sum <= 1.02));

    return {
      index,
      name,
      safeKey,
      kind: isNumeric ? 'number' : isTemporal ? 'temporal' : 'string',
      ...(detectedUnit ? { unit: detectedUnit } : {}),
      sampleValues: samples,
      numericCount: nums.length,
      min,
      max,
      sum,
      mean,
      looksLikePercentageShare,
    };
  });

  return { columns, normalizedRows };
}

function tryExtractFromJson(text: string): StructuredDataset | null {
  const candidates: string[] = [text.trim()];
  const jsonFence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (jsonFence?.[1]) candidates.unshift(jsonFence[1].trim());

  for (const candidate of candidates) {
    if (!candidate.startsWith('[') && !candidate.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null && !Array.isArray(parsed[0])) {
        const keySet = new Set<string>();
        for (const item of parsed.slice(0, 50)) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const k of Object.keys(item)) keySet.add(k);
          }
        }
        const headers = [...keySet];
        if (headers.length === 0) continue;
        const rawRows = parsed.slice(0, 60).map((item) => {
          const rec = item as Record<string, unknown>;
          return headers.map((h) => rec[h] ?? null);
        });
        const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
        return { sourceKind: 'json_records', columns, rows: normalizedRows };
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.columns) && Array.isArray(obj.rows) && obj.rows.length > 0) {
          const headers = obj.columns.map((c) => String(c));
          const rawRows = (obj.rows as unknown[])
            .filter(Array.isArray)
            .slice(0, 60) as unknown[][];
          const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
          return {
            ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
            sourceKind: 'json_table',
            columns,
            rows: normalizedRows,
          };
        }
        // Key-value numeric map: { "API": 120, "Worker": 45 }
        const entries = Object.entries(obj).filter(
          ([, v]) => typeof v === 'number' || typeof v === 'string',
        );
        if (entries.length >= 2) {
          const headers = ['Item', 'Value'];
          const rawRows = entries.map(([k, v]) => [k, v]);
          const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
          return { sourceKind: 'json_records', columns, rows: normalizedRows };
        }
      }
    } catch {
      // Try next format
    }
  }
  return null;
}

function tryExtractMarkdownTable(text: string): StructuredDataset | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length - 2; i += 1) {
    const headerLine = lines[i]?.trim() ?? '';
    const dividerLine = lines[i + 1]?.trim() ?? '';
    if (!headerLine.includes('|') || !/^\|?[\s:-]+\|[\s|:-]+$/.test(dividerLine)) {
      continue;
    }
    const splitPipe = (line: string): string[] => {
      const stripped = line.replace(/^\|/, '').replace(/\|$/, '');
      return stripped.split('|').map((cell) => cell.trim().replace(/\*\*/g, '').replace(/`/g, ''));
    };

    const headers = splitPipe(headerLine);
    if (headers.length < 2) continue;

    const rawRows: string[][] = [];
    for (let j = i + 2; j < lines.length && rawRows.length < 60; j += 1) {
      const rowLine = lines[j]?.trim() ?? '';
      if (!rowLine.includes('|')) break;
      const cells = splitPipe(rowLine);
      if (cells.length >= 2) {
        rawRows.push(cells);
      }
    }

    if (rawRows.length >= 1) {
      let title: string | undefined;
      for (let k = i - 1; k >= Math.max(0, i - 4); k -= 1) {
        const heading = /^#{1,4}\s+(.+)$/.exec(lines[k]?.trim() ?? '');
        if (heading?.[1]) {
          title = heading[1].trim();
          break;
        }
      }
      const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
      return {
        ...(title ? { title } : {}),
        sourceKind: 'markdown_table',
        columns,
        rows: normalizedRows,
      };
    }
  }
  return null;
}

function tryExtractOpenUiBlock(text: string): StructuredDataset | null {
  const tableMatch = /Table\s*\(\s*(\[[^\]]+\])\s*,\s*(\[\s*\[[\s\S]*?\]\s*\])\s*\)/.exec(text);
  if (tableMatch?.[1] && tableMatch[2]) {
    try {
      const headers = JSON.parse(tableMatch[1]) as string[];
      const rawRows = JSON.parse(tableMatch[2]) as unknown[][];
      if (Array.isArray(headers) && Array.isArray(rawRows) && rawRows.length > 0) {
        const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
        return { sourceKind: 'openui_block', columns, rows: normalizedRows };
      }
    } catch {
      // Fall through
    }
  }
  return null;
}

function tryExtractCsv(text: string): StructuredDataset | null {
  const clean = text
    .trim()
    .replace(/^```(?:csv|tsv)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '');
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;

  const delim = lines[0]!.includes('\t') ? '\t' : ',';
  if (!lines[0]!.includes(delim)) return null;

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delim && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = parseLine(lines[0]!);
  if (headers.length < 2) return null;
  const rawRows = lines.slice(1, 61).map(parseLine);
  if (rawRows.some((r) => r.length !== headers.length)) return null;

  const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
  return { sourceKind: 'csv', columns, rows: normalizedRows };
}

/**
 * Extracts a normalized `StructuredDataset` from JSON records, `{ columns, rows }`,
 * Markdown pipe tables, existing `openui-lang` Table blocks, or CSV/TSV text.
 */
export function extractStructuredDataset(rawInput: string): StructuredDataset | null {
  return (
    tryExtractFromJson(rawInput) ??
    tryExtractOpenUiBlock(rawInput) ??
    tryExtractMarkdownTable(rawInput) ??
    tryExtractCsv(rawInput)
  );
}

/**
 * Builds the Stitch-Rapid style single-pass question bank over column profiles
 * and optional interactive quick-edit instruction (`editInstruction`).
 */
export function buildCompilerQuestions(
  dataset: StructuredDataset,
  editInstruction?: string,
): Readonly<Record<string, DecisionQuestion>> {
  const editPrefix = editInstruction?.trim()
    ? `Honor the user's explicit layout/edit instruction ("${editInstruction.trim()}") above defaults. `
    : '';

  const labelCriteria: Record<string, string> = {};
  for (const col of dataset.columns) {
    labelCriteria[col.safeKey] = `Column "${col.name}" (${col.kind}), samples: ${col.sampleValues
      .slice(0, 3)
      .join(', ')}`;
  }

  const questions: Record<string, DecisionQuestion> = {
    chart_kind: {
      type: 'choice',
      instructions: `${editPrefix}Choose the best primary openui-lang visual component for this dataset.`,
      criteria: {
        bar_ranked:
          'Standard BarChart comparing magnitudes across discrete categories or items.',
        bar_whole_share:
          'BarChart with whole=true where one series represents parts adding up to 100% or a single whole.',
        line_trend:
          'LineChart showing values ordered across time, dates, versions, or sequential steps.',
        progress_bars:
          'Stacked Progress bars when each row is an independent completion or utilization percentage (0..100).',
        stat_tiles_only:
          'Summary Stat tiles without a chart (only when <=2 rows or explicitly requested).',
      },
    },
    include_table: {
      type: 'noul',
      instructions: `${editPrefix}Should the compiled openui-lang block include a companion Table beneath the visual chart?`,
      criteria: {
        true_description:
          'Include a companion detail Table (recommended when >=3 columns or exact lookup values help alongside the chart, unless the user asked to hide the table).',
        false_description:
          'Omit the detail Table (user asked to hide the table, compact stats/chart only, or a 2-column chart already shows every value clearly).',
      },
    },
    include_stats: {
      type: 'noul',
      instructions: `${editPrefix}Should a compact top Row of hero Stat summary tiles be included above the chart?`,
      criteria: {
        true_description:
          'Include 2-4 summary Stat tiles highlighting key totals, averages, or leaders.',
        false_description:
          'Skip top Stat tiles when the user asked for a minimal chart-only view.',
      },
    },
    sort_order: {
      type: 'choice',
      instructions: `${editPrefix}How should rows be ordered in the chart and table?`,
      criteria: {
        asc_primary: 'Sort ascending (smallest to largest) by the primary metric.',
        desc_primary:
          'Sort descending (largest to smallest) by the primary metric—ideal for ranked category BarCharts.',
        preserve:
          'Preserve original row order—mandatory for chronological/time-series data or ordered stages.',
      },
    },
  };

  if (dataset.columns.length >= 2) {
    questions.label_col = {
      type: 'choice',
      instructions: `${editPrefix}Which column provides the x-axis category or time label for each row?`,
      criteria: labelCriteria,
    };
  }

  for (const col of dataset.columns) {
    if (col.kind !== 'number') continue;
    questions[`role_${col.index}`] = {
      type: 'choice',
      instructions: `${editPrefix}Assign a visual role to numeric column "${col.name}" (min=${col.min ?? 'n/a'}, max=${col.max ?? 'n/a'}, sum=${col.sum !== null ? Number(col.sum.toFixed(2)) : 'n/a'}).`,
      criteria: {
        hero_stat:
          'Show as a top summary Stat tile and table column, not plotted on the main chart axis (useful when units/scales differ drastically from the primary series).',
        omit: 'Exclude from the visual output (IDs, redundant index columns, or explicitly hidden).',
        primary_series:
          'Primary plotted Series on the BarChart / LineChart / Progress bars.',
        secondary_series:
          'Additional plotted Series sharing a comparable scale/unit with the primary series.',
        table_only: 'Keep in the companion Table only without plotting as a chart Series.',
      },
    };
  }

  return questions;
}

export function buildFallbackCompilerPlan(
  dataset: StructuredDataset,
  editInstruction?: string,
  ms = 0,
): CompilerPlan {
  const edit = (editInstruction ?? '').toLowerCase();
  const labelCol =
    dataset.columns.find((c) => c.kind === 'temporal') ??
    dataset.columns.find((c) => c.kind === 'string') ??
    dataset.columns[0];
  const labelColumnIndex = labelCol?.index ?? 0;

  const numericCols = dataset.columns.filter(
    (c) => c.kind === 'number' && c.index !== labelColumnIndex,
  );
  const firstNum = numericCols[0];

  let chartKind: CompilerChartKind = 'bar_ranked';
  if (edit.includes('line') || edit.includes('trend')) {
    chartKind = 'line_trend';
  } else if (edit.includes('whole') || edit.includes('share') || edit.includes('stack')) {
    chartKind = 'bar_whole_share';
  } else if (edit.includes('progress')) {
    chartKind = 'progress_bars';
  } else if (edit.includes('stat only') || edit.includes('stats only') || numericCols.length === 0) {
    chartKind = 'stat_tiles_only';
  } else if (labelCol?.kind === 'temporal') {
    chartKind = 'line_trend';
  } else if (firstNum?.looksLikePercentageShare) {
    chartKind = 'bar_whole_share';
  }

  let sortOrder: CompilerSortOrder =
    chartKind === 'line_trend' || labelCol?.kind === 'temporal' ? 'preserve' : 'desc_primary';
  if (edit.includes('asc') || edit.includes('lowest')) sortOrder = 'asc_primary';
  else if (edit.includes('desc') || edit.includes('highest') || edit.includes('rank'))
    sortOrder = 'desc_primary';
  else if (edit.includes('preserve') || edit.includes('original')) sortOrder = 'preserve';

  const includeTable =
    !edit.includes('no table') && !edit.includes('hide table') && dataset.rows.length > 1;
  const includeStats = !edit.includes('no stat') && !edit.includes('hide stat') && numericCols.length > 0;

  const columnRoles: Record<number, CompilerColumnRole> = {};
  numericCols.forEach((col, idx) => {
    if (idx === 0) {
      columnRoles[col.index] = 'primary_series';
    } else if (
      idx === 1 &&
      chartKind !== 'bar_whole_share' &&
      col.unit === firstNum?.unit &&
      firstNum?.max &&
      col.max &&
      Math.max(firstNum.max, col.max) / Math.max(1e-6, Math.min(Math.abs(firstNum.max), Math.abs(col.max))) <= 10
    ) {
      columnRoles[col.index] = 'secondary_series';
    } else if (idx <= 2) {
      columnRoles[col.index] = 'hero_stat';
    } else {
      columnRoles[col.index] = 'table_only';
    }
  });

  return {
    chartKind,
    chartConfidence: 1,
    includeTable,
    includeStats,
    sortOrder,
    labelColumnIndex,
    columnRoles,
    ms,
    questionCount: 0,
    usedFallbackHeuristics: true,
  };
}

function summarizeDatasetForPrompt(dataset: StructuredDataset, editInstruction?: string): string {
  const colLines = dataset.columns.map(
    (c) =>
      `- [${c.safeKey}] "${c.name}" (${c.kind}${c.unit ? `, unit=${c.unit}` : ''}${
        c.looksLikePercentageShare ? ', sums~100%' : ''
      }): samples=${JSON.stringify(c.sampleValues)}`,
  );
  const previewRows = dataset.rows.slice(0, 12).map((r) => JSON.stringify(r));
  return [
    dataset.title ? `Dataset Title: ${dataset.title}` : `Dataset (${dataset.rows.length} rows, source=${dataset.sourceKind})`,
    editInstruction?.trim() ? `User Layout / Quick-Edit Request: ${editInstruction.trim()}` : '',
    'Columns:',
    ...colLines,
    'Sample Rows:',
    ...previewRows,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatNumberCompact(num: number, unit?: string): string {
  const abs = Math.abs(num);
  let formatted: string;
  if (abs >= 1_000_000) formatted = `${(num / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  else if (abs >= 10_000) formatted = `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  else if (Number.isInteger(num)) formatted = String(num);
  else formatted = num.toFixed(2).replace(/\.?0+$/, '');

  if (!unit) return formatted;
  if (unit === '$' || unit === '€' || unit === '£') return `${unit}${formatted}`;
  if (unit === '%') return `${formatted}%`;
  return `${formatted} ${unit}`;
}

/**
 * Deterministically compiles a `StructuredDataset` + `CompilerPlan` into valid,
 * mobile-safe, Tufte-aligned `openui-lang` source (`root = Stack([...])`).
 */
export function emitOpenUiProgram(dataset: StructuredDataset, plan: CompilerPlan): string {
  const labelCol = dataset.columns[plan.labelColumnIndex] ?? dataset.columns[0]!;
  const numericCols = dataset.columns.filter(
    (c) => c.kind === 'number' && c.index !== labelCol.index,
  );

  let primaryCols = numericCols.filter((c) => plan.columnRoles[c.index] === 'primary_series');
  if (primaryCols.length === 0 && numericCols[0]) {
    primaryCols = [numericCols[0]];
  }
  const primaryCol = primaryCols[0];

  const secondaryCols =
    plan.chartKind === 'bar_whole_share'
      ? []
      : numericCols.filter(
          (c) =>
            c !== primaryCol &&
            (plan.columnRoles[c.index] === 'primary_series' ||
              plan.columnRoles[c.index] === 'secondary_series'),
        );

  const plottedCols = primaryCol ? [primaryCol, ...secondaryCols].slice(0, 4) : [];

  // Apply row sort without mutating input dataset
  const workingRows = [...dataset.rows];
  if (primaryCol && plan.sortOrder !== 'preserve') {
    const pIdx = primaryCol.index;
    workingRows.sort((a, b) => {
      const av = typeof a[pIdx] === 'number' ? (a[pIdx] as number) : Number.NEGATIVE_INFINITY;
      const bv = typeof b[pIdx] === 'number' ? (b[pIdx] as number) : Number.NEGATIVE_INFINITY;
      return plan.sortOrder === 'desc_primary' ? bv - av : av - bv;
    });
  }

  const rootChildren: string[] = [];
  const extraLines: string[] = [];

  // 1. Hero Stat Row (mobile-safe: Row of Stat tiles uses CSS grid auto-fill minmax(10rem,1fr))
  if (plan.includeStats && primaryCol && workingRows.length > 0) {
    const statDefs: string[] = [];
    const statCandidates = [
      primaryCol,
      ...numericCols.filter(
        (c) =>
          c !== primaryCol &&
          (plan.columnRoles[c.index] === 'hero_stat' ||
            plan.columnRoles[c.index] === 'secondary_series'),
      ),
    ].slice(0, 3);

    statCandidates.forEach((col, idx) => {
      const vals = workingRows
        .map((r) => r[col.index])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (vals.length === 0) return;

      const leaderRow = workingRows.reduce((best, cur) => {
        const bv = typeof best[col.index] === 'number' ? (best[col.index] as number) : -Infinity;
        const cv = typeof cur[col.index] === 'number' ? (cur[col.index] as number) : -Infinity;
        return cv > bv ? cur : best;
      }, workingRows[0]!);
      const leaderLabel = String(leaderRow[labelCol.index] ?? '').slice(0, 22);
      const leaderVal =
        typeof leaderRow[col.index] === 'number' ? (leaderRow[col.index] as number) : vals[0]!;

      const statId = `st_${idx + 1}`;
      const isIntensiveMetric =
        col.looksLikePercentageShare ||
        (col.unit !== undefined && /^(?:%|ms|s|us|ns|Hz|x)$/i.test(col.unit)) ||
        /\b(?:latency|p50|p90|p95|p99|rate|ratio|score|ece|err|error|avg|mean|duration)\b/i.test(
          col.name,
        );
      if (isIntensiveMetric) {
        const mean = vals.reduce((acc, v) => acc + v, 0) / vals.length;
        statDefs.push(
          `${statId} = Stat(${JSON.stringify(`Peak ${col.name}`)}, ${JSON.stringify(
            formatNumberCompact(leaderVal, col.unit),
          )}, ${JSON.stringify(`${leaderLabel} · avg ${formatNumberCompact(mean, col.unit)}`)}, "info")`,
        );
      } else {
        const total = vals.reduce((acc, v) => acc + v, 0);
        statDefs.push(
          `${statId} = Stat(${JSON.stringify(`Total ${col.name}`)}, ${JSON.stringify(
            formatNumberCompact(total, col.unit),
          )}, ${JSON.stringify(`Max: ${leaderLabel}`)}, ${idx === 0 ? '"success"' : '"neutral"'})`,
        );
      }
    });

    if (statDefs.length > 0) {
      const statRefs = statDefs.map((line) => line.split(' = ')[0]!);
      rootChildren.push('stats');
      extraLines.push(`stats = Row([${statRefs.join(', ')}])`);
      extraLines.push(...statDefs);
    }
  }

  // 2. Primary Visual (BarChart / LineChart / Progress)
  const labels = workingRows.map((r, idx) => String(r[labelCol.index] ?? `Row ${idx + 1}`));
  if (plottedCols.length > 0 && plan.chartKind !== 'stat_tiles_only') {
    if (plan.chartKind === 'progress_bars' && primaryCol) {
      const maxVal =
        primaryCol.max !== null && primaryCol.max > 100 ? Math.ceil(primaryCol.max) : 100;
      const progIds: string[] = [];
      workingRows.slice(0, 12).forEach((row, idx) => {
        const rawVal = typeof row[primaryCol.index] === 'number' ? (row[primaryCol.index] as number) : 0;
        const clamped = Math.max(0, rawVal);
        const pid = `prog_${idx + 1}`;
        progIds.push(pid);
        extraLines.push(
          maxVal === 100
            ? `${pid} = Progress(${JSON.stringify(labels[idx] ?? `Item ${idx + 1}`)}, ${Number(clamped.toFixed(2))})`
            : `${pid} = Progress(${JSON.stringify(labels[idx] ?? `Item ${idx + 1}`)}, ${Number(clamped.toFixed(2))}, ${maxVal})`,
        );
      });
      if (progIds.length > 0) {
        const cardTitle = (dataset.title ?? primaryCol.name).slice(0, 28);
        rootChildren.push('visual');
        extraLines.push(`visual = Card(${JSON.stringify(cardTitle)}, [${progIds.join(', ')}])`);
      }
    } else {
      const seriesIds: string[] = [];
      const seriesLines: string[] = [];
      plottedCols.forEach((col, idx) => {
        const sid = `ser_${idx + 1}`;
        seriesIds.push(sid);
        const values = workingRows.map((r) => {
          const v = r[col.index];
          return typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : null;
        });
        seriesLines.push(`${sid} = Series(${JSON.stringify(col.name)}, ${JSON.stringify(values)})`);
      });

      const unit = primaryCol?.unit;
      rootChildren.push('chart');
      if (plan.chartKind === 'line_trend') {
        extraLines.push(
          unit
            ? `chart = LineChart(${JSON.stringify(labels)}, [${seriesIds.join(', ')}], ${JSON.stringify(unit)})`
            : `chart = LineChart(${JSON.stringify(labels)}, [${seriesIds.join(', ')}])`,
        );
      } else if (plan.chartKind === 'bar_whole_share') {
        const singleSeries = seriesIds[0]!;
        extraLines.push(
          `chart = BarChart(${JSON.stringify(labels)}, [${singleSeries}], ${JSON.stringify(unit ?? '')}, true)`,
        );
      } else {
        extraLines.push(
          unit
            ? `chart = BarChart(${JSON.stringify(labels)}, [${seriesIds.join(', ')}], ${JSON.stringify(unit)})`
            : `chart = BarChart(${JSON.stringify(labels)}, [${seriesIds.join(', ')}])`,
        );
      }
      extraLines.push(...seriesLines);
    }
  }

  // 3. Companion Detail Table (stacked directly under Stack for 360px horizontal scroll safety)
  const visibleTableCols = dataset.columns.filter((c) => plan.columnRoles[c.index] !== 'omit');
  const forceTable = rootChildren.length === 0;
  if ((plan.includeTable || forceTable) && visibleTableCols.length > 0) {
    const colHeaders = visibleTableCols.map((c) => c.name);
    const tableRows = workingRows.slice(0, 30).map((row) =>
      visibleTableCols.map((col) => {
        const cell = row[col.index];
        if (cell === null || cell === undefined) return '—';
        if (typeof cell === 'number') {
          return Number.isInteger(cell) ? cell : Number(cell.toFixed(3));
        }
        return cell;
      }),
    );
    rootChildren.push('detail_table');
    extraLines.push(
      `detail_table = Table(${JSON.stringify(colHeaders)}, ${JSON.stringify(tableRows)})`,
    );
  }

  return [`root = Stack([${rootChildren.join(', ')}])`, ...extraLines].join('\n');
}

/**
 * Full Stitch-Rapid style compilation pipeline:
 * 1. Extracts `StructuredDataset`
 * 2. Evaluates all layout, column-binding, and quick-edit questions in ONE zero-output-token pass
 * 3. Deterministically emits lint-verified `openui-lang`
 */
export async function compileDatasetToUi(params: {
  readonly dataset: StructuredDataset;
  readonly editInstruction?: string;
  readonly client: DecisionBridgeClient;
  readonly timeoutMs?: number;
}): Promise<CompileUiResult> {
  const { dataset } = params;
  const questions = buildCompilerQuestions(dataset, params.editInstruction);
  const questionCount = Object.keys(questions).length;
  const promptText = summarizeDatasetForPrompt(dataset, params.editInstruction);

  const batch = await params.client.evaluate({
    input: promptText,
    questions,
    timeoutMs: params.timeoutMs ?? 3500,
  });

  let plan: CompilerPlan;
  if (!batch.ok) {
    plan = buildFallbackCompilerPlan(dataset, params.editInstruction, batch.ms);
  } else {
    const fallback = buildFallbackCompilerPlan(dataset, params.editInstruction, batch.ms);
    const chartAns = getChoiceAnswer(batch, 'chart_kind', CHART_KINDS, fallback.chartKind);
    const includeTableAns = getNoulAnswer(
      batch,
      'include_table',
      fallback.includeTable ? 0.8 : 0.2,
    );
    const includeStatsAns = getNoulAnswer(
      batch,
      'include_stats',
      fallback.includeStats ? 0.8 : 0.2,
    );
    const sortAns = getChoiceAnswer(batch, 'sort_order', SORT_ORDERS, fallback.sortOrder);

    const allowedLabelKeys = dataset.columns.map((c) => c.safeKey);
    const defaultLabelKey =
      dataset.columns[fallback.labelColumnIndex]?.safeKey ?? allowedLabelKeys[0] ?? '';
    const labelAns =
      allowedLabelKeys.length >= 2
        ? getChoiceAnswer(batch, 'label_col', allowedLabelKeys, defaultLabelKey)
        : { choice: defaultLabelKey, confidence: 1 };
    const chosenLabelCol =
      dataset.columns.find((c) => c.safeKey === labelAns.choice) ??
      dataset.columns[fallback.labelColumnIndex] ??
      dataset.columns[0]!;

    const columnRoles: Record<number, CompilerColumnRole> = {};
    for (const col of dataset.columns) {
      if (col.kind !== 'number' || col.index === chosenLabelCol.index) continue;
      const fbRole = fallback.columnRoles[col.index] ?? 'table_only';
      const roleAns = getChoiceAnswer(batch, `role_${col.index}`, COLUMN_ROLES, fbRole);
      columnRoles[col.index] = roleAns.choice;
    }

    let effectiveChartKind = chartAns.choice;
    const primaryCandidate =
      dataset.columns.find((c) => columnRoles[c.index] === 'primary_series') ??
      dataset.columns.find((c) => c.kind === 'number' && c.index !== chosenLabelCol.index);
    if (
      effectiveChartKind === 'bar_whole_share' &&
      primaryCandidate?.min !== null &&
      primaryCandidate !== undefined &&
      primaryCandidate.min < 0
    ) {
      effectiveChartKind = 'bar_ranked';
    }
    if (!primaryCandidate) {
      effectiveChartKind = 'stat_tiles_only';
    }

    plan = {
      chartKind: effectiveChartKind,
      chartConfidence: chartAns.confidence,
      includeTable: includeTableAns.probability >= 0.5,
      includeStats: includeStatsAns.probability >= 0.5,
      sortOrder: sortAns.choice,
      labelColumnIndex: chosenLabelCol.index,
      columnRoles,
      ms: batch.ms,
      questionCount,
      usedFallbackHeuristics: false,
    };
  }

  const source = emitOpenUiProgram(dataset, plan);
  const lint = lintOpenUiSource(source);

  return {
    ok: lint.valid,
    source,
    fencedMarkdown: `\`\`\`openui-lang\n${source}\n\`\`\``,
    dataset,
    plan,
    lint,
  };
}

export async function compileStructuredDataToUi(params: {
  readonly rawInput: string;
  readonly editInstruction?: string;
  readonly title?: string;
  readonly client: DecisionBridgeClient;
  readonly timeoutMs?: number;
}): Promise<CompileUiResult> {
  const extracted = extractStructuredDataset(params.rawInput);
  if (!extracted) {
    throw new Error(
      'Could not extract structured rows from input. Provide JSON records, { columns, rows }, CSV/TSV, a Markdown pipe table, or an openui-lang Table block.',
    );
  }

  const dataset: StructuredDataset = params.title
    ? { ...extracted, title: params.title }
    : extracted;

  return compileDatasetToUi({
    dataset,
    ...(params.editInstruction ? { editInstruction: params.editInstruction } : {}),
    client: params.client,
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
}
