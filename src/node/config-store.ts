import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DECISION_UI_CONFIG, type DecisionUiConfig } from '../core/types.ts';

export function expandTildePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

export function renderTildePath(absPath: string): string {
  const home = os.homedir();
  if (absPath === home) return '~';
  if (absPath.startsWith(`${home}/`)) return `~/${absPath.slice(home.length + 1)}`;
  return absPath;
}

export function resolveConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DECISION_UI_CONFIG_PATH?.trim();
  if (override) return expandTildePath(override);
  return path.join(os.homedir(), '.config', 'openchamber', 'decision-ui.json');
}

function clampProb(val: unknown, fallback: number): number {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.min(0.99, Math.max(0.01, n));
}

export function parseDecisionUiConfig(raw: unknown): DecisionUiConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_DECISION_UI_CONFIG;
  }
  const rec = raw as Record<string, unknown>;
  return {
    bridgeUrl:
      typeof rec.bridgeUrl === 'string' && rec.bridgeUrl.trim().length > 0
        ? rec.bridgeUrl.trim().replace(/\/+$/, '')
        : DEFAULT_DECISION_UI_CONFIG.bridgeUrl,
    model:
      typeof rec.model === 'string' && rec.model.trim().length > 0
        ? rec.model.trim()
        : DEFAULT_DECISION_UI_CONFIG.model,
    loopbackPort:
      typeof rec.loopbackPort === 'number' && Number.isInteger(rec.loopbackPort) && rec.loopbackPort >= 0
        ? rec.loopbackPort
        : DEFAULT_DECISION_UI_CONFIG.loopbackPort,
    surfaceRouterEnabled:
      typeof rec.surfaceRouterEnabled === 'boolean'
        ? rec.surfaceRouterEnabled
        : DEFAULT_DECISION_UI_CONFIG.surfaceRouterEnabled,
    renderGateEnabled:
      typeof rec.renderGateEnabled === 'boolean'
        ? rec.renderGateEnabled
        : DEFAULT_DECISION_UI_CONFIG.renderGateEnabled,
    visualCriticEnabled:
      typeof rec.visualCriticEnabled === 'boolean'
        ? rec.visualCriticEnabled
        : DEFAULT_DECISION_UI_CONFIG.visualCriticEnabled,
    turnEndDetectorEnabled:
      typeof rec.turnEndDetectorEnabled === 'boolean'
        ? rec.turnEndDetectorEnabled
        : DEFAULT_DECISION_UI_CONFIG.turnEndDetectorEnabled,
    injectDirectiveMinProbability: clampProb(
      rec.injectDirectiveMinProbability,
      DEFAULT_DECISION_UI_CONFIG.injectDirectiveMinProbability,
    ),
    minChoiceConfidence: clampProb(
      rec.minChoiceConfidence,
      DEFAULT_DECISION_UI_CONFIG.minChoiceConfidence,
    ),
    advisoryThreshold: clampProb(
      rec.advisoryThreshold,
      DEFAULT_DECISION_UI_CONFIG.advisoryThreshold,
    ),
  };
}

export function loadDecisionUiConfig(env: NodeJS.ProcessEnv = process.env): DecisionUiConfig {
  const filePath = resolveConfigFilePath(env);
  try {
    if (!fs.existsSync(filePath)) return DEFAULT_DECISION_UI_CONFIG;
    const content = fs.readFileSync(filePath, 'utf8');
    return parseDecisionUiConfig(JSON.parse(content));
  } catch {
    return DEFAULT_DECISION_UI_CONFIG;
  }
}

export function saveDecisionUiConfig(
  patch: Partial<DecisionUiConfig>,
  env: NodeJS.ProcessEnv = process.env,
): DecisionUiConfig {
  const current = loadDecisionUiConfig(env);
  const next = parseDecisionUiConfig({ ...current, ...patch });
  const filePath = resolveConfigFilePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
