/**
 * Shared immutable domain models for Decision UI:
 * - Google Gemini Decisions API (`POST /v1beta/decisions`) & SystemOne (`POST /v1/systemone`) wire schemas
 * - Surface Router, Stitch-style Data-to-openui-lang Compiler, Hybrid Render Gate, and Multimodal Visual Critic contracts
 * - Runtime configuration & bounded ring-buffer telemetry
 */

export type MediaResolution = 'low' | 'medium' | 'high' | 'ultra_high';

export type DecisionContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image' | 'audio' | 'video' | 'document';
      readonly mime_type: string;
      readonly data?: string;
      readonly uri?: string;
      readonly resolution?: MediaResolution;
    };

export type DecisionQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria?: {
        readonly true_description?: string;
        readonly false_description?: string;
      };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'score';
      readonly instructions: string;
      readonly criteria: ReadonlyArray<string>;
    };

export interface GoogleDecisionsRequest {
  readonly model: string;
  readonly input: string | ReadonlyArray<DecisionContentBlock>;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface NoulAnswer {
  readonly type?: 'noul';
  readonly noul: number;
  readonly confidence: number;
}

export interface ChoiceAnswer {
  readonly type?: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type?: 'score';
  readonly score: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly legend?: Readonly<Record<string, string>>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionBatchResult {
  readonly ok: boolean;
  readonly ms: number;
  readonly model: string;
  readonly inputTokens: number;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly error?: string;
}

export interface DecisionUiConfig {
  readonly bridgeUrl: string;
  readonly model: string;
  readonly loopbackPort: number;
  readonly surfaceRouterEnabled: boolean;
  readonly renderGateEnabled: boolean;
  readonly visualCriticEnabled: boolean;
  readonly turnEndDetectorEnabled: boolean;
  /** Append cache-safe <decision_ui_route> tail hint on latest user message at or above this needs_ui probability. */
  readonly injectDirectiveMinProbability: number;
  /** Minimum choice confidence required to emit a specific surface directive. */
  readonly minChoiceConfidence: number;
  /** Minimum noul probability before Render Gate or Visual Critic appends an advisory note. */
  readonly advisoryThreshold: number;
}

export const DEFAULT_DECISION_UI_CONFIG: DecisionUiConfig = {
  bridgeUrl: 'http://127.0.0.1:4006',
  model: 'gemini-decision-1',
  loopbackPort: 4007,
  surfaceRouterEnabled: true,
  renderGateEnabled: true,
  visualCriticEnabled: true,
  turnEndDetectorEnabled: true,
  injectDirectiveMinProbability: 0.65,
  minChoiceConfidence: 0.48,
  advisoryThreshold: 0.65,
};

export type UiSurfaceChoice =
  | 'plain_reply'
  | 'reply_ui_block'
  | 'reply_decision_cards'
  | 'render_ui_await'
  | 'render_html_mockup'
  | 'question_tool';

export type UiVisualArchetype =
  | 'none'
  | 'bar_plus_table'
  | 'share_whole_bar'
  | 'line_plus_stats'
  | 'steps_flow'
  | 'stat_summary'
  | 'choice_form'
  | 'custom_html';

export interface SurfaceRouteDecision {
  readonly needsUiProbability: number;
  readonly surface: UiSurfaceChoice;
  readonly surfaceConfidence: number;
  readonly archetype: UiVisualArchetype;
  readonly archetypeConfidence: number;
  readonly action: 'inject_user_tail' | 'noop';
  readonly directiveText: string | null;
  readonly ms: number;
}

export type AstLintSeverity = 'error' | 'warning';

export interface AstLintIssue {
  readonly code:
    | 'empty_program'
    | 'missing_root_stack'
    | 'syntax_error'
    | 'named_argument'
    | 'unknown_component'
    | 'unreachable_binding'
    | 'undefined_reference'
    | 'invalid_nesting'
    | 'mobile_row_squeeze'
    | 'long_card_badge'
    | 'tufte_table_without_visual';
  readonly severity: AstLintSeverity;
  readonly line?: number;
  readonly message: string;
}

export interface AstLintReport {
  readonly valid: boolean;
  readonly componentCounts: Readonly<Record<string, number>>;
  readonly issues: ReadonlyArray<AstLintIssue>;
}

export type CompilerChartKind =
  | 'bar_ranked'
  | 'bar_whole_share'
  | 'line_trend'
  | 'progress_bars'
  | 'stat_tiles_only';

export type CompilerColumnRole =
  | 'primary_series'
  | 'secondary_series'
  | 'hero_stat'
  | 'table_only'
  | 'omit';

export type CompilerSortOrder = 'preserve' | 'desc_primary' | 'asc_primary';

export interface ColumnProfile {
  readonly index: number;
  readonly name: string;
  readonly safeKey: string;
  readonly kind: 'string' | 'number' | 'temporal';
  readonly unit?: string;
  readonly sampleValues: ReadonlyArray<string | number>;
  readonly numericCount: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly sum: number | null;
  readonly mean: number | null;
  readonly looksLikePercentageShare: boolean;
}

export interface StructuredDataset {
  readonly title?: string;
  readonly sourceKind: 'json_records' | 'json_table' | 'markdown_table' | 'csv' | 'openui_block';
  readonly columns: ReadonlyArray<ColumnProfile>;
  readonly rows: ReadonlyArray<ReadonlyArray<string | number | null>>;
}

export interface CompilerPlan {
  readonly chartKind: CompilerChartKind;
  readonly chartConfidence: number;
  readonly includeTable: boolean;
  readonly includeStats: boolean;
  readonly sortOrder: CompilerSortOrder;
  readonly labelColumnIndex: number;
  readonly columnRoles: Readonly<Record<number, CompilerColumnRole>>;
  readonly ms: number;
  readonly questionCount: number;
  readonly usedFallbackHeuristics: boolean;
}

export interface CompileUiResult {
  readonly ok: boolean;
  readonly source: string;
  readonly fencedMarkdown: string;
  readonly dataset: StructuredDataset;
  readonly plan: CompilerPlan;
  readonly lint: AstLintReport;
}

export interface RenderGateFinding {
  readonly source: 'ast' | 'decision' | 'visual_critic' | 'dom';
  readonly severity: 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly probability?: number;
}

export interface ViewportScreenshot {
  readonly width: number;
  readonly height: number;
  readonly pngBase64: string;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly clientWidth: number;
  readonly hasHorizontalOverflow: boolean;
  readonly isCollapsedOrEmpty: boolean;
  readonly pageErrors: ReadonlyArray<string>;
}

export interface VisualCriticResult {
  readonly evaluated: boolean;
  readonly ms: number;
  readonly clippingProbability: number;
  readonly blankOrBrokenProbability: number;
  readonly mobileFitScore: number; // 0..3
  readonly contrastScore: number; // 0..3
  readonly primaryDefect: string;
  readonly primaryDefectConfidence: number;
  readonly viewports: ReadonlyArray<{
    readonly width: number;
    readonly scrollWidth: number;
    readonly scrollHeight: number;
    readonly hasHorizontalOverflow: boolean;
    readonly pageErrors: ReadonlyArray<string>;
    readonly pngDataUrl?: string;
  }>;
  readonly findings: ReadonlyArray<RenderGateFinding>;
}

export interface RenderGateResult {
  readonly targetTool: 'openchamber_render' | 'question';
  readonly mode: 'ui' | 'html' | 'question';
  readonly clean: boolean;
  readonly ms: number;
  readonly findings: ReadonlyArray<RenderGateFinding>;
  readonly advisoryNote: string | null;
  readonly astLint?: AstLintReport;
  readonly visualCritic?: VisualCriticResult;
}

export interface TelemetryEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly kind: 'surface_route' | 'ui_compile' | 'render_gate' | 'visual_critic' | 'missed_visual';
  readonly summary: string;
  readonly ms: number;
  readonly clean?: boolean;
  readonly sessionId?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface DecisionUiStatusSnapshot {
  readonly bridgeHealthy: boolean;
  readonly bridgeUrl: string;
  readonly loopbackPort: number;
  readonly config: DecisionUiConfig;
  readonly counters: {
    readonly surfaceRoutes: number;
    readonly directedSurfaceTurns: number;
    readonly uiCompiles: number;
    readonly renderGates: number;
    readonly renderAdvisories: number;
    readonly visualCritics: number;
    readonly missedVisuals: number;
  };
  readonly recent: ReadonlyArray<TelemetryEntry>;
}
