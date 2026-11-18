/**
 * OpenCode v2 Plugin shipped inside `decision-ui` (`contributes.opencodePlugin: "plugin"`).
 * Bundled via `openchamber-guest-bundle --node plugin/src/index.ts plugin/index.js` so
 * `plugin/index.js` has zero external runtime package imports when loaded by OpenCode 2.2+.
 *
 * Capabilities wired here:
 * 1. `ctx.session.hook("context")`: Prefix-cache-safe Surface Router (never mutates `draft.system`;
 *    appends a deterministic `<decision_ui_route>` tail hint onto the latest user message only when
 *    `needs_ui >= 0.65`, cached once per user turn).
 * 2. `ctx.tool.transform`: Registers `decision_ui_compile` direct tool (`0` output tokens via Gemini
 *    Decisions API) for Stitch-style arbitrary output -> `openui-lang` or `verbatim` evaluation.
 * 3. `ctx.tool.hook("execute.after")`: Advisory Render Gate + 360px/720px Multimodal Visual Critic
 *    on `openchamber_render` (`ui` and `html`) and `question`.
 */

import crypto from 'node:crypto';
import { evaluateAutoVisual, type AutoVisualResult } from '../../src/core/auto-block.ts';
import { createDecisionBridgeClient } from '../../src/core/client.ts';
import {
  evaluateRenderGate,
  mergeAdvisoryIntoToolContent,
} from '../../src/core/render-gate.ts';
import {
  applySurfaceRouteToMessages,
  evaluateSurfaceRoute,
} from '../../src/core/surface-router.ts';
import type {
  RenderGateResult,
  SurfaceRouteDecision,
} from '../../src/core/types.ts';
import { loadDecisionUiConfig } from '../../src/node/config-store.ts';

interface OpenCodeSystemPart {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

interface OpenCodeMessagePart {
  readonly type?: string;
  readonly text?: string;
}

interface OpenCodeMessage {
  readonly role?: string;
  readonly content?: string | ReadonlyArray<OpenCodeMessagePart>;
}

interface SessionContextDraft {
  readonly sessionID: string;
  readonly agent: string;
  system: OpenCodeSystemPart[];
  messages: OpenCodeMessage[];
}

interface ToolResult {
  content?: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  metadata?: Record<string, unknown>;
}

interface ToolExecuteAfterEvent {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly input: unknown;
  readonly status: 'completed' | 'error';
  result?: ToolResult;
}

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly options?: { readonly codemode: boolean };
  readonly input: Record<string, unknown>;
  readonly execute: (
    input: Record<string, unknown>,
    context: { readonly sessionID: string; readonly signal?: AbortSignal },
  ) => Promise<ToolResult>;
}

interface PluginContext {
  readonly tool: {
    readonly transform: (fn: (editor: { add: (tool: ToolDefinition) => void }) => void) => Promise<void>;
    readonly hook: (
      name: 'execute.after',
      fn: (event: ToolExecuteAfterEvent) => Promise<void>,
    ) => Promise<void>;
  };
  readonly session: {
    readonly hook: (
      name: 'context',
      fn: (draft: SessionContextDraft) => Promise<void>,
    ) => Promise<void>;
  };
}

function exemptLocalhostFromProxy(): void {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const existing = (process.env[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const host of ['127.0.0.1', 'localhost']) {
      if (!existing.includes(host)) existing.push(host);
    }
    process.env[key] = existing.join(',');
  }
}

function extractMessageText(msg: OpenCodeMessage | undefined): string {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text!)
      .join('\n')
      .trim();
  }
  return '';
}

function extractLatestUserTurn(messages: ReadonlyArray<OpenCodeMessage>): {
  latestUserText: string;
  recentHistory: string;
} {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return { latestUserText: '', recentHistory: '' };

  const latestUserText = extractMessageText(messages[lastUserIdx]);
  const priorSlice = messages.slice(Math.max(0, lastUserIdx - 4), lastUserIdx);
  const recentHistory = priorSlice
    .map((m) => {
      const txt = extractMessageText(m).slice(0, 500);
      return txt ? `${m.role ?? 'msg'}: ${txt}` : '';
    })
    .filter(Boolean)
    .join('\n');

  return { latestUserText, recentHistory };
}

async function postServiceLoopback<T>(
  port: number,
  pathname: string,
  payload: unknown,
  timeoutMs: number,
): Promise<T | null> {
  if (port <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Per-turn cache so multi-step tool loops within the same user message evaluate Surface Router once.
const routeCache = new Map<string, SurfaceRouteDecision>();
const MAX_ROUTE_CACHE = 128;

function cacheKeyForTurn(sessionID: string, latestUserText: string): string {
  const digest = crypto.createHash('sha1').update(latestUserText).digest('hex').slice(0, 16);
  return `${sessionID}:${digest}`;
}

// Subagent read-only workers (`explore`, `librarian`, `critic`, `title`) don't render chat UI blocks.
const NON_UI_AGENTS = new Set(['explore', 'librarian', 'title', 'compaction', 'summary']);

export default {
  id: 'decision-ui-plugin',
  setup: async (ctx: PluginContext) => {
    exemptLocalhostFromProxy();

    // 1. Stitch-Rapid Zero-Output-Token UI Compiler Tool
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'decision_ui_compile',
        description:
          'Evaluate arbitrary output (prose, CLI output, bullet metrics, checklists/steps, KV status dumps, CSV, JSON, or Markdown tables) via Gemini Decision 1 with zero output tokens: decides whether to compile into an `openui-lang` visual (`chart`, `stats_kv`, `steps_flow`) or repeat `verbatim`. Note: for inline single-step rendering inside your reply, prefer writing `AutoVisual(content, intent)` directly inside a ```openui-lang fence.',
        options: { codemode: false },
        input: {
          type: 'object',
          properties: {
            data: {
              type: 'string',
              description:
                'Arbitrary output text, CLI dump, bullet list, checklist, JSON, CSV, or Markdown table.',
            },
            edit: {
              type: 'string',
              description:
                'Optional intent or Stitch quick-edit directive (e.g. "bar_whole_share", "line_trend", "verbatim", "steps_flow").',
            },
            title: {
              type: 'string',
              description: 'Optional short 1-3 word title.',
            },
          },
          required: ['data'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const config = loadDecisionUiConfig();
          const rawInput = typeof input.data === 'string' ? input.data : JSON.stringify(input.data ?? '');
          const editInstruction = typeof input.edit === 'string' ? input.edit : undefined;

          try {
            const viaService = await postServiceLoopback<AutoVisualResult>(
              config.loopbackPort,
              '/plugin/auto-visual',
              {
                content: rawInput,
                intent: editInstruction,
                sessionId: context.sessionID,
              },
              4000,
            );

            const evaluated =
              viaService ??
              (await evaluateAutoVisual({
                content: rawInput,
                ...(editInstruction ? { intent: editInstruction } : {}),
                client: createDecisionBridgeClient({
                  bridgeUrl: config.bridgeUrl,
                  model: config.model,
                }),
                config,
              }));

            return {
              content: JSON.stringify({
                ok: evaluated.ok,
                mode: evaluated.mode,
                shouldVisualizeProbability: evaluated.shouldVisualizeProbability,
                chartKind: evaluated.compiled?.plan.chartKind ?? null,
                questionCount: evaluated.questionCount,
                ms: evaluated.ms,
                source: evaluated.openUiSource,
                fencedMarkdown: evaluated.fencedMarkdown,
              }),
            };
          } catch (err) {
            return {
              content: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              }),
            };
          }
        },
      });
    });

    // 2. Prefix-Cache-Safe Surface Router (`ctx.session.hook("context")`)
    await ctx.session.hook('context', async (draft) => {
      if (NON_UI_AGENTS.has(draft.agent)) return;
      const config = loadDecisionUiConfig();
      if (!config.surfaceRouterEnabled) return;

      const { latestUserText, recentHistory } = extractLatestUserTurn(draft.messages);
      if (!latestUserText || latestUserText.startsWith('<system')) return;
      // Strip any already-appended tail hint before hashing so multi-step loops hit the same cache key
      const cleanUserText = latestUserText.replace(/\n*<decision_ui_route [\s\S]*?<\/decision_ui_route>\s*$/, '');

      const key = cacheKeyForTurn(draft.sessionID, cleanUserText);
      let decision = routeCache.get(key);

      if (!decision) {
        const viaService = await postServiceLoopback<{
          enabled: boolean;
          decision: SurfaceRouteDecision;
        }>(
          config.loopbackPort,
          '/plugin/route',
          {
            latestUserText: cleanUserText,
            recentHistory,
            sessionId: draft.sessionID,
          },
          1600,
        );

        if (viaService) {
          if (!viaService.enabled) return;
          decision = viaService.decision;
        } else {
          const client = createDecisionBridgeClient({
            bridgeUrl: config.bridgeUrl,
            model: config.model,
            timeoutMs: 1400,
          });
          decision = await evaluateSurfaceRoute({
            client,
            config,
            latestUserText: cleanUserText,
            recentHistory,
            timeoutMs: 1400,
          });
        }

        if (routeCache.size >= MAX_ROUTE_CACHE) {
          const oldest = routeCache.keys().next().value;
          if (oldest) routeCache.delete(oldest);
        }
        routeCache.set(key, decision);
      }

      draft.messages = applySurfaceRouteToMessages(draft.messages, decision);
    });

    // 3. Post-Render Advisory Gate + Multimodal 360px/720px Visual Critic (`ctx.tool.hook("execute.after")`)
    await ctx.tool.hook('execute.after', async (event) => {
      if (event.status !== 'completed' || !event.result) return;
      if (event.tool !== 'openchamber_render' && event.tool !== 'question') return;

      const config = loadDecisionUiConfig();
      if (!config.renderGateEnabled && !config.visualCriticEnabled) return;

      const rawInput =
        event.input && typeof event.input === 'object' && !Array.isArray(event.input)
          ? (event.input as Record<string, unknown>)
          : {};

      const viaService = await postServiceLoopback<RenderGateResult>(
        config.loopbackPort,
        '/plugin/gate',
        {
          targetTool: event.tool,
          rawInput,
          includeScreenshots: false,
          sessionId: event.sessionID,
        },
        6000,
      );

      const gateResult =
        viaService ??
        (await evaluateRenderGate({
          targetTool: event.tool,
          rawInput,
          client: createDecisionBridgeClient({
            bridgeUrl: config.bridgeUrl,
            model: config.model,
          }),
          config,
        }));

      if (!gateResult.advisoryNote) return;

      if (typeof event.result.content === 'string') {
        const merged = mergeAdvisoryIntoToolContent(
          event.result.content,
          gateResult.advisoryNote,
        );
        if (merged !== undefined) {
          event.result = {
            ...event.result,
            content: merged,
          };
        }
      }
    });
  },
};
