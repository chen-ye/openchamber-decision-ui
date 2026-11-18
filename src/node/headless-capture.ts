import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ViewportScreenshot } from '../core/types.ts';

/**
 * OpenChamber host base stylesheet & dark theme CSS variables mirroring
 * `packages/ui/src/components/chat/lib/visualKit.ts` so `openchamber_render`
 * HTML documents render faithfully during headless 360px/720px Visual Critic runs.
 */
const OPENCHAMBER_HOST_PRELUDE_CSS = `
:root {
  color-scheme: dark;
  --background: #131417;
  --foreground: #eceef2;
  --muted: #1d2026;
  --muted-foreground: #939aa8;
  --card: #181a20;
  --card-foreground: #eceef2;
  --border: rgba(255, 255, 255, 0.11);
  --primary: #6ea8fe;
  --primary-foreground: #0d1321;
  --destructive: #f87171;
  --warning: #fbbf24;
  --success: #34d399;
  --info: #60a5fa;
  --code-background: #101216;
  --code-foreground: #e5e7eb;
  --chart-1: #60a5fa;
  --chart-2: #34d399;
  --chart-3: #fbbf24;
  --chart-4: #f472b6;
  --chart-5: #a78bfa;
  --chart-6: #fb923c;
  --radius: 10px;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
html, body {
  margin: 0;
  padding: 0;
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  font-size: 15px;
  line-height: 1.5;
}
*, *::before, *::after { box-sizing: border-box; }
.oc-box {
  background: var(--card);
  border-radius: var(--radius);
  padding: 0.85rem 1rem;
}
.oc-box .oc-box { background: var(--muted); }
.oc-muted { color: var(--muted-foreground); }
.oc-table { overflow-x: auto; width: 100%; }
.oc-num { font-variant-numeric: tabular-nums; text-align: end; }
.oc-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.12rem 0.5rem;
  border-radius: 999px;
  font-size: 0.78rem;
  background: var(--muted);
  color: var(--foreground);
}
.oc-badge[data-tone="success"] { color: var(--success); }
.oc-badge[data-tone="warning"] { color: var(--warning); }
.oc-badge[data-tone="error"] { color: var(--destructive); }
.oc-badge[data-tone="info"] { color: var(--info); }
.oc-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.45rem 0.9rem;
  border-radius: calc(var(--radius) - 2px);
  border: 1px solid transparent;
  background: var(--primary);
  color: var(--primary-foreground);
  font-weight: 500;
  cursor: pointer;
}
.oc-button[data-variant="outline"] {
  background: transparent;
  border-color: var(--border);
  color: var(--foreground);
}
.oc-input {
  width: 100%;
  padding: 0.4rem 0.6rem;
  border-radius: calc(var(--radius) - 3px);
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--foreground);
}
`;

export function injectHostThemeIntoHtml(rawHtml: string): string {
  const viewportMeta = /<meta[^>]+name=["']viewport["']/i.test(rawHtml)
    ? ''
    : '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const styleTag = `${viewportMeta}<style data-oc-host-theme>${OPENCHAMBER_HOST_PRELUDE_CSS}</style>`;
  if (/<head[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${styleTag}`);
  }
  if (/<html[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${styleTag}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${styleTag}</head><body>${rawHtml}</body></html>`;
}

export function discoverHeadlessChromeBinary(): string | null {
  const envBin = process.env.DECISION_UI_CHROME_BIN?.trim();
  if (envBin && fs.existsSync(envBin)) return envBin;

  const pwCache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(pwCache)) {
    try {
      const entries = fs
        .readdirSync(pwCache)
        .filter((name) => name.startsWith('chromium_headless_shell-'))
        .sort()
        .reverse();
      for (const dir of entries) {
        const candidate = path.join(
          pwCache,
          dir,
          'chrome-headless-shell-linux64',
          'chrome-headless-shell',
        );
        if (fs.existsSync(candidate)) return candidate;
      }
      const fullEntries = fs
        .readdirSync(pwCache)
        .filter((name) => name.startsWith('chromium-'))
        .sort()
        .reverse();
      for (const dir of fullEntries) {
        const candidate = path.join(pwCache, dir, 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Ignore fs scan errors
    }
  }

  const systemCandidates = [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const bin of systemCandidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

class CdpConnection {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (val: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private readonly listeners = new Map<
    string,
    Array<(params: Record<string, unknown>, sessionId?: string) => void>
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          sessionId?: string;
          result?: Record<string, unknown>;
          error?: { message?: string };
        };
        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message ?? 'CDP error'));
            } else {
              entry.resolve(msg.result ?? {});
            }
          }
          return;
        }
        if (msg.method) {
          const handlers = this.listeners.get(msg.method);
          if (handlers) {
            for (const fn of handlers) {
              fn(msg.params ?? {}, msg.sessionId);
            }
          }
        }
      } catch {
        // Ignore malformed CDP message
      }
    });

    ws.addEventListener('close', () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error('CDP WebSocket closed'));
      }
      this.pending.clear();
    });
  }

  public static async connect(wsUrl: string, timeoutMs = 4000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to CDP at ${wsUrl}`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to CDP at ${wsUrl}`));
      });
    });
  }

  public on(
    method: string,
    handler: (params: Record<string, unknown>, sessionId?: string) => void,
  ): () => void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => {
      const cur = this.listeners.get(method) ?? [];
      this.listeners.set(
        method,
        cur.filter((h) => h !== handler),
      );
    };
  }

  public send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 4000,
  ): Promise<Record<string, unknown>> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  public get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  public close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

interface WarmBrowserHandle {
  readonly proc: ChildProcess;
  readonly cdp: CdpConnection;
}

let warmBrowser: WarmBrowserHandle | null = null;
let launchingPromise: Promise<WarmBrowserHandle> | null = null;

async function getWarmBrowser(): Promise<WarmBrowserHandle> {
  if (warmBrowser && warmBrowser.cdp.isOpen && warmBrowser.proc.exitCode === null) {
    return warmBrowser;
  }
  if (launchingPromise) return launchingPromise;

  launchingPromise = (async () => {
    const binary = discoverHeadlessChromeBinary();
    if (!binary) {
      throw new Error('No headless Chrome / Chromium binary found for Visual Critic.');
    }

    const proc = spawn(
      binary,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--remote-debugging-port=0',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const wsUrl = await new Promise<string>((resolve, reject) => {
      let stderrBuf = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Timed out waiting for headless Chrome DevTools endpoint.'));
      }, 5000);

      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });

      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Headless Chrome exited early with code ${code ?? 'unknown'}`));
      });
    });

    const cdp = await CdpConnection.connect(wsUrl);
    const handle: WarmBrowserHandle = { proc, cdp };
    warmBrowser = handle;

    const cleanup = () => {
      if (warmBrowser === handle) warmBrowser = null;
      cdp.close();
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    };
    proc.once('exit', cleanup);
    process.once('exit', cleanup);

    return handle;
  })();

  try {
    return await launchingPromise;
  } finally {
    launchingPromise = null;
  }
}

export async function closeWarmBrowser(): Promise<void> {
  const current = warmBrowser;
  warmBrowser = null;
  if (!current) return;
  current.cdp.close();
  if (current.proc.exitCode === null) {
    current.proc.kill('SIGTERM');
  }
}

export interface CaptureHtmlOptions {
  readonly viewports?: ReadonlyArray<number>;
  readonly maxHeight?: number;
  readonly settleMs?: number;
  readonly injectTheme?: boolean;
}

/**
 * Renders a self-contained HTML document inside headless Chromium across target
 * widths (default: `360px` phone and `720px` desktop reply column), capturing
 * PNG screenshots, exact DOM overflow dimensions, and uncaught runtime errors.
 */
export async function captureHtmlViewports(
  rawHtml: string,
  options: CaptureHtmlOptions = {},
): Promise<ReadonlyArray<ViewportScreenshot>> {
  const widths = options.viewports ?? [360, 720];
  const maxHeight = options.maxHeight ?? 1400;
  const settleMs = options.settleMs ?? 90;
  const html = options.injectTheme === false ? rawHtml : injectHostThemeIntoHtml(rawHtml);

  const { cdp } = await getWarmBrowser();
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = String(created.targetId ?? '');
  if (!targetId) {
    throw new Error('CDP failed to create page target');
  }

  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = String(attached.sessionId ?? '');
  const pageErrors: string[] = [];

  const unsubException = cdp.on('Runtime.exceptionThrown', (params, evtSession) => {
    if (evtSession !== sessionId) return;
    const details = params.exceptionDetails as Record<string, unknown> | undefined;
    const exception = details?.exception as Record<string, unknown> | undefined;
    const desc =
      typeof exception?.description === 'string'
        ? exception.description.split('\n')[0]
        : typeof details?.text === 'string'
          ? details.text
          : 'Script error';
    if (desc && pageErrors.length < 5) {
      pageErrors.push(desc.slice(0, 180));
    }
  });

  try {
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const frameTree = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frame = (frameTree.frameTree as { frame?: { id?: string } } | undefined)?.frame;
    const frameId = frame?.id ?? targetId;

    await cdp.send('Page.setDocumentContent', { frameId, html }, sessionId);
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
    }

    const screenshots: ViewportScreenshot[] = [];

    for (const width of widths) {
      pageErrors.length = 0;
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width,
          height: 540,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );

      // Re-set content or dispatch resize so responsive scripts & SVG viewBoxes reflow cleanly
      await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            window.dispatchEvent(new Event('resize'));
            const docEl = document.documentElement;
            const body = document.body;
            const rect = body ? body.getBoundingClientRect() : { height: 0, width: 0 };
            const scrollWidth = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
            const clientWidth = docEl ? docEl.clientWidth : ${width};
            const contentHeight = Math.ceil(Math.max(
              body ? body.scrollHeight : 0,
              body ? body.offsetHeight : 0,
              rect.height
            ));
            const textLen = (body ? body.innerText : '').trim().length;
            const visualNodes = document.querySelectorAll('svg, canvas, img, table, input, button, select').length;
            return { scrollWidth, clientWidth, contentHeight, textLen, visualNodes };
          })()`,
          returnByValue: true,
        },
        sessionId,
      );

      await new Promise((r) => setTimeout(r, 35));

      const metricsRes = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const docEl = document.documentElement;
            const body = document.body;
            const scrollWidth = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
            const clientWidth = docEl ? docEl.clientWidth : ${width};
            let maxBottom = 0;
            for (const el of Array.from(body ? body.children : [])) {
              const r = el.getBoundingClientRect();
              if (r.bottom > maxBottom) maxBottom = r.bottom;
            }
            const scrollHeight = Math.ceil(Math.max(maxBottom, body ? body.scrollHeight : 0));
            const textLen = (body ? body.innerText : '').trim().length;
            const visualNodes = document.querySelectorAll('svg, canvas, img, table, input, button, select').length;
            return { scrollWidth, clientWidth, scrollHeight, textLen, visualNodes };
          })()`,
          returnByValue: true,
        },
        sessionId,
      );

      const rawVal = (
        metricsRes.result as { value?: Record<string, unknown> } | undefined
      )?.value ?? {};
      const scrollWidth = Number(rawVal.scrollWidth ?? width);
      const clientWidth = Number(rawVal.clientWidth ?? width);
      const scrollHeight = Number(rawVal.scrollHeight ?? 0);
      const textLen = Number(rawVal.textLen ?? 0);
      const visualNodes = Number(rawVal.visualNodes ?? 0);

      const captureHeight = Math.min(maxHeight, Math.max(180, scrollHeight + 16));
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width,
          height: captureHeight,
          deviceScaleFactor: 1,
          mobile: false,
        },
        sessionId,
      );

      const shotRes = await cdp.send(
        'Page.captureScreenshot',
        {
          format: 'png',
          clip: { x: 0, y: 0, width, height: captureHeight, scale: 1 },
        },
        sessionId,
      );
      const pngBase64 = String(shotRes.data ?? '');

      screenshots.push({
        width,
        height: captureHeight,
        pngBase64,
        scrollWidth,
        scrollHeight,
        clientWidth,
        hasHorizontalOverflow: scrollWidth > clientWidth + 4,
        isCollapsedOrEmpty: (textLen === 0 && visualNodes === 0) || scrollHeight < 8,
        pageErrors: [...pageErrors],
      });
    }

    return screenshots;
  } finally {
    unsubException();
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}
