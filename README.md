# Decision UI (`decision-ui`)

OpenChamber extension wiring Google's **Gemini Decisions API (`gemini-decision-1`)** (via local `gemini-decisions-bridge` on `127.0.0.1:4006`) into OpenChamber's `openui-lang` and `openchamber_render` stack.

## Four Integrated Capabilities

1. **Cache-Safe Surface Router** ([index.ts](./plugin/src/index.ts#L228-L282) -> `ctx.session.hook("context")`):
   - Evaluates `needs_ui` (`noul`), `surface` (`choice`), and `archetype` (`choice`) in a single prefill forward pass per user turn.
   - Leaves `draft.system` 100% untouched to preserve KV prefix caching across the conversation, and appends a deterministic `<decision_ui_route>` tail hint onto the latest user message only when `needs_ui >= 0.65`.
2. **Arbitrary-Output `AutoVisual(content, intent)` Chat Block & Compiler** ([auto-block.ts](./src/core/auto-block.ts#L1-L785), [visual.ts](./blocks/visual.ts#L1-L590), [ui-compiler.ts](./src/core/ui-compiler.ts#L1-L540)):
   - Registered under `contributes.blocks` (`AutoVisual(content, intent)` -> `blocks/visual.html`) so agents stream **arbitrary output** (prose, code, CLI tables like `df -h`, bulleted metrics with surrounding commentary, numbered checklists, KV health dumps, CSV, Markdown tables, or JSON) inline in one turn.
   - Evaluates a single `:4006` forward pass (`should_visualize` `noul` + `visual_family` `choice` + column/chart questions, `0` output tokens): renders a tailored visual (`chart`, `stats_kv`, `steps_flow`) while preserving surrounding takeaway prose, **or** repeats `content` **verbatim** as formatted Markdown when a widget would add noise.
   - Includes inline 1-tap Stitch switcher pills (`Verbatim | Bar | Share | Line | Progress | Steps | Stats/KV`) inside the rendered chat block.
3. **Advisory Render Gate & Turn-End Detector** ([ast-linter.ts](./src/core/ast-linter.ts#L1-L390), [render-gate.ts](./src/core/render-gate.ts#L1-L320)):
   - Combines `<1 ms` static `openui-lang` AST linting (named-arg detection, nesting rules, 360px mobile `Row` squeeze, long `Card` header `Badge` starvation, Tufte numeric-`Table` visual companion rule) with semantic policy checks (`Never for data` in HTML, `question` vs `openchamber_render(ui, awaitAnswer: true)`).
   - Appends non-blocking advisory notes to `openchamber_render` (`data.note`) and `question` results in `ctx.tool.hook("execute.after")`.
   - Listens to `sessionEvents: ["turn-finished"]` to flag dense unvisualized numeric prose.
4. **Multimodal 360px / 720px Visual Critic** ([headless-capture.ts](./src/node/headless-capture.ts#L1-L400), [visual-critic.ts](./src/core/visual-critic.ts#L1-L215)):
   - Captures `360px` (phone) and `720px` (desktop reply column) renders of `openchamber_render({ html })` via warm headless Chromium CDP with OpenChamber's dark-theme CSS variables.
   - Scores both PNGs + DOM overflow/runtime error metrics in one ~200 ms `gemini-decision-1` multimodal pass (`has_clipping`, `is_blank`, `mobile_fit`, `contrast_legibility`, `primary_defect`).

## Commands

```bash
bun run typecheck
bun run build
bun run check
bun test
```
