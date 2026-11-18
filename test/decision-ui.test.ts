import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SESSION_EVENTS_PATH, SESSION_EVENTS_WIRE_VERSION } from '@openchamber/sdk';
import { lintOpenUiSource } from '../src/core/ast-linter.ts';
import { evaluateAutoVisual } from '../src/core/auto-block.ts';
import { createDecisionBridgeClient } from '../src/core/client.ts';
import { mergeAdvisoryIntoToolContent } from '../src/core/render-gate.ts';
import {
  applySurfaceRouteToMessages,
  evaluateSurfaceRoute,
} from '../src/core/surface-router.ts';
import { DEFAULT_DECISION_UI_CONFIG, type RenderGateResult } from '../src/core/types.ts';
import {
  compileStructuredDataToUi,
  extractStructuredDataset,
} from '../src/core/ui-compiler.ts';
import { closeWarmBrowser } from '../src/node/headless-capture.ts';
import { startDecisionUiServers, type RunningDecisionUiServers } from '../service/server.ts';

describe('1. Deterministic openui-lang AST, Mobile & Tufte Linter', () => {
  test('accepts clean Tufte-paired, mobile-safe openui-lang programs with object literals', () => {
    const cleanSource = [
      'root = Stack([stats, flow, chart, tbl])',
      'stats = Row([s1, s2])',
      's1 = Stat("E2E Latency", "180 ms", "-40%", "success")',
      's2 = Stat("Output Cost", "$0", "0 tok", "info")',
      'flow = Steps([{title: "Prefill", status: "done"}, {title: "Compile", status: "current"}], "column")',
      'chart = BarChart(["Decision 1", "Flash Lite"], [ser], "ms")',
      'ser = Series("Latency", [85, 410])',
      'tbl = Table(["Model", "Latency (ms)"], [["Decision 1", 85], ["Flash Lite", 410]])',
    ].join('\n');

    const report = lintOpenUiSource(cleanSource);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test('catches named arguments, invalid Row/Card nesting, long Card badges, and naked numeric tables', () => {
    const defective = [
      'root = Stack([bad_row, bad_card, naked_tbl])',
      'bad_row = Row([Table(["A", "B"], [[1, 2], [3, 4]])])',
      'bad_card = Card(title: "Node", [Badge("PRIMARY US-WEST-2 ACTIVE CLUSTER", "info"), Text("ok")])',
      'naked_tbl = Table(["Endpoint", "P95", "Err%"], [["/v1/a", 42, 0.2], ["/v1/b", 190, 1.8]])',
    ].join('\n');

    const report = lintOpenUiSource(defective);
    expect(report.valid).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('named_argument');
    expect(codes).toContain('mobile_row_squeeze');
    expect(codes).toContain('long_card_badge');
    expect(codes).toContain('tufte_table_without_visual');
  });
});

describe('2. Live Gemini Decisions Bridge (:4006) End-to-End Integration', () => {
  const client = createDecisionBridgeClient({
    bridgeUrl: 'http://127.0.0.1:4006',
    model: 'gemini-decision-1',
    timeoutMs: 8000,
  });

  let tempDir = '';
  let servers: RunningDecisionUiServers | null = null;
  let bridgeAvailable = false;

  beforeAll(async () => {
    bridgeAvailable = await client.checkHealth(1500);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-ui-test-'));
    servers = await startDecisionUiServers({
      env: {
        ...process.env,
        DECISION_UI_CONFIG_PATH: path.join(tempDir, 'decision-ui.json'),
        OPENCHAMBER_SERVICE_TOKEN: 'test-secret-token',
      },
      servicePort: 0,
      loopbackPortOverride: 0,
    });
  });

  afterAll(async () => {
    if (servers) await servers.close();
    await closeWarmBrowser();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('live bridge on 127.0.0.1:4006 is reachable', () => {
    expect(bridgeAvailable).toBe(true);
  });

  test('Surface Router preserves prefix cache (no-op on code turns, user-tail nudge on UI turns, never touches system)', async () => {
    const codeDecision = await evaluateSurfaceRoute({
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      latestUserText:
        'Fix the null pointer dereference in src/auth/token.ts line 88 and run bun test src/auth/token.test.ts.',
      timeoutMs: 6000,
    });

    expect(codeDecision.surface).toBe('plain_reply');
    expect(codeDecision.needsUiProbability).toBeLessThan(0.35);
    expect(codeDecision.action).toBe('noop');

    const initialMessages = [
      { role: 'user', content: [{ type: 'text', text: 'Earlier cached turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Fix token.ts' }] },
    ];
    const untouched = applySurfaceRouteToMessages(initialMessages, codeDecision);
    expect(untouched).toEqual(initialMessages);

    const uiDecision = await evaluateSurfaceRoute({
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      latestUserText:
        'Show me a visual chart and breakdown table comparing p50/p99 latency and cost per 1M tokens across our four model tiers.',
      timeoutMs: 6000,
    });

    expect(uiDecision.needsUiProbability).toBeGreaterThanOrEqual(0.65);
    expect(uiDecision.surface).not.toBe('plain_reply');
    expect(uiDecision.action).toBe('inject_user_tail');
    expect(uiDecision.directiveText).toContain('<decision_ui_route');
    expect(uiDecision.directiveText).not.toContain('p="');

    const nudged = applySurfaceRouteToMessages(initialMessages, uiDecision);
    // Earlier conversation history stays byte-for-byte identical (prefix cache intact!)
    expect(nudged[0]).toEqual(initialMessages[0]);
    expect(nudged[1]).toEqual(initialMessages[1]);
    expect(nudged[2]!.content.length).toBe(2);
    expect(nudged[2]!.content[1]!.text).toContain('<decision_ui_route');

    // Idempotent across multi-step tool calls in the same turn
    const secondPass = applySurfaceRouteToMessages(nudged, uiDecision);
    expect(secondPass).toEqual(nudged);
  });

  test('Stitch-style UI Compiler compiles Markdown & JSON tables with 0 output tokens and applies live quick-edits', async () => {
    const mdTable = [
      '### Service Latency Breakdown',
      '| Service | P95 Latency | Error Rate |',
      '| --- | --- | --- |',
      '| auth-gateway | 38 ms | 0.1% |',
      '| billing-worker | 215 ms | 1.4% |',
      '| search-index | 94 ms | 0.3% |',
      '| media-edge | 51 ms | 0.2% |',
    ].join('\n');

    const dataset = extractStructuredDataset(mdTable);
    expect(dataset).not.toBeNull();
    expect(dataset!.rows.length).toBe(4);

    const compiled = await compileStructuredDataToUi({
      rawInput: mdTable,
      client,
      timeoutMs: 6000,
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.plan.usedFallbackHeuristics).toBe(false);
    expect(compiled.plan.questionCount).toBeGreaterThanOrEqual(6);
    expect(compiled.lint.valid).toBe(true);
    expect(compiled.lint.issues).toEqual([]);
    expect(compiled.source).toContain('root = Stack([');

    // Quick-edit transform: switch to LineChart & hide table
    const edited = await compileStructuredDataToUi({
      rawInput: mdTable,
      editInstruction: 'switch to line_trend chart and omit the detail table',
      client,
      timeoutMs: 6000,
    });
    expect(edited.ok).toBe(true);
    expect(edited.plan.chartKind).toBe('line_trend');
    expect(edited.source).toContain('LineChart(');
    expect(edited.source).not.toContain('detail_table = Table(');
    expect(edited.lint.valid).toBe(true);
  });

  test('Guest Service + Multimodal 360px/720px Visual Critic catches mobile overflow & keeps clean SVG clean', async () => {
    expect(servers?.servicePort).toBeGreaterThan(0);
    expect(servers?.loopbackPort).toBeGreaterThan(0);
    const baseUrl = `http://127.0.0.1:${servers!.servicePort}`;
    const authHeaders = {
      authorization: 'Bearer test-secret-token',
      'content-type': 'application/json',
    };

    // 1. Overflowing 680px wide HTML data table (violates both 360px fit AND Never-for-data)
    const badHtml = `<div style="width:680px;display:flex;gap:20px;padding:16px">
      <table border="1" style="width:660px">
        <tr><th>Region</th><th>Revenue</th><th>Growth</th></tr>
        <tr><td>NA</td><td>$4.2M</td><td>+18%</td></tr>
        <tr><td>EU</td><td>$2.9M</td><td>+11%</td></tr>
      </table>
    </div>`;

    const badRes = await fetch(`${baseUrl}/gate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        targetTool: 'openchamber_render',
        rawInput: { html: badHtml, title: 'Revenue Table' },
        includeScreenshots: true,
      }),
    });
    expect(badRes.status).toBe(200);
    const badGate = (await badRes.json()) as RenderGateResult;
    expect(badGate.clean).toBe(false);
    expect(badGate.visualCritic?.evaluated).toBe(true);
    expect(badGate.visualCritic?.viewports.length).toBe(2);

    const mobileVp = badGate.visualCritic!.viewports.find((v) => v.width === 360)!;
    expect(mobileVp.hasHorizontalOverflow).toBe(true);
    expect(mobileVp.pngDataUrl?.startsWith('data:image/png;base64,')).toBe(true);
    expect(badGate.advisoryNote).toContain('[Decision UI Advisory]');

    // Verify JSON envelope preservation when merging advisory into openchamber_render output
    const originalRenderEnvelope = JSON.stringify({
      schemaVersion: 1,
      ok: true,
      action: 'render.page',
      data: { shown: true, title: 'Revenue Table', note: 'Page drawn.' },
    });
    const mergedEnvelope = mergeAdvisoryIntoToolContent(
      originalRenderEnvelope,
      badGate.advisoryNote,
    )!;
    const reparsed = JSON.parse(mergedEnvelope) as {
      schemaVersion: number;
      ok: boolean;
      data: { shown: boolean; note: string };
    };
    expect(reparsed.schemaVersion).toBe(1);
    expect(reparsed.ok).toBe(true);
    expect(reparsed.data.shown).toBe(true);
    expect(reparsed.data.note).toContain('Page drawn.');
    expect(reparsed.data.note).toContain('[Decision UI Advisory]');

    // 2. Clean fluid SVG diagram fits 360px and 720px with zero DOM overflow
    const cleanHtml = `<div class="oc-box" style="display:flex;flex-direction:column;gap:0.5rem">
      <strong>Telemetry Ring Topology</strong>
      <svg viewBox="0 0 300 90" width="100%" height="90">
        <circle cx="60" cy="45" r="26" fill="#1d2026" stroke="#60a5fa" stroke-width="2"/>
        <text x="60" y="49" text-anchor="middle" fill="#eceef2" font-size="11">Node A</text>
        <line x1="86" y1="45" x2="214" y2="45" stroke="#34d399" stroke-width="2"/>
        <circle cx="240" cy="45" r="26" fill="#1d2026" stroke="#34d399" stroke-width="2"/>
        <text x="240" y="49" text-anchor="middle" fill="#eceef2" font-size="11">Node B</text>
      </svg>
    </div>`;

    const cleanRes = await fetch(`${baseUrl}/gate`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        targetTool: 'openchamber_render',
        rawInput: { html: cleanHtml, title: 'Topology' },
      }),
    });
    const cleanGate = (await cleanRes.json()) as RenderGateResult;
    expect(cleanGate.visualCritic?.evaluated).toBe(true);
    for (const vp of cleanGate.visualCritic!.viewports) {
      expect(vp.hasHorizontalOverflow).toBe(false);
      expect(vp.pageErrors).toEqual([]);
    }

    // 3. Session turn-finished event route answers { ok: true }
    const evtRes = await fetch(`${baseUrl}${SESSION_EVENTS_PATH}`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        v: SESSION_EVENTS_WIRE_VERSION,
        requestId: 'req-1',
        event: {
          id: 'evt-1',
          type: 'turn-finished',
          at: Date.now(),
          session: { id: 'ses_test', parentId: null },
          project: { directory: '/tmp' },
          linked: [],
        },
        content: {
          type: 'turn-finished',
          sessionTitle: 'Test',
          reply:
            'Here are the service numbers:\n| Node | Latency | Throughput |\n| --- | --- | --- |\n| A | 12ms | 9400 |\n| B | 48ms | 3100 |\n| C | 91ms | 1450 |\nAll nodes finished benchmark.',
          replyTruncated: false,
        },
      }),
    });
    expect(evtRes.status).toBe(200);
    expect(await evtRes.json()).toEqual({ ok: true });
  }, 25000);

  test('Bundled OpenCode v2 plugin (plugin/index.js) loads with zero external deps and executes tool + hooks', async () => {
    const pluginModule = (await import('../plugin/index.js')) as {
      default: { id: string; setup: (ctx: unknown) => Promise<void> };
    };
    expect(pluginModule.default.id).toBe('decision-ui-plugin');

    interface MockRegisteredTool {
      name: string;
      execute: (
        input: Record<string, unknown>,
        ctx: { sessionID: string },
      ) => Promise<{ content: string }>;
    }
    const addedTools: MockRegisteredTool[] = [];
    const contextHooks: Array<(draft: Record<string, unknown>) => Promise<void>> = [];
    const afterHooks: Array<(event: Record<string, unknown>) => Promise<void>> = [];

    await pluginModule.default.setup({
      tool: {
        transform: async (fn: (editor: { add: (t: unknown) => void }) => void) => {
          fn({
            add: (t) => {
              addedTools.push(t as MockRegisteredTool);
            },
          });
        },
        hook: async (name: string, fn: (e: Record<string, unknown>) => Promise<void>) => {
          if (name === 'execute.after') afterHooks.push(fn);
        },
      },
      session: {
        hook: async (name: string, fn: (d: Record<string, unknown>) => Promise<void>) => {
          if (name === 'context') contextHooks.push(fn);
        },
      },
    });

    const registeredTool = addedTools[0];
    expect(registeredTool?.name).toBe('decision_ui_compile');
    expect(contextHooks.length).toBe(1);
    expect(afterHooks.length).toBe(1);

    const compileOut = await registeredTool!.execute(
      {
        data: JSON.stringify([
          { tier: 'Decision 1', ms: 85 },
          { tier: 'Flash Lite', ms: 410 },
        ]),
      },
      { sessionID: 'ses_plugin_test' },
    );
    const parsedOut = JSON.parse(compileOut.content) as {
      ok: boolean;
      mode: string;
      source: string;
    };
    expect(parsedOut.ok).toBe(true);
    expect(parsedOut.mode).toBe('chart');
    expect(parsedOut.source).toContain('root = Stack([');
  }, 15000);

  test('AutoVisual evaluates arbitrary outputs via live :4006 (verbatim prose, bullet metrics, CLI output, steps, and KV status)', async () => {
    // 1. AutoVisual AST lint clean
    const blockLint = lintOpenUiSource(
      'root = Stack([v])\nv = AutoVisual("arbitrary prose or data", "auto")',
    );
    expect(blockLint.valid).toBe(true);
    expect(blockLint.issues).toEqual([]);

    // 2. Plain narrative explanation -> repeats verbatim!
    const narrative = await evaluateAutoVisual({
      content:
        'The reconnect hang occurred because `flushPending()` acquired `sessionLock` while the 5s heartbeat timer already held it. Moving buffer drain outside the lock resolves the deadlock.',
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      timeoutMs: 6000,
    });
    expect(narrative.mode).toBe('verbatim');
    expect(narrative.openUiSource).toContain('Text(');

    // 3. Freeform bulleted metrics + trailing prose (NOT JSON/CSV/pipe-table) -> chart + preserved prose!
    const bulletProse = await evaluateAutoVisual({
      content: [
        'Endpoint p95 latency after enabling connection pooling:',
        '- auth-gateway: 38 ms (0.1%)',
        '- billing-worker: 215 ms (1.4%)',
        '- search-index: 94 ms (0.3%)',
        '- media-edge: 51 ms (0.2%)',
        'Billing worker remains bottlenecked on serialized ledger writes.',
      ].join('\n'),
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      timeoutMs: 6000,
    });
    expect(bulletProse.mode).toBe('chart');
    expect(bulletProse.accompanyingProse).toContain('Billing worker remains bottlenecked');
    expect(lintOpenUiSource(bulletProse.openUiSource).valid).toBe(true);

    // 4. CLI whitespace-aligned `df -h` output -> chart!
    const cliDf = await evaluateAutoVisual({
      content: [
        'Filesystem      Size  Used  Use%',
        '/dev/nvme0n1p2  468G  312G  71%',
        '/dev/sda1       916G  184G  22%',
        'tmpfs            32G    4G  13%',
      ].join('\n'),
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      timeoutMs: 6000,
    });
    expect(cliDf.mode).toBe('chart');
    expect(cliDf.compiled?.dataset.rows.length).toBe(3);

    // 5. Numbered deployment checklist -> steps_flow!
    const stepsRes = await evaluateAutoVisual({
      content: [
        '1. Build & bundle guest assets (done)',
        '2. Validate manifest via openchamber-guest-check (done)',
        '3. Run live :4006 integration suite (running)',
        '4. Approve extension in OpenChamber Settings (pending)',
      ].join('\n'),
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      timeoutMs: 6000,
    });
    expect(stepsRes.mode).toBe('steps_flow');
    expect(stepsRes.stepItems?.length).toBe(4);
    expect(stepsRes.stepItems?.[0]?.status).toBe('done');
    expect(stepsRes.stepItems?.[2]?.status).toBe('current');

    // 6. Heterogeneous Key-Value cluster health readout -> stats_kv!
    const kvRes = await evaluateAutoVisual({
      content: [
        'Cluster: us-west-2-prod',
        'Health: HEALTHY',
        'Active Workers: 18 / 20',
        'CPU Load: 68.4%',
        'Memory Pressure: 41.2%',
      ].join('\n'),
      client,
      config: DEFAULT_DECISION_UI_CONFIG,
      timeoutMs: 6000,
    });
    expect(kvRes.mode).toBe('stats_kv');
    expect(kvRes.kvItems?.length).toBe(5);
  }, 20000);
});
