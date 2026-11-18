import {
  getChoiceAnswer,
  getNoulAnswer,
  getScoreAnswer,
  type DecisionBridgeClient,
} from './client.ts';
import type {
  DecisionContentBlock,
  DecisionQuestion,
  DecisionUiConfig,
  RenderGateFinding,
  ViewportScreenshot,
  VisualCriticResult,
} from './types.ts';

const VISUAL_DEFECT_CHOICES = [
  'blank_or_script_error',
  'horizontal_overflow',
  'low_theme_contrast',
  'none',
  'outer_card_border_chrome',
  'text_or_svg_collision',
] as const;

export function buildVisualCriticQuestions(): Readonly<Record<string, DecisionQuestion>> {
  return {
    has_clipping: {
      type: 'noul',
      instructions:
        'Looking at both the 360px phone viewport (first image) and 720px desktop viewport (second image), is there visible text/SVG label collision, clipped content, overlapping boxes, or horizontal truncation?',
      criteria: {
        true_description:
          'Labels overlap, boxes or SVG graphics clip at the viewport edge, or controls collide.',
        false_description:
          'All text, diagrams, and controls fit cleanly inside both 360px and 720px viewports without overlap or clipping.',
      },
    },
    is_blank: {
      type: 'noul',
      instructions:
        'Does either rendered viewport appear blank, visually empty, or broken (missing intended drawing/UI)?',
      criteria: {
        true_description: 'Canvas/page is blank, nearly empty, or shows broken/unrendered output.',
        false_description: 'The intended interface or drawing is clearly visible and populated.',
      },
    },
    mobile_fit: {
      type: 'score',
      instructions:
        'Rate how cleanly the layout adapts to the 360px mobile viewport (first image).',
      criteria: [
        'Broken on mobile: severe horizontal cutoff, crushed columns, or unreadable overlapping text.',
        'Cramped on mobile: squeezed multi-column layout or minor edge clipping.',
        'Acceptable mobile fit: readable and usable with minor spacing compromises.',
        'Clean responsive fit: stacks or wraps naturally at 360px with balanced spacing.',
      ],
    },
    contrast_legibility: {
      type: 'score',
      instructions:
        'Rate text and graphic contrast/legibility against the dark OpenChamber background.',
      criteria: [
        'Illegible: dark-on-dark or light-on-light text that cannot be read.',
        'Poor contrast: key labels or diagram lines are washed out or hard to read.',
        'Readable: clear contrast across primary and secondary elements.',
        'Crisp hierarchy: strong contrast, clear tone separation, and clean typography.',
      ],
    },
    primary_defect: {
      type: 'choice',
      instructions:
        'Identify the single most significant visual issue across the 360px and 720px renders, or "none" if clean.',
      criteria: {
        blank_or_script_error: 'Empty/blank frame or failed canvas/SVG render.',
        horizontal_overflow:
          'Fixed-width layout or wide row overflowing past the 360px or 720px column.',
        low_theme_contrast:
          'Unreadable dark-on-dark or low-contrast text/strokes due to missing theme colors.',
        none: 'Clean render with good contrast, legibility, and 360px/720px fit.',
        outer_card_border_chrome:
          'Unwanted outer wrapper card border/banner header fighting OpenChamber chat framing.',
        text_or_svg_collision:
          'Overlapping SVG labels, clipped diagram elements, or colliding controls.',
      },
    },
  };
}

export async function evaluateVisualCritic(params: {
  readonly viewports: ReadonlyArray<ViewportScreenshot>;
  readonly htmlSource: string;
  readonly title?: string;
  readonly client: DecisionBridgeClient;
  readonly config: DecisionUiConfig;
  readonly includeDataUrls?: boolean;
  readonly timeoutMs?: number;
}): Promise<VisualCriticResult> {
  const started = Date.now();
  const findings: RenderGateFinding[] = [];

  // 1. Deterministic DOM & runtime checks (0 ML uncertainty)
  for (const vp of params.viewports) {
    if (vp.pageErrors.length > 0) {
      findings.push({
        source: 'dom',
        severity: 'error',
        code: `js_error_${vp.width}px`,
        message: `Uncaught runtime error at ${vp.width}px: ${vp.pageErrors[0]}`,
      });
    }
    if (vp.isCollapsedOrEmpty) {
      findings.push({
        source: 'dom',
        severity: 'error',
        code: `empty_render_${vp.width}px`,
        message: `Rendered page at ${vp.width}px has zero visible content or collapsed height (${vp.scrollHeight}px).`,
      });
    } else if (vp.hasHorizontalOverflow) {
      findings.push({
        source: 'dom',
        severity: 'warning',
        code: `horizontal_overflow_${vp.width}px`,
        message: `Horizontal overflow at ${vp.width}px viewport: scrollWidth=${vp.scrollWidth}px exceeds clientWidth=${vp.clientWidth}px. Stack or wrap elements for 360px phone fit.`,
      });
    }
  }

  // 2. Multimodal Gemini Decisions API check (`image` + `text` in a single forward pass)
  const blocks: DecisionContentBlock[] = [];
  for (const vp of params.viewports) {
    if (vp.pngBase64) {
      blocks.push({
        type: 'image',
        mime_type: 'image/png',
        data: vp.pngBase64,
        resolution: 'medium',
      });
    }
  }

  const domSummary = params.viewports
    .map(
      (vp, idx) =>
        `Image ${idx + 1}: viewport=${vp.width}x${vp.height}px, scrollWidth=${vp.scrollWidth}px, scrollHeight=${vp.scrollHeight}px, overflow=${vp.hasHorizontalOverflow}, jsErrors=${JSON.stringify(vp.pageErrors)}`,
    )
    .join('\n');

  blocks.push({
    type: 'text',
    text: [
      params.title ? `Rendered HTML Title: ${params.title}` : 'Rendered OpenChamber HTML Page',
      domSummary,
      `HTML Excerpt:\n${params.htmlSource.slice(0, 3000)}`,
    ].join('\n\n'),
  });

  const batch = await params.client.evaluate({
    input: blocks,
    questions: buildVisualCriticQuestions(),
    timeoutMs: params.timeoutMs ?? 4500,
  });

  const ms = Date.now() - started;

  if (!batch.ok) {
    return {
      evaluated: false,
      ms,
      clippingProbability: 0,
      blankOrBrokenProbability: 0,
      mobileFitScore: 3,
      contrastScore: 3,
      primaryDefect: 'none',
      primaryDefectConfidence: 0,
      viewports: params.viewports.map((vp) => ({
        width: vp.width,
        scrollWidth: vp.scrollWidth,
        scrollHeight: vp.scrollHeight,
        hasHorizontalOverflow: vp.hasHorizontalOverflow,
        pageErrors: vp.pageErrors,
        ...(params.includeDataUrls && vp.pngBase64
          ? { pngDataUrl: `data:image/png;base64,${vp.pngBase64}` }
          : {}),
      })),
      findings,
    };
  }

  const clipping = getNoulAnswer(batch, 'has_clipping', 0);
  const blank = getNoulAnswer(batch, 'is_blank', 0);
  const mobileFit = getScoreAnswer(batch, 'mobile_fit', 3);
  const contrast = getScoreAnswer(batch, 'contrast_legibility', 3);
  const defect = getChoiceAnswer(batch, 'primary_defect', VISUAL_DEFECT_CHOICES, 'none');

  const threshold = params.config.advisoryThreshold;

  if (blank.probability >= threshold) {
    findings.push({
      source: 'visual_critic',
      severity: 'error',
      code: 'visual_blank_or_broken',
      probability: blank.probability,
      message: `Multimodal Visual Critic flagged blank/broken render (p=${blank.probability.toFixed(2)}). Check script initialization, SVG viewBox/height, and theme colors.`,
    });
  }

  if (clipping.probability >= threshold) {
    findings.push({
      source: 'visual_critic',
      severity: 'warning',
      code: 'visual_clipping_or_overlap',
      probability: clipping.probability,
      message: `Multimodal Visual Critic detected text/SVG collision or clipping across 360px/720px renders (p=${clipping.probability.toFixed(2)}, primary=${defect.choice}).`,
    });
  }

  if (mobileFit.score < 1.55) {
    findings.push({
      source: 'visual_critic',
      severity: 'warning',
      code: 'poor_mobile_360_fit',
      message: `360px phone layout scored ${mobileFit.score.toFixed(2)}/3.00: stack multi-column boxes vertically on narrow viewports.`,
    });
  }

  if (contrast.score < 1.55) {
    findings.push({
      source: 'visual_critic',
      severity: 'warning',
      code: 'low_contrast_legibility',
      message: `Contrast/legibility scored ${contrast.score.toFixed(2)}/3.00 against dark theme: ensure custom surfaces set explicit foreground colors or use var(--foreground) / var(--muted-foreground).`,
    });
  }

  return {
    evaluated: true,
    ms,
    clippingProbability: clipping.probability,
    blankOrBrokenProbability: blank.probability,
    mobileFitScore: mobileFit.score,
    contrastScore: contrast.score,
    primaryDefect: defect.choice,
    primaryDefectConfidence: defect.confidence,
    viewports: params.viewports.map((vp) => ({
      width: vp.width,
      scrollWidth: vp.scrollWidth,
      scrollHeight: vp.scrollHeight,
      hasHorizontalOverflow: vp.hasHorizontalOverflow,
      pageErrors: vp.pageErrors,
      ...(params.includeDataUrls && vp.pngBase64
        ? { pngDataUrl: `data:image/png;base64,${vp.pngBase64}` }
        : {}),
    })),
    findings,
  };
}
