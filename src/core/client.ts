import type {
  ChoiceAnswer,
  DecisionAnswer,
  DecisionBatchResult,
  DecisionContentBlock,
  DecisionQuestion,
  NoulAnswer,
  ScoreAnswer,
} from './types.ts';

export interface DecisionClientOptions {
  readonly bridgeUrl: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function clamp01(val: unknown, fallback = 0): number {
  const num = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.min(1, Math.max(0, num));
}

function parseAnswer(raw: unknown): DecisionAnswer | null {
  if (!isRecord(raw)) return null;

  if (typeof raw.noul === 'number') {
    const noul = clamp01(raw.noul, 0.5);
    const confidence =
      typeof raw.confidence === 'number' ? clamp01(raw.confidence) : Math.max(noul, 1 - noul);
    return { type: 'noul', noul, confidence } satisfies NoulAnswer;
  }

  if (typeof raw.choice === 'string') {
    const probsRaw = isRecord(raw.probabilities) ? raw.probabilities : {};
    const probabilities: Record<string, number> = {};
    for (const [key, val] of Object.entries(probsRaw)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        probabilities[key] = clamp01(val);
      }
    }
    const topProb = probabilities[raw.choice] ?? 0;
    const confidence = typeof raw.confidence === 'number' ? clamp01(raw.confidence, topProb) : topProb;
    return {
      type: 'choice',
      choice: raw.choice,
      probabilities,
      confidence,
    } satisfies ChoiceAnswer;
  }

  if (typeof raw.score === 'number') {
    const probsRaw = isRecord(raw.probabilities) ? raw.probabilities : {};
    const probabilities: Record<string, number> = {};
    let maxP = 0;
    for (const [key, val] of Object.entries(probsRaw)) {
      if (typeof val === 'number' && Number.isFinite(val)) {
        const clamped = clamp01(val);
        probabilities[key] = clamped;
        if (clamped > maxP) maxP = clamped;
      }
    }
    const confidence = typeof raw.confidence === 'number' ? clamp01(raw.confidence, maxP) : maxP;
    return {
      type: 'score',
      score: raw.score,
      probabilities,
      confidence,
    } satisfies ScoreAnswer;
  }

  return null;
}

/**
 * Sanitizes candidate option keys to obey Gemini Decisions API choice key constraints:
 * 1..128 chars, ASCII printable without leading/trailing whitespace or control characters.
 */
export function sanitizeChoiceKey(rawKey: string, fallbackIndex: number): string {
  const cleaned = rawKey
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return cleaned.length > 0 ? cleaned : `opt_${fallbackIndex}`;
}

export interface DecisionBridgeClient {
  readonly evaluate: (params: {
    readonly input: string | ReadonlyArray<DecisionContentBlock>;
    readonly questions: Readonly<Record<string, DecisionQuestion>>;
    readonly timeoutMs?: number;
  }) => Promise<DecisionBatchResult>;
  readonly checkHealth: (timeoutMs?: number) => Promise<boolean>;
}

/**
 * Zero-dependency client supporting both:
 * 1. Native Google Gemini Decisions passthrough (`POST /v1beta/decisions` on gemini-decisions-bridge :4006)
 * 2. SystemOne endpoint (`POST /v1/systemone` on LM Studio :1234 or :4006) when `bridgeUrl` ends with `/systemone`
 */
export function createDecisionBridgeClient(options: DecisionClientOptions): DecisionBridgeClient {
  const fetchFn = options.fetchImpl ?? fetch;
  const base = options.bridgeUrl.replace(/\/+$/, '');
  const model = options.model ?? 'gemini-decision-1';
  const defaultTimeoutMs = options.timeoutMs ?? 3500;
  const usesSystemOnePath = base.endsWith('/systemone');

  return {
    async checkHealth(timeoutMs = 1200): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const healthUrl = usesSystemOnePath
          ? `${base.replace(/\/v1\/systemone$|\/systemone$/, '')}/health`
          : `${base}/health`;
        const res = await fetchFn(healthUrl, { method: 'GET', signal: controller.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },

    async evaluate({ input, questions, timeoutMs = defaultTimeoutMs }): Promise<DecisionBatchResult> {
      const started = Date.now();
      if (Object.keys(questions).length === 0) {
        return { ok: true, ms: 0, model, inputTokens: 0, answers: {} };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const endpoint = usesSystemOnePath ? base : `${base}/v1beta/decisions`;
        const payload = usesSystemOnePath
          ? buildSystemOnePayload(model, input, questions)
          : buildGooglePayload(model, input, questions);

        const res = await fetchFn(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        const rawText = await res.text();
        const ms = Date.now() - started;

        if (!res.ok) {
          return {
            ok: false,
            ms,
            model,
            inputTokens: 0,
            answers: {},
            error: `Decision bridge HTTP ${res.status}: ${rawText.slice(0, 240)}`,
          };
        }

        const parsed: unknown = rawText ? JSON.parse(rawText) : {};
        if (!isRecord(parsed) || !isRecord(parsed.answers)) {
          return {
            ok: false,
            ms,
            model,
            inputTokens: 0,
            answers: {},
            error: 'Decision bridge response missing answers map',
          };
        }

        const answers: Record<string, DecisionAnswer> = {};
        for (const [qName, qVal] of Object.entries(parsed.answers)) {
          const norm = parseAnswer(qVal);
          if (norm) answers[qName] = norm;
        }

        const usage = isRecord(parsed.usage) ? parsed.usage : {};
        const inputTokens =
          typeof usage.total_input_tokens === 'number'
            ? usage.total_input_tokens
            : typeof usage.input_tokens === 'number'
              ? usage.input_tokens
              : 0;

        return {
          ok: true,
          ms,
          model: typeof parsed.model === 'string' ? parsed.model : model,
          inputTokens,
          answers,
        };
      } catch (err) {
        const ms = Date.now() - started;
        const message =
          err instanceof Error && err.name === 'AbortError'
            ? `Decision bridge timed out after ${timeoutMs}ms`
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          ok: false,
          ms,
          model,
          inputTokens: 0,
          answers: {},
          error: message,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Ensures adjacent text blocks are separated by a newline because Google's
 * `/v1beta/decisions` concatenates adjacent text blocks without a separator.
 */
function normalizeGoogleInput(
  input: string | ReadonlyArray<DecisionContentBlock>,
): string | ReadonlyArray<DecisionContentBlock> {
  if (typeof input === 'string') {
    return input.trim().length > 0 ? input : '(empty)';
  }
  const merged: DecisionContentBlock[] = [];
  for (const block of input) {
    const prev = merged.at(-1);
    if (block.type === 'text' && prev?.type === 'text') {
      merged[merged.length - 1] = {
        type: 'text',
        text: `${prev.text}\n${block.text}`,
      };
    } else {
      merged.push(block);
    }
  }
  return merged.length > 0 ? merged : '(empty)';
}

function buildGooglePayload(
  model: string,
  input: string | ReadonlyArray<DecisionContentBlock>,
  questions: Readonly<Record<string, DecisionQuestion>>,
): Record<string, unknown> {
  return {
    model,
    input: normalizeGoogleInput(input),
    questions,
  };
}

function buildSystemOnePayload(
  model: string,
  input: string | ReadonlyArray<DecisionContentBlock>,
  questions: Readonly<Record<string, DecisionQuestion>>,
): Record<string, unknown> {
  const state: unknown[] = [];
  const images: string[] = [];

  if (typeof input === 'string') {
    state.push(input);
  } else {
    for (const block of input) {
      if (block.type === 'text') {
        state.push(block.text);
      } else if (block.type === 'image' && block.data) {
        images.push(`data:${block.mime_type};base64,${block.data}`);
      }
    }
  }

  return {
    model,
    state: state.length === 1 ? state[0] : state,
    ...(images.length > 0 ? { images } : {}),
    questions,
  };
}

export function getNoulAnswer(
  result: DecisionBatchResult,
  key: string,
  fallback = 0,
): { readonly probability: number; readonly confidence: number } {
  const ans = result.answers[key];
  if (ans && 'noul' in ans) {
    return { probability: ans.noul, confidence: ans.confidence };
  }
  return { probability: fallback, confidence: 0 };
}

export function getChoiceAnswer<T extends string>(
  result: DecisionBatchResult,
  key: string,
  allowed: ReadonlyArray<T>,
  fallback: T,
): { readonly choice: T; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> } {
  const ans = result.answers[key];
  if (ans && 'choice' in ans) {
    const matched = allowed.find((item) => item === ans.choice);
    if (matched !== undefined) {
      return {
        choice: matched,
        confidence: ans.confidence,
        probabilities: ans.probabilities,
      };
    }
  }
  return { choice: fallback, confidence: 0, probabilities: {} };
}

export function getScoreAnswer(
  result: DecisionBatchResult,
  key: string,
  fallback = 0,
): { readonly score: number; readonly confidence: number; readonly probabilities: Readonly<Record<string, number>> } {
  const ans = result.answers[key];
  if (ans && 'score' in ans) {
    return { score: ans.score, confidence: ans.confidence, probabilities: ans.probabilities };
  }
  return { score: fallback, confidence: 0, probabilities: {} };
}
