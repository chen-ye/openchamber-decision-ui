# Decision UI extension for OpenChamber

Guides OpenChamber and OpenCode toward the best visual or interactive response surface, renders inline `AutoVisual` blocks, compiles text or tables into `openui-lang`, and audits rendered UI with policy lints and 360px/720px headless browser checks.

## Setup

### Prerequisites

- **OpenChamber** `>= 2.7.0`
- **Gemini Decisions Bridge** running on `http://127.0.0.1:4006` (install and enable the `gemini-decisions-bridge` extension)
- **Optional headless Chrome/Chromium** (for 360px/720px visual audits of HTML renders): automatically discovers Playwright `chrome-headless-shell` or `chromium` under `~/.cache/ms-playwright`, system `google-chrome` or `chromium` binaries, or the path in `DECISION_UI_CHROME_BIN`

### Enable in OpenChamber

1. Open **Settings → Extensions** in OpenChamber.
2. Add or enable **Decision UI** and approve its service permissions (including `chrome-headless-shell` or `google-chrome` if using the 360px/720px Visual Critic).

### Configuration

Settings are stored in `~/.config/openchamber/decision-ui.json` (override the file path with `DECISION_UI_CONFIG_PATH`) and can also be toggled from the **Live Status** tab or **Work Status**:

| Key | Default | What it controls |
|---|---|---|
| `bridgeUrl` | `http://127.0.0.1:4006` | Local Gemini Decisions Bridge URL |
| `model` | `gemini-decision-1` | Decision model ID |
| `surfaceRouterEnabled` | `true` | Evaluate each user turn and add a surface hint when visual/interactive UI helps |
| `renderGateEnabled` | `true` | Run `openui-lang` AST checks and render policy advisories after `openchamber_render` and `question` |
| `visualCriticEnabled` | `true` | Capture 360px/720px screenshots of HTML renders and score mobile fit, clipping, and contrast |
| `turnEndDetectorEnabled` | `true` | Flag finished replies that contain dense unvisualized numeric data |
| `injectDirectiveMinProbability` | `0.65` | Minimum `needs_ui` probability before appending a surface hint |
| `minChoiceConfidence` | `0.48` | Minimum choice confidence required to emit a specific surface hint |
| `advisoryThreshold` | `0.65` | Minimum probability before Render Gate or Visual Critic attaches an advisory note |

## Using Decision UI in OpenChamber

### Decision UI panel

- **Header**: Shows the bridge status badge (`gemini-decision-1 · :4006` or `Bridge offline`) and **Refresh**.
- **Stitch Compiler tab**: Choose a sample dataset or paste prose, CLI output, checklists, Markdown tables, CSV, or JSON; apply quick-edit chips (**Verbatim**, **Ranked Bar**, **Whole Share**, **Line Trend**, **Progress Bars**, **Hide Table**) or a custom edit instruction; click **Compile UI Block** (or **Evaluate & Render**); and use **Copy Fence** or **Insert in Chat** to place the resulting `openui-lang` block into the composer.
- **Critic & Gate tab**: Select an inspection preset or paste HTML or `openui-lang` source, then click **Audit & Capture 360px / 720px** to view AST/policy findings, overflow diagnostics, and 360px mobile and 720px desktop screenshots.
- **Live Status tab**: View counts for **Surface Routes**, **Tail Nudges**, **Stitch Compiles**, and **Gate / Critic**, toggle the four guards and detectors on or off, and review recent decision events.

### Message and selection actions

- **Message (`Visualize with Decisions`)**: Available on user and assistant messages; opens the **Stitch Compiler** tab with the message text and compiles it.
- **Selection (`Compile to UI block`)**: Available on selected text; opens the **Stitch Compiler** tab with the selection and compiles it.

### Inline `AutoVisual(content, intent)` block

Agents can emit `AutoVisual(content, intent)` inside a ```` ```openui-lang ```` fence. Decision UI evaluates the content via `gemini-decision-1` and renders a chart (with hero stats and optional detail table), a key-value/gauge grid, a step flow, or formatted Markdown verbatim—with inline pills (**Verbatim**, **Bar**, **Share**, **Line**, **Progress**, **Stats/KV**, **Steps**) to switch views in place.

### Work Status panel

The **Decision UI** section in Work Status shows:

- **Decisions Bridge**: `gemini-decision-1 (:4006)` or `offline (:4006)`
- **Surface Router**: Turned/nudged counts with a **Pause** / **Enable** button
- **Stitch Compiler**: Compiled block count
- **Render Gate & Critic**: Check/advisory counts with a **Critic On** / **Critic Off** button
- **Latest event** summary (or config file path)

### Automatic routing, compile tool, and quality checks

- **Surface routing**: Evaluates each user turn before sending and, when `needs_ui >= 0.65`, appends a short surface hint to the latest user message without modifying the system prompt.
- **`decision_ui_compile` tool**: Available to OpenCode agents to evaluate arbitrary text or data and compile it into an `openui-lang` fence or keep it verbatim.
- **Post-render checks & turn-end detector**: Runs static `openui-lang` AST checks, policy rules, and 360px/720px headless browser audits after `openchamber_render` and `question` tool calls, attaching non-blocking advisory notes when defects are found, and flags finished turns with unvisualized numeric prose.

### How the pieces fit together

```text
  User turn ──▶ Surface Router ──▶ Agent reply (AutoVisual / openui-lang / HTML)
                      │                         │
                      ▼                         ▼
            gemini-decisions-bridge      Render Gate & 360/720 Critic
               (127.0.0.1:4006)                 │
                      ▲                         ▼
                      └─────── Decision UI panel & Work Status
```

## Development

```bash
bun run build
bun run check
bun run typecheck
bun test
```
