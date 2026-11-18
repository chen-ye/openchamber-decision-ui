import { getChoiceAnswer, getNoulAnswer, type DecisionBridgeClient } from './client.ts';
import type {
  DecisionQuestion,
  DecisionUiConfig,
  SurfaceRouteDecision,
  UiSurfaceChoice,
  UiVisualArchetype,
} from './types.ts';

export const ALLOWED_UI_SURFACES: ReadonlyArray<UiSurfaceChoice> = [
  'plain_reply',
  'reply_ui_block',
  'reply_decision_cards',
  'render_ui_await',
  'render_html_mockup',
  'question_tool',
];

export const ALLOWED_VISUAL_ARCHETYPES: ReadonlyArray<UiVisualArchetype> = [
  'none',
  'bar_plus_table',
  'share_whole_bar',
  'line_plus_stats',
  'steps_flow',
  'stat_summary',
  'choice_form',
  'custom_html',
];

export function buildSurfaceRouterQuestions(): Readonly<Record<string, DecisionQuestion>> {
  return {
    needs_ui: {
      type: 'noul',
      instructions:
        'Would a high-quality response to the latest user request either render structured visual UI (charts, tables, metrics, architecture/step flows, HTML mockups) OR present an interactive user decision widget/form?',
      criteria: {
        true_description:
          'The user asks to compare items, inspect metrics/benchmarks/breakdowns, explain a multi-step flow/pipeline, mock up/design an interface, or weigh architectural options/trade-offs.',
        false_description:
          'The user asks for direct code edits, bug fixes, shell/git operations, file lookups, or a brief factual/code answer best shown as plain Markdown and code fences.',
      },
    },
    surface: {
      type: 'choice',
      instructions:
        'Select the single best OpenChamber response surface for the latest user request.',
      criteria: {
        plain_reply:
          'Plain Markdown prose and code blocks only; no UI blocks, forms, or HTML render pages needed.',
        question_tool:
          'Quick closed clarification question whose short options completely cover the answer, with no free-form conditions needed.',
        render_html_mockup:
          'openchamber_render with self-contained HTML/SVG for a visual UI mockup, layout preview, or custom drawing that UI blocks cannot express (never for data charts/tables).',
        render_ui_await:
          'openchamber_render with ui (openui-lang) and awaitAnswer: true for a direction-setting choice, scope decision, or trade-off where the user may add condition notes.',
        reply_decision_cards:
          'Inline openui-lang block in the reply with one stacked Card and action Buttons per item to collect decisions across multiple separate items.',
        reply_ui_block:
          'Inline fenced openui-lang block in the reply for structured data, comparisons, charts, tables, stats, or step flows.',
      },
    },
    archetype: {
      type: 'choice',
      instructions:
        'If a visual or interactive component is warranted, which primary composition fits best?',
      criteria: {
        bar_plus_table:
          'Ranked or grouped BarChart paired with a companion detail Table across categories.',
        choice_form:
          'Interactive Choice / Input / Slider / Button controls for collecting user direction.',
        custom_html:
          'Custom HTML/CSS/SVG visual mockup or diagram.',
        line_plus_stats:
          'LineChart over time or ordered steps paired with summary Stat tiles.',
        none:
          'No visual widget needed.',
        share_whole_bar:
          'BarChart with whole=true showing parts adding up to 100% / a total.',
        stat_summary:
          'Compact Row of Stat tiles with KeyValue or Progress bars.',
        steps_flow:
          'Steps flow joined by arrows showing stages, status, or request routing.',
      },
    },
  };
}

const ARCHETYPE_HINTS: Readonly<Record<UiVisualArchetype, string>> = {
  none: '',
  bar_plus_table:
    'Prefer `BarChart` paired with a `Table` inside `Stack([...])` (never leave a numeric comparison table without a visual companion).',
  share_whole_bar:
    'Prefer `BarChart(labels, [Series(...)], unit, true)` (`whole = true`) paired with `Stat` or `Table` for part-of-whole shares.',
  line_plus_stats:
    'Prefer `Row([Stat(...), ...])` above `LineChart` inside `Stack([...])` for trends over time/sequence.',
  steps_flow:
    'Prefer `Steps([...], "column")` (mobile-safe) paired with compact `Stat` or `Callout` nodes for flows and lifecycles.',
  stat_summary:
    'Prefer `Row([Stat(...), ...])` with `Progress` or `KeyValue` stacked directly under `Stack([...])`.',
  choice_form:
    'Use concise `Choice` options with descriptions where needed; keep `Card` titles and `Badge` labels to 1-2 words for 360px mobile screens.',
  custom_html:
    'Use `openchamber_render` with `html` for visual mockups/drawings only (never for charts or tables).',
};

const SURFACE_DIRECTIVES: Readonly<Record<Exclude<UiSurfaceChoice, 'plain_reply'>, string>> = {
  reply_ui_block:
    'Render quantitative comparisons, metrics, or multi-stage structure in a fenced ```openui-lang block (`root = Stack([...])`). You can either stream raw output/tables/metrics/steps directly into `AutoVisual(content, intent)` (which uses Gemini Decision 1 to draw an inline visual or keep text verbatim) or compose explicit `BarChart`/`LineChart`/`Steps`/`Stat`/`Table` nodes.',
  reply_decision_cards:
    'Present multi-item decisions as an inline ```openui-lang block with stacked `Card`s (`root = Stack([...])`), short 1-2 word titles/Badges, and adjacent `Button(label, variant, cardTitle)` controls.',
  render_ui_await:
    'If asking the user to choose scope, architecture, or trade-offs, call `openchamber_render` with `ui` (`openui-lang`) and `awaitAnswer: true` (never `question`) so the user can attach conditions in `data.note`.',
  render_html_mockup:
    'Use `openchamber_render` with `html` for the visual interface mockup or custom SVG drawing, leaving `html`/`body` backgroundless unless mocking up a standalone themed app.',
  question_tool:
    'If a quick closed-set clarification is required before acting, use `question`; if it sets project direction/trade-offs, upgrade to `openchamber_render(ui, awaitAnswer: true)`.',
};

export function interpretSurfaceRoute(
  batch: Awaited<ReturnType<DecisionBridgeClient['evaluate']>>,
  config: DecisionUiConfig,
): SurfaceRouteDecision {
  if (!batch.ok) {
    return {
      needsUiProbability: 0.5,
      surface: 'plain_reply',
      surfaceConfidence: 0,
      archetype: 'none',
      archetypeConfidence: 0,
      action: 'noop',
      directiveText: null,
      ms: batch.ms,
    };
  }

  const needsUi = getNoulAnswer(batch, 'needs_ui', 0.5);
  const surfaceAns = getChoiceAnswer(batch, 'surface', ALLOWED_UI_SURFACES, 'plain_reply');
  const archetypeAns = getChoiceAnswer(batch, 'archetype', ALLOWED_VISUAL_ARCHETYPES, 'none');

  if (
    needsUi.probability >= config.injectDirectiveMinProbability &&
    surfaceAns.choice !== 'plain_reply' &&
    surfaceAns.confidence >= config.minChoiceConfidence
  ) {
    const baseDirective = SURFACE_DIRECTIVES[surfaceAns.choice];
    const archetypeHint =
      archetypeAns.choice !== 'none' && archetypeAns.confidence >= 0.4
        ? ` ${ARCHETYPE_HINTS[archetypeAns.choice]}`
        : '';
    // Deterministic string (no floating-point probability attribute) so multi-step tool loops cache cleanly
    const directiveText = `<decision_ui_route surface="${surfaceAns.choice}" archetype="${archetypeAns.choice}">\n${baseDirective}${archetypeHint}\n</decision_ui_route>`;
    return {
      needsUiProbability: needsUi.probability,
      surface: surfaceAns.choice,
      surfaceConfidence: surfaceAns.confidence,
      archetype: archetypeAns.choice,
      archetypeConfidence: archetypeAns.confidence,
      action: 'inject_user_tail',
      directiveText,
      ms: batch.ms,
    };
  }

  return {
    needsUiProbability: needsUi.probability,
    surface: surfaceAns.choice,
    surfaceConfidence: surfaceAns.confidence,
    archetype: archetypeAns.choice,
    archetypeConfidence: archetypeAns.confidence,
    action: 'noop',
    directiveText: null,
    ms: batch.ms,
  };
}

export async function evaluateSurfaceRoute(params: {
  readonly client: DecisionBridgeClient;
  readonly config: DecisionUiConfig;
  readonly latestUserText: string;
  readonly recentHistory?: string;
  readonly timeoutMs?: number;
}): Promise<SurfaceRouteDecision> {
  const trimmed = params.latestUserText.trim();
  if (!trimmed) {
    return {
      needsUiProbability: 0,
      surface: 'plain_reply',
      surfaceConfidence: 1,
      archetype: 'none',
      archetypeConfidence: 1,
      action: 'noop',
      directiveText: null,
      ms: 0,
    };
  }

  const inputParts = [
    ...(params.recentHistory?.trim()
      ? [`Recent conversation context:\n${params.recentHistory.trim().slice(-2000)}`]
      : []),
    `Latest user request:\n${trimmed.slice(0, 4000)}`,
  ].join('\n\n');

  const batch = await params.client.evaluate({
    input: inputParts,
    questions: buildSurfaceRouterQuestions(),
    timeoutMs: params.timeoutMs ?? 1500,
  });

  return interpretSurfaceRoute(batch, params.config);
}

export interface RoutableMessagePart {
  readonly type?: string;
  readonly text?: string;
}

export interface RoutableMessage {
  readonly role?: string;
  readonly content?: string | ReadonlyArray<RoutableMessagePart>;
}

/**
 * Pure, prefix-cache-safe transformation over `SessionContext.messages`:
 * - NEVER mutates `draft.system` or earlier conversation turns (preserving 100% of KV prefix cache).
 * - When `decision.action === 'inject_user_tail'`, appends a deterministic `<decision_ui_route>`
 *   text part onto the latest `role === 'user'` message idempotently.
 */
export function applySurfaceRouteToMessages<T extends RoutableMessage>(
  messages: ReadonlyArray<T>,
  decision: SurfaceRouteDecision,
): T[] {
  if (decision.action !== 'inject_user_tail' || !decision.directiveText) {
    return [...messages];
  }

  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    return [...messages];
  }

  const target = messages[lastUserIdx]!;
  if (typeof target.content === 'string') {
    if (target.content.includes('<decision_ui_route ')) {
      return [...messages];
    }
    const updated: T = {
      ...target,
      content: `${target.content}\n\n${decision.directiveText}`,
    };
    return [
      ...messages.slice(0, lastUserIdx),
      updated,
      ...messages.slice(lastUserIdx + 1),
    ];
  }

  if (Array.isArray(target.content)) {
    const alreadyPresent = target.content.some(
      (part) => typeof part?.text === 'string' && part.text.includes('<decision_ui_route '),
    );
    if (alreadyPresent) {
      return [...messages];
    }
    const updated: T = {
      ...target,
      content: [
        ...target.content,
        { type: 'text', text: decision.directiveText },
      ],
    };
    return [
      ...messages.slice(0, lastUserIdx),
      updated,
      ...messages.slice(lastUserIdx + 1),
    ];
  }

  return [...messages];
}
