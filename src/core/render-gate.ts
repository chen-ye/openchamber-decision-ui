import { lintOpenUiSource } from './ast-linter.ts';
import {
  getChoiceAnswer,
  getNoulAnswer,
  getScoreAnswer,
  type DecisionBridgeClient,
} from './client.ts';
import type {
  DecisionQuestion,
  DecisionUiConfig,
  RenderGateFinding,
  RenderGateResult,
  ViewportScreenshot,
  VisualCriticResult,
} from './types.ts';
import { evaluateVisualCritic } from './visual-critic.ts';

function summarizeHtmlForPolicyCheck(html: string): string {
  if (html.length <= 9000) return html;
  // Strip verbose CSS declarations so <body> markup and <script> interactivity remain visible
  const slimmedCss = html.replace(
    /<style\b[^>]*>([\s\S]*?)<\/style>/gi,
    (_, css: string) => `<style>/* ${css.length} chars of CSS omitted */</style>`,
  );
  return slimmedCss.slice(0, 9000);
}

function buildHtmlPolicyQuestions(): Readonly<Record<string, DecisionQuestion>> {
  return {
    is_data_in_html: {
      type: 'noul',
      instructions:
        'Is this HTML page JUST a plain data chart, simple Markdown-style table, or static metric comparison that OpenChamber\'s built-in openui-lang components (BarChart, LineChart, Table, Stat, Card) could draw directly—as opposed to a bespoke application/dashboard UI mockup with custom interactive trays, sparklines, status pills, or layout design?',
      criteria: {
        true_description:
          'A plain static data table, basic bar/line chart, or KPI list with no bespoke product UI layout, interactive drawers/trays, or custom visual design.',
        false_description:
          'An application UI mockup (including dashboard/matrix UI designs with expandable failure trays, inline spark-strips, custom toolbars, or interactive state) or custom SVG diagram that openui-lang cannot express.',
      },
    },
    has_viewport_height_bug: {
      type: 'noul',
      instructions:
        'Does the HTML/CSS use 100vh or height:100% on html/body or wrap the entire root in an unnecessary outer card border/banner title against OpenChamber render rules?',
      criteria: {
        true_description:
          'Uses 100vh / height:100% on html/body or adds a redundant outer card border and banner header around the entire page.',
        false_description:
          'Uses content-driven or fixed drawing pixel heights and sits cleanly on the chat background.',
      },
    },
  };
}

function buildUiPolicyQuestions(awaitAnswer: boolean): Readonly<Record<string, DecisionQuestion>> {
  return {
    tufte_quality: {
      type: 'score',
      instructions:
        'Rate the communication & data-ink clarity of this openui-lang block (clear visual hierarchy, concise labels, meaningful chart/control selection, non-redundant structure).',
      criteria: [
        'Cluttered or mismatched: wrong chart type (e.g. LineChart for unordered categories or whole=true on non-additive numbers) or verbose wall-of-text cards.',
        'Mediocre: verbose labels or redundant components.',
        'Good: appropriate component choices and readable labels.',
        'High data-ink clarity: crisp Tufte pairing of visuals and numbers with concise scannable labels.',
      ],
    },
    ...(awaitAnswer
      ? {
          is_trivial_yes_no: {
            type: 'noul',
            instructions:
              'Is this waiting UI page asking a trivial single-question closed clarification where free-form user conditions add no value (better suited to the lightweight question tool)?',
            criteria: {
              true_description: 'Trivial binary/closed factual clarification with no scope/trade-off nuance.',
              false_description:
                'Direction-setting scope, design, or trade-off choice where user condition notes are helpful.',
            },
          },
        }
      : {}),
  };
}

function buildQuestionToolPolicyQuestions(): Readonly<Record<string, DecisionQuestion>> {
  return {
    needs_render_ui_await: {
      type: 'noul',
      instructions:
        'Is this `question` tool call asking the user to make an architectural, scope, or trade-off decision that sets the direction of the work (where OpenChamber rules require `openchamber_render` with `ui` and `awaitAnswer: true` so the user can add condition notes)?',
      criteria: {
        true_description:
          'Sets project direction, architecture, scope, or trade-offs where the user may want to attach conditions/constraints to their pick.',
        false_description:
          'Quick, self-contained clarification fully answered by picking one of the listed options.',
      },
    },
  };
}

export function formatAdvisoryNote(findings: ReadonlyArray<RenderGateFinding>): string | null {
  if (findings.length === 0) return null;
  const bullets = findings.map((f) => {
    const tag =
      f.source === 'visual_critic' || f.source === 'dom'
        ? 'Visual Critic'
        : f.source === 'ast'
          ? 'AST Lint'
          : 'Policy Gate';
    return `- [${tag} · ${f.severity}] ${f.message}`;
  });
  return [
    '[Decision UI Advisory]',
    ...bullets,
    'If any issue above degrades usability or violates the surface contract, re-render cleanly before concluding; otherwise continue.',
  ].join('\n');
}

export async function evaluateRenderGate(params: {
  readonly targetTool: 'openchamber_render' | 'question';
  readonly rawInput: Record<string, unknown>;
  readonly client: DecisionBridgeClient;
  readonly config: DecisionUiConfig;
  readonly captureHtml?: (html: string) => Promise<ReadonlyArray<ViewportScreenshot>>;
  readonly includeScreenshotsInResult?: boolean;
}): Promise<RenderGateResult> {
  const started = Date.now();
  const findings: RenderGateFinding[] = [];
  const threshold = params.config.advisoryThreshold;

  if (params.targetTool === 'question') {
    const serialized = JSON.stringify(params.rawInput).slice(0, 4000);
    if (params.config.renderGateEnabled) {
      const batch = await params.client.evaluate({
        input: `Tool call: question\nInput:\n${serialized}`,
        questions: buildQuestionToolPolicyQuestions(),
        timeoutMs: 2200,
      });
      if (batch.ok) {
        const check = getNoulAnswer(batch, 'needs_render_ui_await', 0);
        if (check.probability >= threshold) {
          findings.push({
            source: 'decision',
            severity: 'warning',
            code: 'prefer_render_ui_await',
            probability: check.probability,
            message: `Direction-setting choice detected on \`question\` tool (p=${check.probability.toFixed(2)}): prefer \`openchamber_render\` with \`ui\` (\`openui-lang\`) and \`awaitAnswer: true\` next time so the user can attach conditions in \`data.note\`.`,
          });
        }
      }
    }
    const advisoryNote = formatAdvisoryNote(findings);
    return {
      targetTool: 'question',
      mode: 'question',
      clean: findings.length === 0,
      ms: Date.now() - started,
      findings,
      advisoryNote,
    };
  }

  // Unwrap OpenChamber flattened vs nested `parameters`
  const nestedParams =
    params.rawInput.parameters &&
    typeof params.rawInput.parameters === 'object' &&
    !Array.isArray(params.rawInput.parameters)
      ? (params.rawInput.parameters as Record<string, unknown>)
      : {};
  const merged = { ...params.rawInput, ...nestedParams };

  const ui = typeof merged.ui === 'string' ? merged.ui.trim() : '';
  const html = typeof merged.html === 'string' ? merged.html.trim() : '';
  const title = typeof merged.title === 'string' ? merged.title.trim() : undefined;
  const awaitAnswer = merged.awaitAnswer === true || merged.awaitAnswer === 'true';

  if (ui) {
    const astLint = lintOpenUiSource(ui);
    for (const issue of astLint.issues) {
      findings.push({
        source: 'ast',
        severity: issue.severity,
        code: issue.code,
        message: issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message,
      });
    }

    if (params.config.renderGateEnabled) {
      const batch = await params.client.evaluate({
        input: `openchamber_render (ui, awaitAnswer=${awaitAnswer}, title=${title ?? 'none'}):\n${ui.slice(0, 6000)}`,
        questions: buildUiPolicyQuestions(awaitAnswer),
        timeoutMs: 2500,
      });
      if (batch.ok) {
        const tufte = getScoreAnswer(batch, 'tufte_quality', 3);
        if (tufte.score < 1.4) {
          findings.push({
            source: 'decision',
            severity: 'warning',
            code: 'low_tufte_clarity',
            message: `openui-lang communication/Tufte clarity scored ${tufte.score.toFixed(2)}/3.00: verify chart type matches data semantics and trim verbose card text.`,
          });
        }
      }
    }

    const advisoryNote = formatAdvisoryNote(findings);
    return {
      targetTool: 'openchamber_render',
      mode: 'ui',
      clean: findings.length === 0,
      ms: Date.now() - started,
      findings,
      advisoryNote,
      astLint,
    };
  }

  // HTML render path: run Policy Gate + Multimodal 360px/720px Visual Critic concurrently!
  let visualCritic: VisualCriticResult | undefined;

  const htmlPolicyPromise = params.config.renderGateEnabled
    ? params.client.evaluate({
        input: `openchamber_render (html, awaitAnswer=${awaitAnswer}, title=${title ?? 'none'}):\n${summarizeHtmlForPolicyCheck(html)}`,
        questions: buildHtmlPolicyQuestions(),
        timeoutMs: 3000,
      })
    : Promise.resolve(null);

  const criticPromise =
    params.config.visualCriticEnabled && params.captureHtml && html.length > 0
      ? params
          .captureHtml(html)
          .then((viewports) =>
            evaluateVisualCritic({
              viewports,
              htmlSource: html,
              ...(title ? { title } : {}),
              client: params.client,
              config: params.config,
              includeDataUrls: params.includeScreenshotsInResult === true,
            }),
          )
          .catch((): undefined => undefined)
      : Promise.resolve(undefined);

  const [policyBatch, criticRes] = await Promise.all([htmlPolicyPromise, criticPromise]);

  // Fast deterministic CSS 100vh check on html/body
  if (/html\s*,\s*body[^}]*(?:100vh|height\s*:\s*100%)|body\s*\{[^}]*(?:100vh|height\s*:\s*100%)/i.test(html)) {
    findings.push({
      source: 'ast',
      severity: 'warning',
      code: 'html_100vh_body',
      message:
        'HTML sets `100vh` or `height: 100%` on `html`/`body`; OpenChamber sizes frames to content height—use fixed pixel heights on drawings instead.',
    });
  }

  if (policyBatch?.ok) {
    const dataInHtml = getNoulAnswer(policyBatch, 'is_data_in_html', 0);
    if (dataInHtml.probability >= threshold) {
      findings.push({
        source: 'decision',
        severity: 'warning',
        code: 'data_rendered_as_html',
        probability: dataInHtml.probability,
        message: `HTML appears to render charts/tables/comparisons (p=${dataInHtml.probability.toFixed(2)}), which OpenChamber rules reserve for \`openui-lang\` blocks ("Never for data").`,
      });
    }
  }

  if (criticRes) {
    visualCritic = criticRes;
    findings.push(...criticRes.findings);
  }

  const advisoryNote = formatAdvisoryNote(findings);
  return {
    targetTool: 'openchamber_render',
    mode: 'html',
    clean: findings.length === 0,
    ms: Date.now() - started,
    findings,
    advisoryNote,
    ...(visualCritic ? { visualCritic } : {}),
  };
}

/**
 * Pure helper that injects an advisory note into a completed OpenCode `Tool.Result`
 * without breaking `openchamber_render`'s JSON `{ schemaVersion: 1, ok: true, data: { note } }` envelope.
 */
export function mergeAdvisoryIntoToolContent(
  originalContent: string | undefined,
  advisoryNote: string | null,
): string | undefined {
  if (!advisoryNote) return originalContent;
  if (!originalContent) return advisoryNote;

  const trimmed = originalContent.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.schemaVersion === 1 && parsed.data && typeof parsed.data === 'object') {
        const dataObj = parsed.data as Record<string, unknown>;
        const prevNote = typeof dataObj.note === 'string' ? dataObj.note : '';
        return JSON.stringify({
          ...parsed,
          data: {
            ...dataObj,
            note: prevNote ? `${prevNote}\n\n${advisoryNote}` : advisoryNote,
          },
        });
      }
    } catch {
      // Fall through to plain text append
    }
  }

  return `${originalContent}\n\n${advisoryNote}`;
}

const MISSED_VISUAL_ARCHETYPES = [
  'bar_plus_table',
  'line_plus_stats',
  'none',
  'share_whole_bar',
  'steps_flow',
] as const;

export async function evaluateTurnEndMissedVisual(params: {
  readonly replyText: string;
  readonly client: DecisionBridgeClient;
  readonly config: DecisionUiConfig;
}): Promise<{
  readonly missed: boolean;
  readonly probability: number;
  readonly archetype: string;
  readonly ms: number;
}> {
  const text = params.replyText.trim();
  // Fast 0ms pre-filter: skip if reply already contains openui-lang or lacks numeric/tabular density
  if (
    !params.config.turnEndDetectorEnabled ||
    text.length < 180 ||
    /```openui(?:-lang)?/i.test(text)
  ) {
    return { missed: false, probability: 0, archetype: 'none', ms: 0 };
  }

  const numberMatches = text.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
  const hasPipeTable = /\|.+\|\s*\n\s*\|[\s:-]+\|/.test(text);
  if (numberMatches.length < 4 && !hasPipeTable) {
    return { missed: false, probability: 0, archetype: 'none', ms: 0 };
  }

  const batch = await params.client.evaluate({
    input: `Assistant reply:\n${text.slice(0, 5000)}`,
    questions: {
      missed_visual: {
        type: 'noul',
        instructions:
          'Did this plain-text assistant reply present a multi-item numerical comparison, Markdown numeric table, or metric breakdown that would be substantially clearer with an inline openui-lang visual companion (BarChart, LineChart, Progress, Stat)?',
        criteria: {
          true_description:
            'Contains a naked numeric Markdown table or dense multi-item metric comparison with no visual chart/stat block.',
          false_description:
            'Prose, code, logs, line numbers, or a brief 2-number mention that needs no chart.',
        },
      },
      archetype: {
        type: 'choice',
        instructions: 'Which openui-lang visual would best complement this reply?',
        criteria: {
          bar_plus_table: 'BarChart paired with Table across categories.',
          line_plus_stats: 'LineChart with summary Stat tiles over time/sequence.',
          none: 'Plain text is better.',
          share_whole_bar: 'Whole-share BarChart adding up to 100%.',
          steps_flow: 'Steps flow diagram.',
        },
      },
    },
    timeoutMs: 2500,
  });

  if (!batch.ok) {
    return { missed: false, probability: 0, archetype: 'none', ms: batch.ms };
  }

  const missedAns = getNoulAnswer(batch, 'missed_visual', 0);
  const archAns = getChoiceAnswer(batch, 'archetype', MISSED_VISUAL_ARCHETYPES, 'bar_plus_table');
  return {
    missed: missedAns.probability >= params.config.advisoryThreshold,
    probability: missedAns.probability,
    archetype: archAns.choice,
    ms: batch.ms,
  };
}
