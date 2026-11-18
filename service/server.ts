import crypto from 'node:crypto';
import http from 'node:http';
import {
  createServiceHost,
  readSessionEventRequest,
  SESSION_EVENTS_PATH,
} from '@openchamber/sdk';
import {
  evaluateAutoVisual,
  type AutoPresentationMode,
} from '../src/core/auto-block.ts';
import { createDecisionBridgeClient } from '../src/core/client.ts';
import {
  evaluateRenderGate,
  evaluateTurnEndMissedVisual,
} from '../src/core/render-gate.ts';
import { evaluateSurfaceRoute } from '../src/core/surface-router.ts';
import type {
  DecisionUiConfig,
  DecisionUiStatusSnapshot,
  TelemetryEntry,
} from '../src/core/types.ts';
import { compileStructuredDataToUi } from '../src/core/ui-compiler.ts';
import {
  loadDecisionUiConfig,
  renderTildePath,
  resolveConfigFilePath,
  saveDecisionUiConfig,
} from '../src/node/config-store.ts';
import { captureHtmlViewports, closeWarmBrowser } from '../src/node/headless-capture.ts';

const MAX_RECENT_EVENTS = 40;

export interface StartDecisionUiServersOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly servicePort?: number | null;
  readonly loopbackPortOverride?: number | null;
  readonly fetchImpl?: typeof fetch;
}

export interface RunningDecisionUiServers {
  readonly servicePort: number | null;
  readonly loopbackPort: number | null;
  readonly getSnapshot: () => Promise<DecisionUiStatusSnapshot>;
  readonly close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage, maxBytes = 12 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body exceeded maximum size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function listenLoopback(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startDecisionUiServers(
  options: StartDecisionUiServersOptions = {},
): Promise<RunningDecisionUiServers> {
  const env = options.env ?? process.env;
  const serviceToken = env.OPENCHAMBER_SERVICE_TOKEN ?? '';
  const hasHostEnv = Boolean(env.OPENCHAMBER_SERVICE_PORT && env.OPENCHAMBER_SERVICE_TOKEN);
  const serviceHost = hasHostEnv ? createServiceHost({ env }) : null;

  let config: DecisionUiConfig = loadDecisionUiConfig(env);
  let bridgeHealthy = false;
  let lastHealthCheckAt = 0;

  const counters = {
    surfaceRoutes: 0,
    directedSurfaceTurns: 0,
    uiCompiles: 0,
    renderGates: 0,
    renderAdvisories: 0,
    visualCritics: 0,
    missedVisuals: 0,
  };

  let recent: TelemetryEntry[] = [];
  let boundLoopbackPort: number | null = null;

  const pushTelemetry = (entry: Omit<TelemetryEntry, 'id' | 'timestamp'>): TelemetryEntry => {
    const full: TelemetryEntry = {
      id: crypto.randomUUID().slice(0, 8),
      timestamp: Date.now(),
      ...entry,
    };
    recent = [full, ...recent].slice(0, MAX_RECENT_EVENTS);
    serviceHost?.emit('telemetry', {
      id: full.id,
      timestamp: full.timestamp,
      kind: full.kind,
      summary: full.summary,
      ms: full.ms,
      clean: full.clean ?? null,
    });
    return full;
  };

  const makeClient = () =>
    createDecisionBridgeClient({
      bridgeUrl: config.bridgeUrl,
      model: config.model,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

  const refreshBridgeHealth = async (force = false): Promise<boolean> => {
    if (!force && Date.now() - lastHealthCheckAt < 5000) {
      return bridgeHealthy;
    }
    lastHealthCheckAt = Date.now();
    bridgeHealthy = await makeClient().checkHealth(1000);
    return bridgeHealthy;
  };

  const getSnapshot = async (): Promise<DecisionUiStatusSnapshot> => {
    const healthy = await refreshBridgeHealth(false);
    return {
      bridgeHealthy: healthy,
      bridgeUrl: config.bridgeUrl,
      loopbackPort: boundLoopbackPort ?? config.loopbackPort,
      config,
      counters: { ...counters },
      recent,
    };
  };

  const buildGuestStatusView = async () => {
    const healthy = await refreshBridgeHealth(false);
    const rows: Array<Record<string, unknown>> = [
      {
        kind: 'line',
        id: 'bridge',
        label: 'Decisions Bridge',
        dot: healthy ? 'success' : 'warning',
        value: healthy ? `${config.model} (:4006)` : 'offline (:4006)',
      },
      {
        kind: 'line',
        id: 'router',
        label: 'Surface Router',
        dot: config.surfaceRouterEnabled ? 'info' : 'muted',
        value: config.surfaceRouterEnabled
          ? `${counters.surfaceRoutes} turns · ${counters.directedSurfaceTurns} nudged`
          : 'paused',
        actions: [
          {
            kind: 'button',
            id: 'toggle-router',
            label: config.surfaceRouterEnabled ? 'Pause' : 'Enable',
            variant: 'outline',
          },
        ],
      },
      {
        kind: 'line',
        id: 'compiler',
        label: 'Stitch Compiler',
        dot: 'success',
        value: `${counters.uiCompiles} blocks compiled`,
      },
      {
        kind: 'line',
        id: 'gate',
        label: 'Render Gate & Critic',
        dot: config.renderGateEnabled || config.visualCriticEnabled ? 'info' : 'muted',
        value: `${counters.renderGates} checks · ${counters.renderAdvisories} advisories`,
        actions: [
          {
            kind: 'button',
            id: 'toggle-critic',
            label: config.visualCriticEnabled ? 'Critic On' : 'Critic Off',
            variant: 'outline',
          },
        ],
      },
    ];

    const latest = recent[0];
    if (latest) {
      rows.push({
        kind: 'note',
        id: 'latest-event',
        text: `${latest.summary} (${latest.ms} ms)`,
        tone: latest.clean === false ? 'warning' : 'muted',
      });
    } else {
      rows.push({
        kind: 'note',
        id: 'config-path',
        text: `Config: ${renderTildePath(resolveConfigFilePath(env))}`,
        tone: 'muted',
      });
    }

    return { rows };
  };

  const handleApiRoute = async (
    method: string,
    pathname: string,
    rawBody: string,
  ): Promise<{ status: number; body: unknown }> => {
    if (method === 'GET' && pathname === '/health') {
      const healthy = await refreshBridgeHealth(false);
      return {
        status: 200,
        body: {
          status: 'ok',
          service: 'decision-ui',
          bridgeHealthy: healthy,
          loopbackPort: boundLoopbackPort,
        },
      };
    }

    if (method === 'GET' && pathname === '/status') {
      return { status: 200, body: await buildGuestStatusView() };
    }

    if (method === 'POST' && pathname === '/status') {
      const payload = rawBody ? (JSON.parse(rawBody) as { id?: string }) : {};
      if (payload.id === 'toggle-router') {
        config = saveDecisionUiConfig(
          { surfaceRouterEnabled: !config.surfaceRouterEnabled },
          env,
        );
      } else if (payload.id === 'toggle-critic') {
        const nextVal = !config.visualCriticEnabled;
        config = saveDecisionUiConfig(
          { visualCriticEnabled: nextVal, renderGateEnabled: nextVal || config.renderGateEnabled },
          env,
        );
      } else if (payload.id === 'reset-stats') {
        Object.assign(counters, {
          surfaceRoutes: 0,
          directedSurfaceTurns: 0,
          uiCompiles: 0,
          renderGates: 0,
          renderAdvisories: 0,
          visualCritics: 0,
          missedVisuals: 0,
        });
        recent = [];
      }
      return { status: 200, body: await buildGuestStatusView() };
    }

    if (method === 'GET' && pathname === '/state') {
      return { status: 200, body: await getSnapshot() };
    }

    if (method === 'POST' && pathname === '/config') {
      const patch = rawBody ? (JSON.parse(rawBody) as Partial<DecisionUiConfig>) : {};
      config = saveDecisionUiConfig(patch, env);
      await refreshBridgeHealth(true);
      return { status: 200, body: await getSnapshot() };
    }

    if (method === 'POST' && (pathname === '/route' || pathname === '/plugin/route')) {
      const reqData = rawBody
        ? (JSON.parse(rawBody) as {
            latestUserText?: string;
            recentHistory?: string;
            sessionId?: string;
          })
        : {};
      if (!config.surfaceRouterEnabled) {
        return {
          status: 200,
          body: {
            enabled: false,
            decision: {
              needsUiProbability: 0.5,
              surface: 'plain_reply',
              surfaceConfidence: 0,
              archetype: 'none',
              archetypeConfidence: 0,
              action: 'noop',
              directiveText: null,
              ms: 0,
            },
          },
        };
      }

      const decision = await evaluateSurfaceRoute({
        client: makeClient(),
        config,
        latestUserText: String(reqData.latestUserText ?? ''),
        ...(reqData.recentHistory ? { recentHistory: reqData.recentHistory } : {}),
      });

      counters.surfaceRoutes += 1;
      if (decision.action === 'inject_user_tail') {
        counters.directedSurfaceTurns += 1;
      }

      pushTelemetry({
        kind: 'surface_route',
        summary:
          decision.action === 'inject_user_tail'
            ? `Tail nudge -> ${decision.surface} (${decision.archetype}, p=${decision.needsUiProbability.toFixed(2)})`
            : `No-op (cache intact, ${decision.surface}, p=${decision.needsUiProbability.toFixed(2)})`,
        ms: decision.ms,
        clean: true,
        ...(reqData.sessionId ? { sessionId: reqData.sessionId } : {}),
      });

      return { status: 200, body: { enabled: true, decision } };
    }

    if (method === 'POST' && (pathname === '/compile' || pathname === '/plugin/compile')) {
      const reqData = rawBody
        ? (JSON.parse(rawBody) as {
            rawInput?: string;
            editInstruction?: string;
            title?: string;
            sessionId?: string;
          })
        : {};
      const result = await compileStructuredDataToUi({
        rawInput: String(reqData.rawInput ?? ''),
        ...(reqData.editInstruction ? { editInstruction: reqData.editInstruction } : {}),
        ...(reqData.title ? { title: reqData.title } : {}),
        client: makeClient(),
      });

      counters.uiCompiles += 1;
      pushTelemetry({
        kind: 'ui_compile',
        summary: `Compiled ${result.dataset.rows.length} rows -> ${result.plan.chartKind} (${result.plan.questionCount} Qs, 0 out tok)`,
        ms: result.plan.ms,
        clean: result.ok,
        ...(reqData.sessionId ? { sessionId: reqData.sessionId } : {}),
      });

      return { status: 200, body: result };
    }

    if (method === 'POST' && (pathname === '/auto-visual' || pathname === '/plugin/auto-visual')) {
      const reqData = rawBody
        ? (JSON.parse(rawBody) as {
            content?: string;
            intent?: string;
            forceMode?: AutoPresentationMode;
            sessionId?: string;
          })
        : {};
      const result = await evaluateAutoVisual({
        content: String(reqData.content ?? ''),
        ...(reqData.intent ? { intent: reqData.intent } : {}),
        ...(reqData.forceMode ? { forceMode: reqData.forceMode } : {}),
        client: makeClient(),
        config,
      });

      counters.uiCompiles += 1;
      pushTelemetry({
        kind: 'ui_compile',
        summary:
          result.mode === 'verbatim'
            ? `AutoVisual -> verbatim (p=${result.shouldVisualizeProbability.toFixed(2)})`
            : `AutoVisual -> ${
                result.mode === 'chart'
                  ? result.compiled?.plan.chartKind ?? 'chart'
                  : result.mode
              } (${result.questionCount} Qs, 0 out tok)`,
        ms: result.ms,
        clean: result.ok,
        ...(reqData.sessionId ? { sessionId: reqData.sessionId } : {}),
      });

      return { status: 200, body: result };
    }

    if (method === 'POST' && (pathname === '/gate' || pathname === '/plugin/gate')) {
      const reqData = rawBody
        ? (JSON.parse(rawBody) as {
            targetTool?: 'openchamber_render' | 'question';
            rawInput?: Record<string, unknown>;
            includeScreenshots?: boolean;
            sessionId?: string;
          })
        : {};

      const targetTool = reqData.targetTool === 'question' ? 'question' : 'openchamber_render';
      const gateRes = await evaluateRenderGate({
        targetTool,
        rawInput: reqData.rawInput ?? {},
        client: makeClient(),
        config,
        captureHtml: (html) => captureHtmlViewports(html, { viewports: [360, 720] }),
        includeScreenshotsInResult: reqData.includeScreenshots === true,
      });

      counters.renderGates += 1;
      if (!gateRes.clean) counters.renderAdvisories += 1;
      if (gateRes.visualCritic?.evaluated) counters.visualCritics += 1;

      pushTelemetry({
        kind: gateRes.visualCritic ? 'visual_critic' : 'render_gate',
        summary: gateRes.clean
          ? `${gateRes.mode.toUpperCase()} gate clean${
              gateRes.visualCritic?.evaluated
                ? ` (360/720 fit=${gateRes.visualCritic.mobileFitScore.toFixed(1)}/3)`
                : ''
            }`
          : `${gateRes.mode.toUpperCase()} advisory: ${gateRes.findings.length} finding(s) (${gateRes.findings[0]?.code ?? 'issue'})`,
        ms: gateRes.ms,
        clean: gateRes.clean,
        ...(reqData.sessionId ? { sessionId: reqData.sessionId } : {}),
      });

      return { status: 200, body: gateRes };
    }

    if (method === 'POST' && pathname === SESSION_EVENTS_PATH) {
      const evt = readSessionEventRequest(rawBody);
      if (!evt) {
        return { status: 400, body: { ok: false, error: 'Invalid session event payload' } };
      }

      if (evt.event.type === 'turn-finished' && evt.content?.type === 'turn-finished') {
        const reply = evt.content.reply;
        const sessionId = evt.event.session.id;
        // Evaluate asynchronously after returning { ok: true } immediately per skill.txt
        void evaluateTurnEndMissedVisual({
          replyText: reply,
          client: makeClient(),
          config,
        })
          .then((check) => {
            if (!check.missed) return;
            counters.missedVisuals += 1;
            const entry = pushTelemetry({
              kind: 'missed_visual',
              summary: `Turn reply had unvisualized data -> try "${check.archetype}" (p=${check.probability.toFixed(2)})`,
              ms: check.ms,
              clean: false,
              sessionId,
              detail: {
                archetype: check.archetype,
                probability: check.probability,
                replyPreview: reply.slice(0, 500),
              },
            });
            serviceHost?.emit('missed-visual', {
              id: entry.id,
              sessionId,
              archetype: check.archetype,
              probability: check.probability,
            });
          })
          .catch(() => {});
      }

      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { error: `Unknown route ${method} ${pathname}` } };
  };

  // 1. Local Loopback Server for OpenCode Plugin (`127.0.0.1:4007`)
  let loopbackServer: http.Server | null = null;
  const desiredLoopback =
    options.loopbackPortOverride !== undefined
      ? options.loopbackPortOverride
      : config.loopbackPort;

  if (desiredLoopback !== null) {
    loopbackServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        const body = req.method === 'POST' ? await readBody(req) : '';
        const out = await handleApiRoute(req.method ?? 'GET', reqUrl.pathname, body);
        sendJson(res, out.status, out.body);
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    try {
      boundLoopbackPort = await listenLoopback(loopbackServer, desiredLoopback);
    } catch {
      // If 4007 is already held by another instance, fall back gracefully without crashing guest service
      loopbackServer = null;
      boundLoopbackPort = null;
    }
  }

  // 2. OpenChamber Bearer-Authenticated Guest Service Host
  let serviceServer: http.Server | null = null;
  let boundServicePort: number | null = null;
  const desiredServicePort =
    options.servicePort !== undefined
      ? options.servicePort
      : env.OPENCHAMBER_SERVICE_PORT
        ? Number(env.OPENCHAMBER_SERVICE_PORT)
        : null;

  if (desiredServicePort !== null && Number.isInteger(desiredServicePort)) {
    serviceServer = http.createServer(async (req, res) => {
      if (serviceToken && req.headers.authorization !== `Bearer ${serviceToken}`) {
        sendJson(res, 401, { error: 'Unauthorized' });
        return;
      }
      try {
        const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        const body = req.method === 'POST' ? await readBody(req) : '';
        const out = await handleApiRoute(req.method ?? 'GET', reqUrl.pathname, body);
        sendJson(res, out.status, out.body);
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    boundServicePort = await listenLoopback(serviceServer, desiredServicePort);
  }

  return {
    servicePort: boundServicePort,
    loopbackPort: boundLoopbackPort,
    getSnapshot,
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => {
          if (!loopbackServer) return resolve();
          loopbackServer.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          if (!serviceServer) return resolve();
          serviceServer.close(() => resolve());
        }),
        closeWarmBrowser(),
      ]);
    },
  };
}
