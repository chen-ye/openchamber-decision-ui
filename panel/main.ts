import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountButton,
  mountSelect,
  mountSwitch,
  mountTabs,
  mountTextField,
  type BadgeHandle,
  type ButtonHandle,
  type CheckboxHandle,
  type SelectHandle,
  type TabsHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';
import type { AutoVisualResult } from '../src/core/auto-block.ts';
import type {
  DecisionUiStatusSnapshot,
  RenderGateResult,
} from '../src/core/types.ts';

const COMPILER_SAMPLES = [
  {
    id: 'latency',
    label: 'Model Routing Latency & Cost',
    hint: 'Markdown',
    data: [
      '### Inference Tier Comparison',
      '| Tier | Median Latency | Cost per 1M | Calibration ECE |',
      '| --- | --- | --- | --- |',
      '| gemini-decision-1 | 85 ms | $0.10 | 0.018 |',
      '| gemini-3.5-flash-lite | 410 ms | $0.48 | 0.054 |',
      '| gemini-3.8-flash | 920 ms | $1.25 | 0.041 |',
      '| torchcast-decision-4b | 62 ms | $0.00 | 0.039 |',
    ].join('\n'),
  },
  {
    id: 'prose_bullets',
    label: 'Freeform Prose + Bullet Metrics',
    hint: 'Arbitrary Text',
    data: [
      'Endpoint benchmark summary after deploying connection pooling:',
      '- auth-gateway: 38 ms (0.1%)',
      '- billing-worker: 215 ms (1.4%)',
      '- search-index: 94 ms (0.3%)',
      '- media-edge: 51 ms (0.2%)',
      'Billing worker remains bottlenecked on serialized ledger writes.',
    ].join('\n'),
  },
  {
    id: 'narrative_verbatim',
    label: 'Plain Code Explanation (Chosen Verbatim)',
    hint: 'Verbatim',
    data: 'The reconnect race occurred because `flushPending()` acquired `sessionLock` while the 5s heartbeat timer already held it. Moving buffer drain outside the lock resolves the hang.',
  },
  {
    id: 'shares',
    label: 'Token Budget Breakdown',
    hint: 'JSON',
    data: JSON.stringify(
      [
        { component: 'Code Context', share: 48 },
        { component: 'Tool Schemas', share: 24 },
        { component: 'Session History', share: 19 },
        { component: 'UI Guidance', share: 9 },
      ],
      null,
      2,
    ),
  },
];

const QUICK_EDITS = [
  { id: 'verbatim', label: 'Verbatim', edit: 'verbatim' },
  { id: 'bar_ranked', label: 'Ranked Bar', edit: 'bar_ranked sorted descending' },
  { id: 'bar_whole_share', label: 'Whole Share', edit: 'bar_whole_share showing shares of whole' },
  { id: 'line_trend', label: 'Line Trend', edit: 'line_trend preserving chronological order' },
  { id: 'progress_bars', label: 'Progress Bars', edit: 'progress_bars per item' },
  { id: 'no_table', label: 'Hide Table', edit: 'omit detail table, chart and stats only' },
];

const GATE_SAMPLES = [
  {
    id: 'html_overflow_defect',
    label: 'HTML Defect: 680px Fixed Row on 360px Mobile',
    hint: 'Overflow',
    code: `<div style="display:flex;gap:16px;width:680px;padding:12px;border:2px solid #555;border-radius:12px">
  <div class="oc-box" style="min-width:320px"><h3>Primary Flight Bus</h3><p class="oc-muted">128 channels active at 50 Hz</p></div>
  <div class="oc-box" style="min-width:320px"><h3>Backup Telemetry Bus</h3><p class="oc-muted">Standby mirror nominal</p></div>
</div>`,
  },
  {
    id: 'html_clean_svg',
    label: 'HTML Clean: Fluid Architecture Diagram',
    hint: 'Responsive',
    code: `<div class="oc-box" style="display:flex;flex-direction:column;gap:0.6rem">
  <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.4rem">
    <strong>Decision Control Plane</strong>
    <span class="oc-badge" data-tone="success">150 ms prefill</span>
  </div>
  <svg viewBox="0 0 320 84" width="100%" height="84" role="img" aria-label="Pipeline">
    <rect x="4" y="18" width="88" height="48" rx="8" fill="#1d2026" stroke="#60a5fa" stroke-width="1.5"/>
    <text x="48" y="46" text-anchor="middle" fill="#eceef2" font-size="11">Prompt</text>
    <path d="M92 42 H116" stroke="#939aa8" stroke-width="1.5"/>
    <rect x="116" y="18" width="88" height="48" rx="8" fill="#1d2026" stroke="#34d399" stroke-width="1.5"/>
    <text x="160" y="46" text-anchor="middle" fill="#eceef2" font-size="11">:4006 Bridge</text>
    <path d="M204 42 H228" stroke="#939aa8" stroke-width="1.5"/>
    <rect x="228" y="18" width="88" height="48" rx="8" fill="#1d2026" stroke="#a78bfa" stroke-width="1.5"/>
    <text x="272" y="46" text-anchor="middle" fill="#eceef2" font-size="11">openui-lang</text>
  </svg>
</div>`,
  },
  {
    id: 'ui_tufte_defect',
    label: 'openui-lang Defect: Naked Numeric Table + Long Badge',
    hint: 'AST + Tufte',
    code: [
      'root = Stack([c, t])',
      'c = Card("Gateway Node", [Badge("ONLINE ON US-WEST-2 CLUSTER PRIMARY", "success"), Text("Status overview")])',
      't = Table(["Service", "P95 (ms)", "Error %"], [["auth", 42, 0.1], ["billing", 188, 1.4], ["search", 95, 0.3]])',
    ].join('\n'),
  },
];

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root')!;

let mounted = false;
let activeTab = 'compiler';
let draftData = COMPILER_SAMPLES[0]!.data;
let draftEdit = '';
let draftGateSource = GATE_SAMPLES[0]!.code;
let criticHasRunOnce = false;
let lastCompiled: AutoVisualResult | null = null;

let bridgeBadge: BadgeHandle | null = null;
let tabsHandle: TabsHandle | null = null;
let compilerSelectHandle: SelectHandle | null = null;
let dataInputField: TextFieldHandle | null = null;
let customEditField: TextFieldHandle | null = null;
let compileBtn: ButtonHandle | null = null;
let copyFenceBtn: ButtonHandle | null = null;
let insertChatBtn: ButtonHandle | null = null;

let gateSelectHandle: SelectHandle | null = null;
let gateSourceField: TextFieldHandle | null = null;
let runGateBtn: ButtonHandle | null = null;

let routerSwitch: CheckboxHandle | null = null;
let gateSwitch: CheckboxHandle | null = null;
let criticSwitch: CheckboxHandle | null = null;
let turnEndSwitch: CheckboxHandle | null = null;

let compilerPaneEl: HTMLElement;
let criticPaneEl: HTMLElement;
let telemetryPaneEl: HTMLElement;

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

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await host.serviceRequest({
    method: 'POST',
    path,
    body: JSON.stringify(body),
  });
  const parsed: unknown = typeof res.body === 'string' && res.body ? JSON.parse(res.body) : res.body;
  if (res.status >= 400) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Service returned HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return parsed as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await host.serviceRequest({ method: 'GET', path });
  const parsed: unknown = typeof res.body === 'string' && res.body ? JSON.parse(res.body) : res.body;
  return parsed as T;
}

const TAB_ITEMS = [
  { id: 'compiler', label: 'Stitch Compiler' },
  { id: 'critic', label: 'Critic & Gate' },
  { id: 'telemetry', label: 'Live Status' },
];

function switchTab(nextId: string): void {
  activeTab = nextId;
  compilerPaneEl.hidden = nextId !== 'compiler';
  criticPaneEl.hidden = nextId !== 'critic';
  telemetryPaneEl.hidden = nextId !== 'telemetry';
  tabsHandle?.update({ items: TAB_ITEMS, activeId: nextId, trackBackground: true });
  if (nextId === 'critic' && !criticHasRunOnce) {
    criticHasRunOnce = true;
    void runCriticAudit();
  }
}

function mountApp(): void {
  const header = el('div', 'du-header');
  const titleGroup = el('div', 'du-title-group');
  titleGroup.appendChild(el('h1', 'du-title', 'Decision UI'));
  const badgeWrap = el('span');
  bridgeBadge = mountBadge(badgeWrap, { label: 'Connecting…', tone: 'neutral' });
  titleGroup.appendChild(badgeWrap);
  header.appendChild(titleGroup);

  const headerActions = el('div', 'du-actions');
  const refreshWrap = el('span');
  mountButton(refreshWrap, {
    label: 'Refresh',
    variant: 'outline',
    size: 'xs',
    onClick: () => {
      void refreshTelemetry();
    },
  });
  headerActions.appendChild(refreshWrap);
  header.appendChild(headerActions);
  root.appendChild(header);

  const tabsWrap = el('div');
  compilerPaneEl = el('div', 'du-stack');
  criticPaneEl = el('div', 'du-stack');
  telemetryPaneEl = el('div', 'du-stack');

  tabsHandle = mountTabs(tabsWrap, {
    items: TAB_ITEMS,
    activeId: activeTab,
    trackBackground: true,
    onChange: switchTab,
  });

  root.appendChild(tabsWrap);
  root.appendChild(compilerPaneEl);
  root.appendChild(criticPaneEl);
  root.appendChild(telemetryPaneEl);

  buildCompilerTab(compilerPaneEl);
  buildCriticTab(criticPaneEl);
  buildTelemetryTab(telemetryPaneEl);
  renderOfflineTelemetryState('Loading service metrics…');
  switchTab(activeTab);
}

let compilerOutputWrap: HTMLElement;
let compilerMetaRow: HTMLElement;
let chipButtons: HTMLButtonElement[] = [];

function syncOutputButtons(): void {
  const ready = lastCompiled !== null;
  copyFenceBtn?.update({
    label: 'Copy Fence',
    variant: 'outline',
    size: 'xs',
    disabled: !ready,
    onClick: handleCopyFence,
  });
  insertChatBtn?.update({
    label: 'Insert in Chat',
    variant: 'outline',
    size: 'xs',
    disabled: !ready,
    onClick: handleInsertChat,
  });
}

function handleCopyFence(): void {
  if (!lastCompiled) return;
  void host
    .writeClipboard(lastCompiled.fencedMarkdown)
    .then(() =>
      host.toast({ kind: 'success', message: 'Copied openui-lang fence to clipboard' }),
    )
    .catch((err) =>
      host.toast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed copying to clipboard',
      }),
    );
}

function handleInsertChat(): void {
  if (!lastCompiled) return;
  void host
    .compose({ text: lastCompiled.fencedMarkdown, mode: 'append' })
    .then(() => host.toast({ kind: 'success', message: 'Inserted into chat composer' }))
    .catch((err) =>
      host.toast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not insert into composer',
      }),
    );
}

function buildCompilerTab(container: HTMLElement): void {
  const inputCard = el('div', 'du-surface');
  const titleStack = el('div', 'du-section-title-stack');
  titleStack.appendChild(el('div', 'du-section-title', 'Zero-Token Data → openui-lang'));
  titleStack.appendChild(el('div', 'du-muted', 'Single prefill pass on :4006 · 0 output tokens'));
  inputCard.appendChild(titleStack);

  const presetWrap = el('div');
  compilerSelectHandle = mountSelect(presetWrap, {
    label: 'Sample dataset',
    options: COMPILER_SAMPLES.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    value: COMPILER_SAMPLES[0]!.id,
    onChange: (nextId) => {
      compilerSelectHandle?.update({ value: nextId });
      const sample = COMPILER_SAMPLES.find((s) => s.id === nextId);
      if (sample) {
        draftData = sample.data;
        draftEdit = '';
        dataInputField?.update({ value: draftData });
        customEditField?.update({ value: '' });
        updateChipPressed();
        void runCompile();
      }
    },
  });
  inputCard.appendChild(presetWrap);

  const dataWrap = el('div');
  dataInputField = mountTextField(dataWrap, {
    label: 'Arbitrary agent output (prose, CLI dump, checklist, table, CSV, or JSON)',
    multiline: true,
    rows: 8,
    mono: true,
    value: draftData,
    onChange: (val) => {
      draftData = val;
    },
  });
  inputCard.appendChild(dataWrap);

  inputCard.appendChild(el('div', 'du-muted', 'Instant Stitch-style view transforms (~200 ms):'));
  const chipRow = el('div', 'du-chip-row');
  chipButtons = QUICK_EDITS.map((item) => {
    const btn = el('button', 'du-chip', item.label);
    btn.type = 'button';
    btn.dataset.edit = item.edit;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      draftEdit = draftEdit === item.edit ? '' : item.edit;
      customEditField?.update({ value: draftEdit });
      updateChipPressed();
      void runCompile();
    });
    chipRow.appendChild(btn);
    return btn;
  });
  inputCard.appendChild(chipRow);

  const editWrap = el('div');
  customEditField = mountTextField(editWrap, {
    label: 'Custom quick-edit instruction (optional)',
    placeholder: 'e.g. line chart sorted ascending, hide stats',
    value: draftEdit,
    onChange: (val) => {
      draftEdit = val;
      updateChipPressed();
    },
  });
  inputCard.appendChild(editWrap);

  const btnRow = el('div', 'du-actions');
  const runWrap = el('span');
  compileBtn = mountButton(runWrap, {
    label: 'Compile UI Block',
    variant: 'default',
    size: 'sm',
    onClick: () => {
      void runCompile();
    },
  });
  btnRow.appendChild(runWrap);
  inputCard.appendChild(btnRow);
  container.appendChild(inputCard);

  const outCard = el('div', 'du-surface');
  const outHead = el('div', 'du-section-head');
  outHead.appendChild(el('div', 'du-section-title', 'Compiled Output'));

  const outBtns = el('div', 'du-actions');
  const copyWrap = el('span');
  copyFenceBtn = mountButton(copyWrap, {
    label: 'Copy Fence',
    variant: 'outline',
    size: 'xs',
    disabled: true,
    onClick: handleCopyFence,
  });
  const composeWrap = el('span');
  insertChatBtn = mountButton(composeWrap, {
    label: 'Insert in Chat',
    variant: 'outline',
    size: 'xs',
    disabled: true,
    onClick: handleInsertChat,
  });
  outBtns.appendChild(copyWrap);
  outBtns.appendChild(composeWrap);
  outHead.appendChild(outBtns);
  outCard.appendChild(outHead);

  compilerMetaRow = el('div', 'du-grid');
  outCard.appendChild(compilerMetaRow);

  compilerOutputWrap = el('div');
  compilerOutputWrap.appendChild(
    el('div', 'du-muted', 'Click "Compile UI Block" or select a quick-edit pill above.'),
  );
  outCard.appendChild(compilerOutputWrap);
  container.appendChild(outCard);
}

function updateChipPressed(): void {
  for (const btn of chipButtons) {
    btn.setAttribute('aria-pressed', btn.dataset.edit === draftEdit ? 'true' : 'false');
  }
}

async function runCompile(): Promise<void> {
  const rawInput = draftData.trim();
  if (!rawInput) return;
  lastCompiled = null;
  syncOutputButtons();
  compileBtn?.update({ label: 'Evaluate & Render', variant: 'default', size: 'sm', loading: true, disabled: true, onClick: () => void runCompile() });
  try {
    const intent = draftEdit.trim() || undefined;
    const res = await apiPost<AutoVisualResult>('/auto-visual', {
      content: rawInput,
      intent,
    });
    lastCompiled = res;
    syncOutputButtons();
    renderCompiledOutput(res);
    void refreshTelemetry();
  } catch (err) {
    lastCompiled = null;
    syncOutputButtons();
    compilerMetaRow.replaceChildren();
    compilerOutputWrap.replaceChildren();
    const errBox = el('div', 'du-finding', err instanceof Error ? err.message : String(err));
    errBox.dataset.severity = 'error';
    compilerOutputWrap.appendChild(errBox);
  } finally {
    compileBtn?.update({ label: 'Evaluate & Render', variant: 'default', size: 'sm', loading: false, disabled: false, onClick: () => void runCompile() });
  }
}

function makeStatTile(label: string, value: string): HTMLElement {
  const tile = el('div', 'du-stat');
  tile.appendChild(el('div', 'du-stat-label', label));
  const v = el('div', 'du-stat-value', value);
  v.title = value;
  tile.appendChild(v);
  return tile;
}

function renderCompiledOutput(res: AutoVisualResult): void {
  const modeLabel =
    res.mode === 'chart' ? res.compiled?.plan.chartKind ?? 'chart' : res.mode;
  compilerMetaRow.replaceChildren(
    makeStatTile('Decision', modeLabel),
    makeStatTile('p(visualize)', res.shouldVisualizeProbability.toFixed(2)),
    makeStatTile('Latency', `${res.ms} ms`),
    makeStatTile('Pass', res.questionCount === 0 ? '0 ms fast' : `${res.questionCount} Qs · 0 out`),
  );

  compilerOutputWrap.replaceChildren();
  compilerOutputWrap.appendChild(
    el(
      'pre',
      'du-code',
      res.mode === 'verbatim' ? res.rawContent : res.fencedMarkdown,
    ),
  );
}

let criticSummaryGrid: HTMLElement;
let criticFindingsWrap: HTMLElement;
let criticShotsWrap: HTMLElement;

function detectSourceMode(code: string): 'ui' | 'html' {
  if (/<[a-z!][\s\S]*>/i.test(code)) return 'html';
  if (/^\s*(?:```openui(?:-lang)?|[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*[A-Z])/m.test(code)) return 'ui';
  return 'html';
}

function buildCriticTab(container: HTMLElement): void {
  const card = el('div', 'du-surface');
  const titleStack = el('div', 'du-section-title-stack');
  titleStack.appendChild(el('div', 'du-section-title', 'Render Gate & 360px/720px Visual Critic'));
  titleStack.appendChild(el('div', 'du-muted', 'Static AST lints + multimodal Gemini Decision 1'));
  card.appendChild(titleStack);

  const sampleWrap = el('div');
  gateSelectHandle = mountSelect(sampleWrap, {
    label: 'Inspection preset',
    options: GATE_SAMPLES.map((s) => ({ id: s.id, label: s.label, hint: s.hint })),
    value: GATE_SAMPLES[0]!.id,
    onChange: (nextId) => {
      gateSelectHandle?.update({ value: nextId });
      const sample = GATE_SAMPLES.find((s) => s.id === nextId);
      if (sample) {
        draftGateSource = sample.code;
        gateSourceField?.update({ value: draftGateSource });
        void runCriticAudit();
      }
    },
  });
  card.appendChild(sampleWrap);

  const srcWrap = el('div');
  gateSourceField = mountTextField(srcWrap, {
    label: 'HTML document or openui-lang source',
    multiline: true,
    rows: 7,
    mono: true,
    value: draftGateSource,
    onChange: (val) => {
      draftGateSource = val;
    },
  });
  card.appendChild(srcWrap);

  const btnRow = el('div', 'du-actions');
  const runWrap = el('span');
  runGateBtn = mountButton(runWrap, {
    label: 'Audit & Capture 360px / 720px',
    variant: 'default',
    size: 'sm',
    onClick: () => {
      void runCriticAudit();
    },
  });
  btnRow.appendChild(runWrap);
  card.appendChild(btnRow);
  container.appendChild(card);

  const resCard = el('div', 'du-surface');
  resCard.appendChild(el('div', 'du-section-title', 'Diagnostic Report'));
  criticSummaryGrid = el('div', 'du-grid');
  resCard.appendChild(criticSummaryGrid);
  criticFindingsWrap = el('div', 'du-findings');
  criticFindingsWrap.appendChild(
    el(
      'div',
      'du-muted',
      'Run an audit above to inspect AST rules, policy scores, and dual-viewport renders.',
    ),
  );
  resCard.appendChild(criticFindingsWrap);
  criticShotsWrap = el('div', 'du-shots');
  resCard.appendChild(criticShotsWrap);
  container.appendChild(resCard);
}

async function runCriticAudit(): Promise<void> {
  const code = draftGateSource.trim();
  if (!code) return;

  const effectiveMode = detectSourceMode(code);

  runGateBtn?.update({
    label: 'Audit & Capture 360px / 720px',
    variant: 'default',
    size: 'sm',
    loading: true,
    disabled: true,
    onClick: () => void runCriticAudit(),
  });
  try {
    const res = await apiPost<RenderGateResult>('/gate', {
      targetTool: 'openchamber_render',
      rawInput: effectiveMode === 'ui' ? { ui: code } : { html: code, title: 'Lab Preview' },
      includeScreenshots: true,
    });

    criticSummaryGrid.replaceChildren(
      makeStatTile('Surface', res.mode.toUpperCase()),
      makeStatTile('Latency', `${res.ms} ms`),
      makeStatTile('Verdict', res.clean ? 'Clean' : `${res.findings.length} finding(s)`),
      makeStatTile(
        '360px Fit',
        res.visualCritic?.evaluated
          ? `${res.visualCritic.mobileFitScore.toFixed(2)} / 3`
          : 'n/a',
      ),
    );

    criticFindingsWrap.replaceChildren();
    if (res.findings.length === 0) {
      const okItem = el(
        'div',
        'du-finding',
        'All AST, surface policy, and 360px/720px visual checks passed cleanly.',
      );
      okItem.dataset.severity = 'clean';
      criticFindingsWrap.appendChild(okItem);
    } else {
      for (const f of res.findings) {
        const row = el('div', 'du-finding', `[${f.source}] ${f.message}`);
        row.dataset.severity = f.severity;
        criticFindingsWrap.appendChild(row);
      }
    }

    criticShotsWrap.replaceChildren();
    for (const vp of res.visualCritic?.viewports ?? []) {
      if (!vp.pngDataUrl) continue;
      const shotCard = el('div', 'du-shot-card');
      shotCard.appendChild(
        el(
          'div',
          'du-muted',
          `${vp.width}px viewport · scrollW=${vp.scrollWidth}px${
            vp.hasHorizontalOverflow ? ' (OVERFLOW)' : ''
          }`,
        ),
      );
      const img = document.createElement('img');
      img.src = vp.pngDataUrl;
      img.alt = `${vp.width}px render preview`;
      shotCard.appendChild(img);
      criticShotsWrap.appendChild(shotCard);
    }

    void refreshTelemetry();
  } catch (err) {
    criticSummaryGrid.replaceChildren();
    criticShotsWrap.replaceChildren();
    criticFindingsWrap.replaceChildren();
    const errRow = el('div', 'du-finding', err instanceof Error ? err.message : String(err));
    errRow.dataset.severity = 'error';
    criticFindingsWrap.appendChild(errRow);
  } finally {
    runGateBtn?.update({
      label: 'Audit & Capture 360px / 720px',
      variant: 'default',
      size: 'sm',
      loading: false,
      disabled: false,
      onClick: () => void runCriticAudit(),
    });
  }
}

let telemetryStatsGrid: HTMLElement;
let telemetryLogList: HTMLElement;

function buildTelemetryTab(container: HTMLElement): void {
  const statsCard = el('div', 'du-surface');
  statsCard.appendChild(el('div', 'du-section-title', 'Control Plane Metrics'));
  telemetryStatsGrid = el('div', 'du-grid');
  statsCard.appendChild(telemetryStatsGrid);
  container.appendChild(statsCard);

  const controlsCard = el('div', 'du-surface');
  controlsCard.appendChild(el('div', 'du-section-title', 'Active Guards & Hooks'));

  const addSwitch = (label: string, onToggle: (checked: boolean) => void): CheckboxHandle => {
    const wrap = el('div');
    controlsCard.appendChild(wrap);
    return mountSwitch(wrap, {
      label,
      checked: false,
      disabled: true,
      onChange: onToggle,
    });
  };

  routerSwitch = addSwitch('Pre-send Surface Router (session.hook context)', (checked) => {
    void updateConfig({ surfaceRouterEnabled: checked });
  });
  gateSwitch = addSwitch('Advisory Render Policy Gate (execute.after)', (checked) => {
    void updateConfig({ renderGateEnabled: checked });
  });
  criticSwitch = addSwitch('360px/720px Multimodal Visual Critic (:4006)', (checked) => {
    void updateConfig({ visualCriticEnabled: checked });
  });
  turnEndSwitch = addSwitch('Turn-End Missed Visual Detector', (checked) => {
    void updateConfig({ turnEndDetectorEnabled: checked });
  });

  container.appendChild(controlsCard);

  const logCard = el('div', 'du-surface');
  logCard.appendChild(el('div', 'du-section-title', 'Recent Decision Events'));
  telemetryLogList = el('div', 'du-log-list');
  logCard.appendChild(telemetryLogList);
  container.appendChild(logCard);
}

function renderOfflineTelemetryState(reason: string): void {
  telemetryStatsGrid?.replaceChildren(
    makeStatTile('Surface Routes', '—'),
    makeStatTile('Tail Nudges', '—'),
    makeStatTile('Stitch Compiles', '—'),
    makeStatTile('Gate / Critic', '—'),
  );
  routerSwitch?.update({
    label: 'Pre-send Surface Router (session.hook context)',
    checked: false,
    disabled: true,
    onChange: (checked) => void updateConfig({ surfaceRouterEnabled: checked }),
  });
  gateSwitch?.update({
    label: 'Advisory Render Policy Gate (execute.after)',
    checked: false,
    disabled: true,
    onChange: (checked) => void updateConfig({ renderGateEnabled: checked }),
  });
  criticSwitch?.update({
    label: '360px/720px Multimodal Visual Critic (:4006)',
    checked: false,
    disabled: true,
    onChange: (checked) => void updateConfig({ visualCriticEnabled: checked }),
  });
  turnEndSwitch?.update({
    label: 'Turn-End Missed Visual Detector',
    checked: false,
    disabled: true,
    onChange: (checked) => void updateConfig({ turnEndDetectorEnabled: checked }),
  });
  telemetryLogList?.replaceChildren(el('div', 'du-muted', reason));
}

async function updateConfig(patch: Record<string, unknown>): Promise<void> {
  try {
    const snap = await apiPost<DecisionUiStatusSnapshot>('/config', patch);
    renderSnapshot(snap);
  } catch (err) {
    void host.toast({
      kind: 'error',
      message: err instanceof Error ? err.message : 'Failed updating config',
    });
  }
}

async function refreshTelemetry(): Promise<void> {
  try {
    const snap = await apiGet<DecisionUiStatusSnapshot>('/state');
    renderSnapshot(snap);
  } catch {
    bridgeBadge?.update({ label: 'Service idle', tone: 'warning' });
    renderOfflineTelemetryState(
      'Approve the extension service in OpenChamber Settings → Extensions to stream live metrics.',
    );
  }
}

function renderSnapshot(snap: DecisionUiStatusSnapshot): void {
  bridgeBadge?.update({
    label: snap.bridgeHealthy ? `${snap.config.model} · :4006` : 'Bridge offline',
    tone: snap.bridgeHealthy ? 'success' : 'warning',
  });

  routerSwitch?.update({
    label: 'Pre-send Surface Router (session.hook context)',
    checked: snap.config.surfaceRouterEnabled,
    disabled: false,
    onChange: (checked) => void updateConfig({ surfaceRouterEnabled: checked }),
  });
  gateSwitch?.update({
    label: 'Advisory Render Policy Gate (execute.after)',
    checked: snap.config.renderGateEnabled,
    disabled: false,
    onChange: (checked) => void updateConfig({ renderGateEnabled: checked }),
  });
  criticSwitch?.update({
    label: '360px/720px Multimodal Visual Critic (:4006)',
    checked: snap.config.visualCriticEnabled,
    disabled: false,
    onChange: (checked) => void updateConfig({ visualCriticEnabled: checked }),
  });
  turnEndSwitch?.update({
    label: 'Turn-End Missed Visual Detector',
    checked: snap.config.turnEndDetectorEnabled,
    disabled: false,
    onChange: (checked) => void updateConfig({ turnEndDetectorEnabled: checked }),
  });

  telemetryStatsGrid.replaceChildren(
    makeStatTile('Surface Routes', String(snap.counters.surfaceRoutes)),
    makeStatTile('Tail Nudges', String(snap.counters.directedSurfaceTurns)),
    makeStatTile('Stitch Compiles', String(snap.counters.uiCompiles)),
    makeStatTile(
      'Gate / Critic',
      `${snap.counters.renderGates} (${snap.counters.renderAdvisories} adv)`,
    ),
  );

  telemetryLogList.replaceChildren();
  if (snap.recent.length === 0) {
    telemetryLogList.appendChild(
      el('div', 'du-muted', 'No events recorded yet in this service session.'),
    );
    return;
  }

  for (const item of snap.recent.slice(0, 15)) {
    const row = el('div', 'du-log-item');
    row.appendChild(el('div', 'du-log-summary', item.summary));
    row.appendChild(el('div', 'du-log-meta', `${item.ms} ms`));
    telemetryLogList.appendChild(row);
  }
}

function handleIncomingActionItem(item: unknown): void {
  if (!item || typeof item !== 'object') return;
  const rec = item as { kind?: string; text?: string };
  if (typeof rec.text === 'string' && rec.text.trim().length > 0) {
    switchTab('compiler');
    draftData = rec.text.trim();
    draftEdit = '';
    dataInputField?.update({ value: draftData });
    customEditField?.update({ value: '' });
    updateChipPressed();
    void runCompile();
  }
}

host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (!mounted) {
    mounted = true;
    mountApp();
    if (context.item) {
      handleIncomingActionItem(context.item);
    } else {
      void runCompile();
    }
    void refreshTelemetry();
  }
});

host.onItem((item) => {
  handleIncomingActionItem(item);
});

host.onServiceEvent((evt) => {
  if (evt.topic === 'telemetry' || evt.topic === 'missed-visual') {
    void refreshTelemetry();
  }
});
