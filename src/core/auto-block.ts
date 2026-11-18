import { lintOpenUiSource } from './ast-linter.ts';
import { getChoiceAnswer, getNoulAnswer, type DecisionBridgeClient } from './client.ts';
import type {
  CompileUiResult,
  DecisionQuestion,
  DecisionUiConfig,
  StructuredDataset,
} from './types.ts';
import {
  buildCompilerQuestions,
  buildFallbackCompilerPlan,
  compileDatasetToUi,
  emitOpenUiProgram,
  extractStructuredDataset,
} from './ui-compiler.ts';

export type AutoPresentationMode = 'verbatim' | 'chart' | 'stats_kv' | 'steps_flow';

export interface ExtractedKeyValueItem {
  readonly label: string;
  readonly value: string;
  readonly numericPercent?: number;
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error';
}

export interface ExtractedStepItem {
  readonly title: string;
  readonly detail?: string;
  readonly status: 'done' | 'current' | 'todo' | 'blocked';
}

export interface ArbitraryCandidates {
  readonly rawContent: string;
  readonly dataset: StructuredDataset | null;
  readonly kvItems: ReadonlyArray<ExtractedKeyValueItem>;
  readonly stepItems: ReadonlyArray<ExtractedStepItem>;
  readonly accompanyingProse: string;
}

export interface AutoVisualResult {
  readonly ok: boolean;
  readonly mode: AutoPresentationMode;
  readonly shouldVisualizeProbability: number;
  readonly manualOverride?: boolean;
  readonly modeConfidence: number;
  readonly ms: number;
  readonly questionCount: number;
  readonly rawContent: string;
  readonly keepProse: boolean;
  readonly accompanyingProse: string;
  readonly availableModes: ReadonlyArray<AutoPresentationMode>;
  readonly compiled?: CompileUiResult;
  readonly kvItems?: ReadonlyArray<ExtractedKeyValueItem>;
  readonly stepItems?: ReadonlyArray<ExtractedStepItem>;
  readonly openUiSource: string;
  readonly fencedMarkdown: string;
}

function inferStatusTone(val: string): ExtractedKeyValueItem['tone'] {
  const upper = val.trim().toUpperCase();
  if (/\b(?:OK|HEALTHY|ONLINE|ACTIVE|PASS|PASSED|READY|SUCCESS|NOMINAL)\b/.test(upper)) {
    return 'success';
  }
  if (/\b(?:WARN|WARNING|DEGRADED|SLOW|HIGH|PENDING|RETRY)\b/.test(upper)) {
    return 'warning';
  }
  if (/\b(?:ERR|ERROR|FAIL|FAILED|DOWN|OFFLINE|CRITICAL|BLOCKED)\b/.test(upper)) {
    return 'error';
  }
  return undefined;
}

function inferMetricHeaderFromUnit(unitHint: string, introText: string, fallback: string): string {
  const lowerIntro = introText.toLowerCase();
  const u = unitHint.trim();
  if (/^(?:ms|us|ns|s)$/i.test(u)) {
    if (lowerIntro.includes('p99')) return 'P99 Latency';
    if (lowerIntro.includes('p95')) return 'P95 Latency';
    if (lowerIntro.includes('duration')) return 'Duration';
    return 'Latency';
  }
  if (u === '%') {
    if (lowerIntro.includes('err') || fallback === 'Secondary') return 'Error Rate';
    if (lowerIntro.includes('pass')) return 'Pass Rate';
    if (lowerIntro.includes('share')) return 'Share';
    return 'Rate';
  }
  if (u === '$' || u === '€' || u === '£') return 'Cost';
  if (/^(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB|G|T)$/i.test(u)) return 'Size';
  if (/^(?:req\/s|ops\/s|Hz)$/i.test(u)) return 'Throughput';
  return fallback;
}

/**
 * Extracts CLI whitespace-aligned tables (e.g. `df -h`, `kubectl get`, `ps`, `docker stats`)
 * where 2+ consecutive spaces separate columns across >= 3 lines.
 */
function tryExtractCliColumns(text: string): {
  dataset: StructuredDataset;
  prose: string;
} | null {
  const clean = text
    .trim()
    .replace(/^```[a-z]*\s*\n/i, '')
    .replace(/\n```\s*$/i, '');
  const lines = clean.split(/\r?\n/);

  let tableStart = -1;
  let tableRows: string[][] = [];

  for (let i = 0; i < lines.length - 2; i += 1) {
    const headerCells = (lines[i] ?? '')
      .trim()
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (headerCells.length < 3) continue;
    if (headerCells.every((c) => /^[\d.,%-]+$/.test(c))) continue;

    const matched: string[][] = [headerCells];
    for (let j = i + 1; j < lines.length; j += 1) {
      const rowText = (lines[j] ?? '').trim();
      if (!rowText) break;
      const cells = rowText
        .split(/\s{2,}/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (cells.length === headerCells.length) {
        matched.push(cells);
      } else {
        break;
      }
    }

    if (matched.length >= 3) {
      tableStart = i;
      tableRows = matched;
      break;
    }
  }

  if (tableStart === -1 || tableRows.length < 3) return null;

  const csvEquivalent = tableRows
    .map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(','))
    .join('\n');
  const extracted = extractStructuredDataset(csvEquivalent);
  if (!extracted || !extracted.columns.some((c) => c.kind === 'number')) return null;

  const leadingLines = lines
    .slice(0, tableStart)
    .map((l) => l.trim())
    .filter(Boolean);
  const trailingLines = lines
    .slice(tableStart + tableRows.length)
    .map((l) => l.trim())
    .filter(Boolean);

  const title =
    leadingLines.length === 1
      ? leadingLines[0]!.replace(/^#{1,4}\s+/, '').replace(/:\s*$/, '')
      : undefined;
  const dataset: StructuredDataset = title ? { ...extracted, title } : extracted;
  const prose = [...(title ? [] : leadingLines), ...trailingLines].join('\n');

  return { dataset, prose };
}

/**
 * Extracts multi-item bulleted or line-by-line metric comparisons from prose, e.g.:
 * - auth-gateway: 38 ms (0.1% err)
 * - billing-worker: 215 ms (1.4% err)
 */
function tryExtractProseMetricList(text: string): {
  dataset: StructuredDataset;
  prose: string;
} | null {
  const lines = text.split(/\r?\n/);
  const metricRowRegex =
    /^(?:[-*•]|\d+[.)])?\s*`?([A-Za-z0-9_./ -]{2,38}?)`?\s*(?:[:—–-]\s*|\s+\()([+-]?[$€£]?\d[\d,.]*\s*(?:%|ms|us|ns|s|x|Hz|KB|MB|GB|TB|G|T|req\/s|ops\/s|k|M|B)?)(.*)$/i;

  const extractedRows: Array<{
    lineIdx: number;
    label: string;
    primaryRaw: string;
    secondaryRaw: string | null;
    unitHint: string;
    secUnitHint: string;
  }> = [];

  let nonNumericKvLineCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) continue;
    const m = metricRowRegex.exec(trimmed);
    if (!m?.[1] || !m[2]) {
      if (/^(?:[-*•]\s*)?[A-Za-z][A-Za-z0-9 _/-]{1,30}\s*:\s*\S+/.test(trimmed) && !trimmed.endsWith(':')) {
        nonNumericKvLineCount += 1;
      }
      continue;
    }

    const rest = (m[3] ?? '').trim();
    // Skip `18 / 20` capacity ratios (heterogeneous KV gauges rather than scalar series values)
    if (/^\/\s*\d+/.test(rest)) {
      nonNumericKvLineCount += 1;
      continue;
    }

    const label = m[1].trim().replace(/\*+/g, '');
    const primaryRaw = m[2].trim();
    const secMatch = /([+-]?[$€£]?\d[\d,.]*\s*(?:%|ms|us|ns|s|x|KB|MB|GB|TB)?)/i.exec(rest);
    const secondaryRaw = secMatch?.[1]?.trim() ?? null;
    const unitMatch = /(%|ms|us|ns|s|x|Hz|KB|MB|GB|TB|G|T|\$|€|£)/i.exec(primaryRaw);
    const secUnitMatch = secondaryRaw
      ? /(%|ms|us|ns|s|x|KB|MB|GB|TB|\$|€|£)/i.exec(secondaryRaw)
      : null;

    extractedRows.push({
      lineIdx: i,
      label,
      primaryRaw,
      secondaryRaw,
      unitHint: unitMatch?.[1] ?? '',
      secUnitHint: secUnitMatch?.[1] ?? '',
    });
  }

  if (extractedRows.length < 3 || nonNumericKvLineCount >= 2) return null;

  const unitCounts = new Map<string, number>();
  for (const r of extractedRows) {
    unitCounts.set(r.unitHint, (unitCounts.get(r.unitHint) ?? 0) + 1);
  }
  const topEntry = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (topEntry[1] < Math.ceil(extractedRows.length * 0.75)) {
    return null;
  }

  const hasSecondary =
    extractedRows.filter((r) => r.secondaryRaw !== null).length >=
    Math.ceil(extractedRows.length * 0.65);

  const firstRowLine = extractedRows[0]!.lineIdx;
  const lastRowLine = extractedRows.at(-1)!.lineIdx;

  const leadingLines = lines
    .slice(0, firstRowLine)
    .map((l) => l.trim())
    .filter(Boolean);
  const introText = leadingLines.join(' ');

  const primaryHeader = inferMetricHeaderFromUnit(topEntry[0], introText, 'Metric');
  const secUnit = extractedRows.find((r) => r.secUnitHint)?.secUnitHint ?? '';
  const secondaryHeader = inferMetricHeaderFromUnit(secUnit, introText, 'Secondary');

  const headers = hasSecondary ? ['Item', primaryHeader, secondaryHeader] : ['Item', primaryHeader];
  const csvLines = [
    headers.join(','),
    ...extractedRows.map((r) =>
      hasSecondary
        ? `"${r.label.replace(/"/g, '""')}","${r.primaryRaw}","${r.secondaryRaw ?? ''}"`
        : `"${r.label.replace(/"/g, '""')}","${r.primaryRaw}"`,
    ),
  ];

  const extracted = extractStructuredDataset(csvLines.join('\n'));
  if (!extracted) return null;

  let title: string | undefined;
  let keptLeading = leadingLines;
  if (leadingLines.length === 1 && (leadingLines[0]!.endsWith(':') || leadingLines[0]!.startsWith('#'))) {
    title = leadingLines[0]!.replace(/^#{1,4}\s+/, '').replace(/:\s*$/, '');
    keptLeading = [];
  }

  const consumedIdx = new Set(extractedRows.map((r) => r.lineIdx));
  const middleAndTrailing = lines
    .slice(firstRowLine)
    .map((l, offset) => ({ text: l.trim(), idx: firstRowLine + offset }))
    .filter((item) => item.text.length > 0 && !consumedIdx.has(item.idx) && item.idx > lastRowLine)
    .map((item) => item.text);

  const prose = [...keptLeading, ...middleAndTrailing].join('\n');
  const dataset: StructuredDataset = title ? { ...extracted, title } : extracted;

  return { dataset, prose };
}

function extractKeyValueCandidates(text: string): {
  items: ExtractedKeyValueItem[];
  prose: string;
} {
  const lines = text.split(/\r?\n/);
  const kvRegex = /^(?:[-*•]\s*)?\*{0,2}([A-Za-z][A-Za-z0-9 _/-]{1,32})\*{0,2}\s*:\s*(.{1,80})$/;
  const items: ExtractedKeyValueItem[] = [];
  const usedLines = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('http')) continue;
    const m = kvRegex.exec(trimmed);
    if (!m?.[1] || !m[2]) continue;
    const label = m[1].trim();
    const value = m[2].trim().replace(/\*+/g, '');

    let numericPercent: number | undefined;
    const pctMatch = /^(\d+(?:\.\d+)?)\s*%$/.exec(value);
    const ratioMatch = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\b|$)/.exec(value);
    if (pctMatch?.[1]) {
      const p = Number(pctMatch[1]);
      if (p >= 0 && p <= 100) numericPercent = p;
    } else if (ratioMatch?.[1] && ratioMatch[2]) {
      const num = Number(ratioMatch[1]);
      const den = Number(ratioMatch[2]);
      if (den > 0 && num >= 0 && num <= den) {
        numericPercent = Number(((num / den) * 100).toFixed(1));
      }
    }

    const tone = inferStatusTone(value);
    items.push({
      label,
      value,
      ...(numericPercent !== undefined ? { numericPercent } : {}),
      ...(tone ? { tone } : {}),
    });
    usedLines.add(i);
  }

  if (items.length < 3) return { items: [], prose: '' };
  const prose = lines
    .filter((_, idx) => !usedLines.has(idx))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return { items: items.slice(0, 14), prose };
}

function extractStepCandidates(text: string): {
  items: ExtractedStepItem[];
  prose: string;
} {
  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const rawLine of nonEmptyLines) {
    const line = rawLine.replace(/^`+|`+$/g, '').trim();
    if ((line.match(/->|→|⇒/g) ?? []).length >= 2 && line.length <= 260) {
      const parts = line
        .split(/\s*(?:->|→|⇒)\s*/)
        .map((s) => s.replace(/^`+|`+$/g, '').trim())
        .filter(Boolean);
      if (parts.length >= 3 && parts.length <= 10) {
        const items: ExtractedStepItem[] = parts.map((p, idx) => ({
          title: p,
          status: idx === 0 ? 'current' : 'todo',
        }));
        const prose = nonEmptyLines.filter((l) => l !== rawLine).join('\n');
        return { items, prose };
      }
    }
  }

  const lines = text.split(/\r?\n/);
  const stepRegex =
    /^(?:(\d+)[.)]\s+|[-*]\s*\[([ xX✓>-])\]\s+|(?:Step|Stage|Phase)\s+\d+\s*[:—-]\s*)(.+)$/i;
  const items: ExtractedStepItem[] = [];
  const used = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trim();
    const m = stepRegex.exec(trimmed);
    if (!m?.[3]) continue;

    const checkbox = m[2]?.toLowerCase();
    let body = m[3].trim();
    let status: ExtractedStepItem['status'] = 'todo';

    if (
      checkbox === 'x' ||
      checkbox === '✓' ||
      /\((?:done|completed|complete|passed)\)\s*$/i.test(body)
    ) {
      status = 'done';
    } else if (
      checkbox === '>' ||
      checkbox === '-' ||
      /\((?:current|running|in[- ]progress|active)\)\s*$/i.test(body)
    ) {
      status = 'current';
    } else if (/\((?:blocked|failed|error)\)\s*$/i.test(body)) {
      status = 'blocked';
    }

    body = body.replace(
      /\s*\((?:done|completed|complete|passed|current|running|in[- ]progress|active|blocked|failed|error|todo|pending)\)\s*$/i,
      '',
    );

    const splitIdx = body.indexOf(': ');
    const title = (splitIdx > 0 && splitIdx <= 84 ? body.slice(0, splitIdx) : body)
      .replace(/\*+/g, '')
      .trim();
    const detail = splitIdx > 0 && splitIdx <= 84 ? body.slice(splitIdx + 2).trim() : undefined;

    items.push({
      title,
      ...(detail ? { detail } : {}),
      status,
    });
    used.add(i);
  }

  if (items.length < 3) return { items: [], prose: '' };
  const prose = lines
    .filter((_, idx) => !used.has(idx))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return { items: items.slice(0, 12), prose };
}

function stripConsumedMarkdownTable(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i += 1) {
    const cur = (lines[i] ?? '').trim();
    const next = (lines[i + 1] ?? '').trim();
    if (!inTable && cur.includes('|') && /^\|?[\s:-]+\|[\s|:-]+$/.test(next)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (cur.includes('|')) continue;
      inTable = false;
    }
    if (cur && !/^#{1,4}\s+/.test(cur)) {
      kept.push(cur);
    }
  }
  return kept.join('\n');
}

export function extractArbitraryCandidates(rawContent: string): ArbitraryCandidates {
  const trimmed = rawContent.trim();
  const directDataset = extractStructuredDataset(trimmed);
  let dataset: StructuredDataset | null = directDataset;
  let datasetProse = '';

  if (directDataset) {
    if (directDataset.sourceKind === 'markdown_table') {
      datasetProse = stripConsumedMarkdownTable(trimmed);
    }
  } else {
    const cli = tryExtractCliColumns(trimmed);
    if (cli) {
      dataset = cli.dataset;
      datasetProse = cli.prose;
    } else {
      const proseList = tryExtractProseMetricList(trimmed);
      if (proseList) {
        dataset = proseList.dataset;
        datasetProse = proseList.prose;
      }
    }
  }

  const rawSteps = extractStepCandidates(trimmed);
  // Document-dominance guard: do not hoist a tiny inline snippet above a multi-section (>1,500 char) Markdown document
  const isLongMultiSectionDoc =
    trimmed.length > 1500 && (trimmed.match(/^#{1,3}\s+/gm) ?? []).length >= 3;
  const steps =
    isLongMultiSectionDoc && rawSteps.prose.length > trimmed.length * 0.8
      ? { items: [], prose: '' }
      : rawSteps;
  if (isLongMultiSectionDoc && dataset && datasetProse.length > trimmed.length * 0.8) {
    dataset = null;
    datasetProse = '';
  }

  // Only offer heterogeneous KV view when lines did not already form a homogeneous multi-row dataset or numbered step list
  const rawKv =
    dataset || steps.items.length >= 3
      ? { items: [], prose: '' }
      : extractKeyValueCandidates(trimmed);
  const kv =
    isLongMultiSectionDoc && rawKv.prose.length > trimmed.length * 0.8
      ? { items: [], prose: '' }
      : rawKv;

  const accompanyingProse = dataset
    ? datasetProse
    : steps.items.length > 0
      ? steps.prose
      : kv.items.length > 0
        ? kv.prose
        : '';

  return {
    rawContent: trimmed,
    dataset,
    kvItems: kv.items,
    stepItems: steps.items,
    accompanyingProse,
  };
}

function emitVerbatimOpenUi(rawContent: string): string {
  return `root = Stack([body])\nbody = Text(${JSON.stringify(rawContent)})`;
}

function emitKvOpenUi(
  items: ReadonlyArray<ExtractedKeyValueItem>,
  prose: string,
  keepProse: boolean,
): string {
  const children: string[] = [];
  const lines: string[] = [];

  const gaugeItems = items.filter((i) => i.numericPercent !== undefined).slice(0, 4);
  const statusItems = items.filter((i) => i.tone !== undefined).slice(0, 3);

  if (statusItems.length > 0) {
    const statIds = statusItems.map((item, idx) => {
      const id = `st_${idx + 1}`;
      lines.push(
        `${id} = Stat(${JSON.stringify(item.label)}, ${JSON.stringify(item.value)}, "", ${JSON.stringify(item.tone ?? 'neutral')})`,
      );
      return id;
    });
    children.push('stats');
    lines.push(`stats = Row([${statIds.join(', ')}])`);
  }

  if (gaugeItems.length > 0) {
    gaugeItems.forEach((g, idx) => {
      const pid = `pg_${idx + 1}`;
      children.push(pid);
      lines.push(`${pid} = Progress(${JSON.stringify(g.label)}, ${g.numericPercent!})`);
    });
  }

  const kvPairs = items.map((i) => ({ label: i.label, value: i.value }));
  children.push('kv');
  lines.push(`kv = KeyValue(${JSON.stringify(kvPairs)})`);

  if (keepProse && prose.trim()) {
    children.push('note');
    lines.push(`note = Text(${JSON.stringify(prose.trim())})`);
  }

  return [`root = Stack([${children.join(', ')}])`, ...lines].join('\n');
}

function emitStepsOpenUi(
  items: ReadonlyArray<ExtractedStepItem>,
  prose: string,
  keepProse: boolean,
): string {
  const children = ['flow'];
  const stepObjs = items.map((s) => ({
    title: s.title,
    ...(s.detail ? { markdown: s.detail } : {}),
    status: s.status,
  }));
  const lines = [`flow = Steps(${JSON.stringify(stepObjs)}, "column")`];

  if (keepProse && prose.trim()) {
    children.push('note');
    lines.push(`note = Text(${JSON.stringify(prose.trim())})`);
  }

  return [`root = Stack([${children.join(', ')}])`, ...lines].join('\n');
}

export async function evaluateAutoVisual(params: {
  readonly content: string;
  readonly intent?: string;
  readonly forceMode?: AutoPresentationMode;
  readonly client: DecisionBridgeClient;
  readonly config: DecisionUiConfig;
  readonly timeoutMs?: number;
}): Promise<AutoVisualResult> {
  const started = Date.now();
  const candidates = extractArbitraryCandidates(params.content);
  const intent = params.intent?.trim() ?? '';
  const lowerIntent = intent.toLowerCase();

  const availableModes: AutoPresentationMode[] = ['verbatim'];
  if (candidates.dataset && candidates.dataset.columns.some((c) => c.kind === 'number')) {
    availableModes.push('chart');
  }
  if (candidates.kvItems.length >= 3) {
    availableModes.push('stats_kv');
  }
  if (candidates.stepItems.length >= 3) {
    availableModes.push('steps_flow');
  }

  if (availableModes.length === 1) {
    const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
    return {
      ok: true,
      mode: 'verbatim',
      shouldVisualizeProbability: 0,
      modeConfidence: 1,
      ms: 0,
      questionCount: 0,
      rawContent: candidates.rawContent,
      keepProse: true,
      accompanyingProse: '',
      availableModes,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
    };
  }

  if (params.forceMode === 'verbatim' || lowerIntent === 'verbatim' || lowerIntent === 'raw text') {
    const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
    return {
      ok: true,
      mode: 'verbatim',
      shouldVisualizeProbability: 0,
      manualOverride: true,
      modeConfidence: 1,
      ms: Date.now() - started,
      questionCount: 0,
      rawContent: candidates.rawContent,
      keepProse: true,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      ...(candidates.kvItems.length > 0 ? { kvItems: candidates.kvItems } : {}),
      ...(candidates.stepItems.length > 0 ? { stepItems: candidates.stepItems } : {}),
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
    };
  }

  const explicitChartEdit =
    params.forceMode === 'chart' ||
    /\b(?:bar_ranked|bar_whole_share|whole share|line_trend|line chart|progress_bars|sort asc|sort desc|ranked bar)\b/i.test(
      intent,
    );

  if (explicitChartEdit && candidates.dataset) {
    // Preserve exact StructuredDataset (including column units!) without lossy CSV re-serialization
    const compiled = await compileDatasetToUi({
      dataset: candidates.dataset,
      ...(intent ? { editInstruction: intent } : {}),
      client: params.client,
      timeoutMs: params.timeoutMs ?? 3500,
    });

    const openUiSource =
      candidates.accompanyingProse.trim().length > 0
        ? compiled.source.replace(
            /^root = Stack\(\[([^\]]*)\]\)/,
            (_, inner: string) => `root = Stack([${inner ? `${inner}, ` : ''}prose_note])`,
          ) + `\nprose_note = Text(${JSON.stringify(candidates.accompanyingProse.trim())})`
        : compiled.source;

    return {
      ok: true,
      mode: 'chart',
      shouldVisualizeProbability: 0.99,
      manualOverride: Boolean(params.forceMode),
      modeConfidence: 1,
      ms: Date.now() - started,
      questionCount: compiled.plan.questionCount,
      rawContent: candidates.rawContent,
      keepProse: Boolean(candidates.accompanyingProse.trim()),
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      compiled,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
    };
  }

  const visualCandidates = availableModes.filter(
    (m): m is Exclude<AutoPresentationMode, 'verbatim'> => m !== 'verbatim',
  );

  const familyCriteria: Record<string, string> = {};
  if (visualCandidates.includes('chart')) {
    familyCriteria.chart =
      'Quantitative chart (BarChart, LineChart, or Progress) + hero Stats/Table for multi-item numeric comparisons, CLI tables, or trends.';
  }
  if (visualCandidates.includes('stats_kv')) {
    familyCriteria.stats_kv =
      'Structured KeyValue pairs with hero Stat badges and utilization Progress bars for heterogeneous system/status readouts.';
  }
  if (visualCandidates.includes('steps_flow')) {
    familyCriteria.steps_flow =
      'Connected Steps workflow diagram showing status (done, current, todo, blocked) across sequential stages.';
  }

  const questions: Record<string, DecisionQuestion> = {
    should_visualize: {
      type: 'noul',
      instructions: `${
        intent ? `Context/intent: "${intent}". ` : ''
      }Would rendering a native visual UI block (chart/bars, key-value gauges, or step flow) improve scannability over repeating the raw text verbatim?`,
      criteria: {
        true_description:
          'Tabular CLI command output (df, ps, docker, benchmarks), multi-item quantitative comparisons, utilization breakdowns, structured status KV dumps, or multi-stage checklists/pipelines.',
        false_description:
          'Narrative prose, debugging explanations, source code snippets, or conversational paragraphs where a visual widget would add noise.',
      },
    },
    ...(visualCandidates.length >= 2
      ? {
          visual_family: {
            type: 'choice' as const,
            instructions: `${
              intent ? `Honor intent "${intent}" if applicable. ` : ''
            }Which visual family fits this output best?`,
            criteria: familyCriteria,
          },
        }
      : {}),
    ...(candidates.accompanyingProse.trim()
      ? {
          keep_prose: {
            type: 'noul' as const,
            instructions:
              'Does the surrounding text outside the extracted items carry non-redundant explanation/context worth keeping below the visual?',
            criteria: {
              true_description:
                'Surrounding prose explains root causes, caveats, conclusions, or action items not shown in the numbers.',
              false_description: 'Surrounding text is just a generic lead-in like "Here are the results:".',
            },
          },
        }
      : {}),
    ...(candidates.dataset ? buildCompilerQuestions(candidates.dataset, intent) : {}),
  };

  const questionCount = Object.keys(questions).length;
  const candidateSummary = [
    intent ? `Agent/User Intent: ${intent}` : '',
    `Available candidate structures: ${availableModes.join(', ')}`,
    candidates.dataset
      ? `Extracted dataset: ${candidates.dataset.rows.length} rows x ${candidates.dataset.columns
          .map((c) => `${c.name}(${c.kind})`)
          .join(', ')}`
      : '',
    candidates.kvItems.length > 0 ? `Extracted KV pairs: ${candidates.kvItems.length}` : '',
    candidates.stepItems.length > 0 ? `Extracted steps: ${candidates.stepItems.length}` : '',
    `Raw Content:\n${candidates.rawContent.slice(0, 5000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const batch = await params.client.evaluate({
    input: candidateSummary,
    questions,
    timeoutMs: params.timeoutMs ?? 3800,
  });

  const ms = Date.now() - started;

  if (!batch.ok) {
    const fbMode: AutoPresentationMode =
      params.forceMode ??
      (availableModes.includes('chart')
        ? 'chart'
        : availableModes.includes('steps_flow')
          ? 'steps_flow'
          : availableModes.includes('stats_kv')
            ? 'stats_kv'
            : 'verbatim');

    return buildResultForChosenMode({
      chosenMode: fbMode,
      shouldVisProb: fbMode === 'verbatim' ? 0.1 : 0.8,
      modeConf: 1,
      keepProse: Boolean(candidates.accompanyingProse.trim()),
      ms,
      questionCount,
      candidates,
      availableModes,
      batch: null,
      intent,
    });
  }

  const shouldVis = getNoulAnswer(batch, 'should_visualize', 0.5);
  const defaultFamily = visualCandidates[0] ?? 'chart';
  const familyAns =
    visualCandidates.length >= 2
      ? getChoiceAnswer(batch, 'visual_family', visualCandidates, defaultFamily)
      : { choice: defaultFamily, confidence: shouldVis.confidence };
  const keepProseAns = candidates.accompanyingProse.trim()
    ? getNoulAnswer(batch, 'keep_prose', 0.7)
    : { probability: 0, confidence: 1 };

  const chosenMode: AutoPresentationMode =
    params.forceMode && availableModes.includes(params.forceMode)
      ? params.forceMode
      : shouldVis.probability < 0.5
        ? 'verbatim'
        : familyAns.choice;

  return buildResultForChosenMode({
    chosenMode,
    shouldVisProb: shouldVis.probability,
    modeConf: familyAns.confidence,
    keepProse: keepProseAns.probability >= 0.45,
    ms,
    questionCount,
    candidates,
    availableModes,
    batch,
    intent,
  });
}

function buildResultForChosenMode(params: {
  readonly chosenMode: AutoPresentationMode;
  readonly shouldVisProb: number;
  readonly modeConf: number;
  readonly keepProse: boolean;
  readonly ms: number;
  readonly questionCount: number;
  readonly candidates: ArbitraryCandidates;
  readonly availableModes: ReadonlyArray<AutoPresentationMode>;
  readonly batch: Awaited<ReturnType<DecisionBridgeClient['evaluate']>> | null;
  readonly intent: string;
}): AutoVisualResult {
  const { chosenMode, candidates, keepProse, availableModes } = params;

  if (chosenMode === 'chart' && candidates.dataset) {
    const dataset = candidates.dataset;
    const fbPlan = buildFallbackCompilerPlan(dataset, params.intent, params.ms);

    let plan = fbPlan;
    if (params.batch?.ok) {
      const chartAns = getChoiceAnswer(
        params.batch,
        'chart_kind',
        ['bar_ranked', 'bar_whole_share', 'line_trend', 'progress_bars', 'stat_tiles_only'] as const,
        fbPlan.chartKind,
      );
      const incTable = getNoulAnswer(
        params.batch,
        'include_table',
        fbPlan.includeTable ? 0.8 : 0.2,
      );
      const incStats = getNoulAnswer(
        params.batch,
        'include_stats',
        fbPlan.includeStats ? 0.8 : 0.2,
      );
      const sortAns = getChoiceAnswer(
        params.batch,
        'sort_order',
        ['preserve', 'desc_primary', 'asc_primary'] as const,
        fbPlan.sortOrder,
      );
      const labelKeys = dataset.columns.map((c) => c.safeKey);
      const defKey = dataset.columns[fbPlan.labelColumnIndex]?.safeKey ?? labelKeys[0] ?? '';
      const labelAns =
        labelKeys.length >= 2
          ? getChoiceAnswer(params.batch, 'label_col', labelKeys, defKey)
          : { choice: defKey, confidence: 1 };
      const chosenLabel =
        dataset.columns.find((c) => c.safeKey === labelAns.choice) ??
        dataset.columns[fbPlan.labelColumnIndex] ??
        dataset.columns[0]!;

      const roles: Record<
        number,
        'primary_series' | 'secondary_series' | 'hero_stat' | 'table_only' | 'omit'
      > = {};
      for (const col of dataset.columns) {
        if (col.kind !== 'number' || col.index === chosenLabel.index) continue;
        const rAns = getChoiceAnswer(
          params.batch,
          `role_${col.index}`,
          ['primary_series', 'secondary_series', 'hero_stat', 'table_only', 'omit'] as const,
          fbPlan.columnRoles[col.index] ?? 'table_only',
        );
        roles[col.index] = rAns.choice;
      }

      plan = {
        chartKind: chartAns.choice,
        chartConfidence: chartAns.confidence,
        includeTable: incTable.probability >= 0.5,
        includeStats: incStats.probability >= 0.5,
        sortOrder: sortAns.choice,
        labelColumnIndex: chosenLabel.index,
        columnRoles: roles,
        ms: params.ms,
        questionCount: params.questionCount,
        usedFallbackHeuristics: false,
      };
    }

    const chartSource = emitOpenUiProgram(dataset, plan);
    const lint = lintOpenUiSource(chartSource);
    const compiled: CompileUiResult = {
      ok: lint.valid,
      source: chartSource,
      fencedMarkdown: `\`\`\`openui-lang\n${chartSource}\n\`\`\``,
      dataset,
      plan,
      lint,
    };

    const fullSource =
      keepProse && candidates.accompanyingProse.trim()
        ? chartSource.replace(
            /^root = Stack\(\[([^\]]*)\]\)/,
            (_, inner: string) => `root = Stack([${inner ? `${inner}, ` : ''}prose_note])`,
          ) + `\nprose_note = Text(${JSON.stringify(candidates.accompanyingProse.trim())})`
        : chartSource;

    return {
      ok: true,
      mode: 'chart',
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      compiled,
      openUiSource: fullSource,
      fencedMarkdown: `\`\`\`openui-lang\n${fullSource}\n\`\`\``,
    };
  }

  if (chosenMode === 'stats_kv' && candidates.kvItems.length > 0) {
    const openUiSource = emitKvOpenUi(candidates.kvItems, candidates.accompanyingProse, keepProse);
    return {
      ok: true,
      mode: 'stats_kv',
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      kvItems: candidates.kvItems,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
    };
  }

  if (chosenMode === 'steps_flow' && candidates.stepItems.length > 0) {
    const openUiSource = emitStepsOpenUi(
      candidates.stepItems,
      candidates.accompanyingProse,
      keepProse,
    );
    return {
      ok: true,
      mode: 'steps_flow',
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      stepItems: candidates.stepItems,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
    };
  }

  const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
  return {
    ok: true,
    mode: 'verbatim',
    shouldVisualizeProbability: params.shouldVisProb,
    modeConfidence: params.modeConf,
    ms: params.ms,
    questionCount: params.questionCount,
    rawContent: candidates.rawContent,
    keepProse: true,
    accompanyingProse: candidates.accompanyingProse,
    availableModes,
    ...(candidates.kvItems.length > 0 ? { kvItems: candidates.kvItems } : {}),
    ...(candidates.stepItems.length > 0 ? { stepItems: candidates.stepItems } : {}),
    openUiSource,
    fencedMarkdown: `\`\`\`openui-lang\n${openUiSource}\n\`\`\``,
  };
}
