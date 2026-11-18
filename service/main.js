// service/server.ts
import crypto from "node:crypto";
import http from "node:http";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_PATH = "/session-events";
var SESSION_EVENTS_WIRE_VERSION = 1;
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
var isGuestSessionEventType = (value) => EVENT_TYPES.has(value);
var readSessionEventRequest = (body) => {
  let wire;
  try {
    const parsed = JSON.parse(body);
    if (Object(parsed) !== parsed || parsed === null)
      return null;
    wire = parsed;
  } catch {
    return null;
  }
  const { v, requestId, event, content } = wire;
  if (v !== SESSION_EVENTS_WIRE_VERSION)
    return null;
  if (String(requestId) !== requestId || requestId.length === 0)
    return null;
  if (Object(event) !== event || event === undefined)
    return null;
  const { id, type, at, session, project, linked, permission, question } = event;
  if (String(id) !== id || id.length === 0)
    return null;
  if (String(type) !== type || !isGuestSessionEventType(type))
    return null;
  if (!Number.isFinite(at))
    return null;
  if (Object(session) !== session || session === undefined)
    return null;
  const sessionId = session.id;
  if (String(sessionId) !== sessionId || sessionId.length === 0)
    return null;
  const parentId = session.parentId;
  if (parentId !== null && (String(parentId) !== parentId || parentId.length === 0))
    return null;
  if (Object(project) !== project || project === undefined)
    return null;
  const directory = project.directory;
  if (directory !== null && (String(directory) !== directory || directory.length === 0))
    return null;
  if (!Array.isArray(linked))
    return null;
  const request = {
    v: SESSION_EVENTS_WIRE_VERSION,
    requestId,
    event: { id, type, at: Number(at), session: { id: sessionId, parentId }, project: { directory }, linked }
  };
  if (permission !== undefined) {
    if (Object(permission) !== permission)
      return null;
    const permissionRequestId = permission.requestId;
    if (String(permissionRequestId) !== permissionRequestId || permissionRequestId.length === 0)
      return null;
    request.event.permission = { requestId: permissionRequestId };
  }
  if (question !== undefined) {
    if (Object(question) !== question)
      return null;
    const { kind, id: questionId } = question;
    if (kind !== "form" && kind !== "page")
      return null;
    if (String(questionId) !== questionId || questionId.length === 0)
      return null;
    request.event.question = { kind, id: questionId };
  }
  if (content !== undefined) {
    if (Object(content) !== content || content.type !== type)
      return null;
    request.content = content;
  }
  return request;
};
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// src/core/ast-linter.ts
var BUILTIN_UI_COMPONENTS = new Set([
  "Stack",
  "Row",
  "Card",
  "Tabs",
  "Tab",
  "Details",
  "Text",
  "Badge",
  "Callout",
  "KeyValue",
  "Table",
  "Stat",
  "Progress",
  "Steps",
  "BarChart",
  "LineChart",
  "Series",
  "Choice",
  "Input",
  "DateInput",
  "Slider",
  "Button",
  "AutoVisual"
]);
var MOBILE_HEAVY_IN_ROW = new Set([
  "Table",
  "BarChart",
  "LineChart",
  "KeyValue",
  "Progress",
  "Steps"
]);
var VISUAL_COMPANION_COMPONENTS = new Set(["BarChart", "LineChart", "Progress", "Stat"]);

class ExprParser {
  pos = 0;
  src;
  line;
  constructor(src, line) {
    this.src = src;
    this.line = line;
  }
  isAtEnd() {
    this.skipWs();
    return this.pos >= this.src.length;
  }
  skipWs() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos += 1;
    }
  }
  peek() {
    return this.src[this.pos] ?? "";
  }
  parseExpr() {
    this.skipWs();
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      return { kind: "string", value: this.parseString() };
    }
    if (ch === "[") {
      return this.parseArray();
    }
    if (ch === "{") {
      return this.parseObject();
    }
    if (ch === "-" || ch >= "0" && ch <= "9") {
      return this.parseNumber();
    }
    const ident = this.parseIdentifier();
    if (!ident) {
      throw new Error(`Unexpected token "${ch || "EOF"}" at col ${this.pos + 1}`);
    }
    this.skipWs();
    if (this.peek() === "(") {
      return this.parseCall(ident);
    }
    if (ident === "true")
      return { kind: "boolean", value: true };
    if (ident === "false")
      return { kind: "boolean", value: false };
    if (ident === "null")
      return { kind: "null" };
    return { kind: "ref", name: ident };
  }
  parseString() {
    const quote = this.src[this.pos];
    this.pos += 1;
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      this.pos += 1;
      if (c === "\\") {
        const next = this.src[this.pos] ?? "";
        this.pos += 1;
        if (next === "n")
          out += `
`;
        else if (next === "t")
          out += "\t";
        else if (next === "r")
          out += "\r";
        else
          out += next;
        continue;
      }
      if (c === quote) {
        return out;
      }
      out += c;
    }
    throw new Error("Unterminated string literal");
  }
  parseNumber() {
    const start = this.pos;
    if (this.src[this.pos] === "-")
      this.pos += 1;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos])) {
      this.pos += 1;
    }
    const raw = this.src.slice(start, this.pos);
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number "${raw}"`);
    }
    return { kind: "number", value: num };
  }
  parseIdentifier() {
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.pos])) {
      this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }
  parseArray() {
    this.pos += 1;
    const items = [];
    this.skipWs();
    if (this.peek() === "]") {
      this.pos += 1;
      return { kind: "array", items };
    }
    while (this.pos < this.src.length) {
      items.push(this.parseExpr());
      this.skipWs();
      if (this.peek() === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === "]") {
          this.pos += 1;
          return { kind: "array", items };
        }
        continue;
      }
      if (this.peek() === "]") {
        this.pos += 1;
        return { kind: "array", items };
      }
      throw new Error(`Expected "," or "]" in array at col ${this.pos + 1}`);
    }
    throw new Error('Unterminated array "["');
  }
  parseObject() {
    this.pos += 1;
    const entries = [];
    this.skipWs();
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "object", entries };
    }
    while (this.pos < this.src.length) {
      this.skipWs();
      const key = this.peek() === '"' || this.peek() === "'" ? this.parseString() : this.parseIdentifier();
      if (!key) {
        throw new Error(`Expected object key at col ${this.pos + 1}`);
      }
      this.skipWs();
      if (this.peek() !== ":") {
        throw new Error(`Expected ":" after object key "${key}"`);
      }
      this.pos += 1;
      const value = this.parseExpr();
      entries.push({ key, value });
      this.skipWs();
      if (this.peek() === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === "}") {
          this.pos += 1;
          return { kind: "object", entries };
        }
        continue;
      }
      if (this.peek() === "}") {
        this.pos += 1;
        return { kind: "object", entries };
      }
      throw new Error(`Expected "," or "}" in object at col ${this.pos + 1}`);
    }
    throw new Error('Unterminated object "{"');
  }
  parseCall(typeName) {
    this.pos += 1;
    const args = [];
    let hasNamedArg = false;
    this.skipWs();
    if (this.peek() === ")") {
      this.pos += 1;
      return { kind: "call", typeName, args, hasNamedArg, line: this.line };
    }
    while (this.pos < this.src.length) {
      this.skipWs();
      const saved = this.pos;
      const maybeName = this.parseIdentifier();
      this.skipWs();
      if (maybeName && this.peek() === ":") {
        hasNamedArg = true;
        this.pos += 1;
      } else {
        this.pos = saved;
      }
      args.push(this.parseExpr());
      this.skipWs();
      if (this.peek() === ",") {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === ")") {
          this.pos += 1;
          return { kind: "call", typeName, args, hasNamedArg, line: this.line };
        }
        continue;
      }
      if (this.peek() === ")") {
        this.pos += 1;
        return { kind: "call", typeName, args, hasNamedArg, line: this.line };
      }
      throw new Error(`Expected "," or ")" in ${typeName}(...) at col ${this.pos + 1}`);
    }
    throw new Error(`Unterminated call to ${typeName}(...)`);
  }
}
function splitStatements(rawSource) {
  const clean = rawSource.trim().replace(/^```(?:openui-lang|openui)?\s*\n/i, "").replace(/\n```\s*$/i, "");
  const rawLines = clean.split(/\r?\n/);
  const statements = [];
  let buffer = "";
  let startLine = 1;
  let depth = 0;
  let inQuote = null;
  for (let i = 0;i < rawLines.length; i += 1) {
    const lineText = rawLines[i] ?? "";
    const trimmed = lineText.trim();
    if (!buffer && (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#"))) {
      continue;
    }
    if (!buffer) {
      startLine = i + 1;
      buffer = trimmed;
    } else {
      buffer += `
${trimmed}`;
    }
    for (let j = 0;j < trimmed.length; j += 1) {
      const c = trimmed[j];
      if (inQuote) {
        if (c === "\\") {
          j += 1;
        } else if (c === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        inQuote = c;
      } else if (c === "(" || c === "[" || c === "{") {
        depth += 1;
      } else if (c === ")" || c === "]" || c === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    if (depth === 0 && !inQuote) {
      statements.push({ line: startLine, text: buffer });
      buffer = "";
    }
  }
  if (buffer) {
    statements.push({ line: startLine, text: buffer });
  }
  return statements;
}
function lintOpenUiSource(source) {
  const issues = [];
  const componentCounts = {};
  const statements = splitStatements(source);
  if (statements.length === 0) {
    return {
      valid: false,
      componentCounts,
      issues: [{ code: "empty_program", severity: "error", message: "openui-lang program is empty." }]
    };
  }
  const bindings = new Map;
  let firstBindingName = null;
  for (const stmt of statements) {
    const eqMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/.exec(stmt.text);
    if (!eqMatch || !eqMatch[1] || !eqMatch[2]) {
      issues.push({
        code: "syntax_error",
        severity: "error",
        line: stmt.line,
        message: `Expected "name = Component(...)" assignment on line ${stmt.line}.`
      });
      continue;
    }
    const name = eqMatch[1];
    const rhs = eqMatch[2];
    if (firstBindingName === null)
      firstBindingName = name;
    try {
      const parser = new ExprParser(rhs, stmt.line);
      const expr = parser.parseExpr();
      if (!parser.isAtEnd()) {
        issues.push({
          code: "syntax_error",
          severity: "error",
          line: stmt.line,
          message: `Unexpected trailing characters in "${name}" assignment on line ${stmt.line}.`
        });
      }
      bindings.set(name, { name, line: stmt.line, expr });
    } catch (err) {
      issues.push({
        code: "syntax_error",
        severity: "error",
        line: stmt.line,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  const rootBinding = bindings.get("root");
  if (!rootBinding || rootBinding.expr.kind !== "call" || rootBinding.expr.typeName !== "Stack") {
    issues.push({
      code: "missing_root_stack",
      severity: "error",
      line: rootBinding?.line ?? 1,
      message: 'openui-lang must define "root = Stack([...])" as its root container.'
    });
  } else if (firstBindingName !== "root") {
    issues.push({
      code: "missing_root_stack",
      severity: "warning",
      line: rootBinding.line,
      message: 'First line should be "root = Stack([...])" so streaming renders progressively.'
    });
  }
  const visitedBindings = new Set;
  let numericTableCellCount = 0;
  const resolveExpr = (expr) => {
    if (expr.kind === "ref") {
      const target = bindings.get(expr.name);
      if (!target) {
        issues.push({
          code: "undefined_reference",
          severity: "error",
          message: `Undefined identifier "${expr.name}" referenced in UI tree.`
        });
        return expr;
      }
      if (visitedBindings.has(expr.name)) {
        return target.expr;
      }
      visitedBindings.add(expr.name);
      return target.expr;
    }
    return expr;
  };
  const walk = (rawExpr, parentComponent) => {
    const expr = resolveExpr(rawExpr);
    if (expr.kind === "array") {
      for (const item of expr.items) {
        walk(item, parentComponent);
      }
      return;
    }
    if (expr.kind === "object") {
      for (const entry of expr.entries) {
        walk(entry.value, parentComponent);
      }
      return;
    }
    if (expr.kind !== "call") {
      return;
    }
    const { typeName, args, hasNamedArg, line } = expr;
    componentCounts[typeName] = (componentCounts[typeName] ?? 0) + 1;
    if (hasNamedArg) {
      issues.push({
        code: "named_argument",
        severity: "error",
        line,
        message: `${typeName}(...) uses named arguments ("key: value"); openui-lang only supports positional arguments.`
      });
    }
    if (!BUILTIN_UI_COMPONENTS.has(typeName)) {
      const isPascalCase = /^[A-Z][A-Za-z0-9]*$/.test(typeName);
      issues.push({
        code: "unknown_component",
        severity: isPascalCase ? "warning" : "error",
        line,
        message: isPascalCase ? `"${typeName}" is not one of the 22 built-in openui-lang components (ensure an extension provides it).` : `Unknown component "${typeName}".`
      });
    }
    if (parentComponent === "Card" && (typeName === "Card" || typeName === "Tabs")) {
      issues.push({
        code: "invalid_nesting",
        severity: "error",
        line,
        message: `Card cannot contain ${typeName}; stack Cards directly under Stack([...]).`
      });
    }
    if (parentComponent === "Row" && (typeName === "Row" || typeName === "Card" || typeName === "Tabs" || typeName === "Details")) {
      issues.push({
        code: "invalid_nesting",
        severity: "error",
        line,
        message: `Row cannot contain ${typeName} (Row children must be leaf components; put Cards directly in Stack([...])).`
      });
    }
    if (parentComponent === "Tab" && typeName === "Tabs") {
      issues.push({
        code: "invalid_nesting",
        severity: "error",
        line,
        message: "Tab cannot nest another Tabs component."
      });
    }
    if (parentComponent === "Details" && (typeName === "Card" || typeName === "Tabs" || typeName === "Details")) {
      issues.push({
        code: "invalid_nesting",
        severity: "error",
        line,
        message: `Details cannot contain ${typeName}.`
      });
    }
    if (parentComponent === "Row" && MOBILE_HEAVY_IN_ROW.has(typeName)) {
      issues.push({
        code: "mobile_row_squeeze",
        severity: "warning",
        line,
        message: `Placing ${typeName} inside Row([...]) squeezes columns on ~360-412px mobile screens; place ${typeName} directly inside Stack([...]) and reserve Row for Stat tiles, Badges, or Buttons.`
      });
    }
    if (typeName === "Card" && args.length >= 2) {
      const titleArg = resolveExpr(args[0]);
      const childrenArg = resolveExpr(args[1]);
      if (titleArg.kind === "string" && titleArg.value.trim().length > 0 && childrenArg.kind === "array") {
        for (const childRaw of childrenArg.items) {
          const child = resolveExpr(childRaw);
          if (child.kind !== "call" || child.typeName !== "Badge")
            break;
          const badgeLabel = child.args[0] ? resolveExpr(child.args[0]) : null;
          if (badgeLabel?.kind === "string") {
            const text = badgeLabel.value.trim();
            const wordCount = text.split(/\s+/).filter(Boolean).length;
            if (text.length > 16 || wordCount > 2) {
              issues.push({
                code: "long_card_badge",
                severity: "warning",
                line: child.line,
                message: `Leading Card Badge "${text}" is too long (${text.length} chars); Card hoists leading Badges with shrink-0 and starves CardTitle on mobile. Keep Badge labels to 1-2 short words and move details to KeyValue/Table.`
              });
            }
          }
        }
      }
    }
    if (typeName === "Table" && args.length >= 2) {
      const rowsArg = resolveExpr(args[1]);
      if (rowsArg.kind === "array") {
        for (const rowRaw of rowsArg.items) {
          const row = resolveExpr(rowRaw);
          if (row.kind === "array") {
            for (const cellRaw of row.items) {
              const cell = resolveExpr(cellRaw);
              if (cell.kind === "number") {
                numericTableCellCount += 1;
              } else if (cell.kind === "string" && /^[$€£+-]?\d[\d,.]*\s*(?:%|ms|s|x|KB|MB|GB)?$/i.test(cell.value.trim())) {
                numericTableCellCount += 1;
              }
            }
          }
        }
      }
    }
    for (const arg of args) {
      walk(arg, typeName);
    }
  };
  if (rootBinding) {
    visitedBindings.add("root");
    walk(rootBinding.expr, null);
  }
  for (const [name, node] of bindings.entries()) {
    if (!visitedBindings.has(name)) {
      issues.push({
        code: "unreachable_binding",
        severity: "warning",
        line: node.line,
        message: `Binding "${name}" is unreachable from root.`
      });
    }
  }
  const hasVisualCompanion = Object.keys(componentCounts).some((name) => VISUAL_COMPANION_COMPONENTS.has(name) && (componentCounts[name] ?? 0) > 0);
  if ((componentCounts.Table ?? 0) > 0 && numericTableCellCount >= 2 && !hasVisualCompanion) {
    issues.push({
      code: "tufte_table_without_visual",
      severity: "warning",
      message: "Tufte data-ink check: numeric Table has no visual companion (pair numeric comparisons with BarChart, LineChart, Progress, or Stat tiles)."
    });
  }
  const hasErrors = issues.some((issue) => issue.severity === "error");
  return {
    valid: !hasErrors,
    componentCounts,
    issues
  };
}

// src/core/client.ts
function isRecord(val) {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}
function clamp01(val, fallback = 0) {
  const num = typeof val === "number" && Number.isFinite(val) ? val : fallback;
  return Math.min(1, Math.max(0, num));
}
function parseAnswer(raw) {
  if (!isRecord(raw))
    return null;
  if (typeof raw.noul === "number") {
    const noul = clamp01(raw.noul, 0.5);
    const confidence = typeof raw.confidence === "number" ? clamp01(raw.confidence) : Math.max(noul, 1 - noul);
    return { type: "noul", noul, confidence };
  }
  if (typeof raw.choice === "string") {
    const probsRaw = isRecord(raw.probabilities) ? raw.probabilities : {};
    const probabilities = {};
    for (const [key, val] of Object.entries(probsRaw)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        probabilities[key] = clamp01(val);
      }
    }
    const topProb = probabilities[raw.choice] ?? 0;
    const confidence = typeof raw.confidence === "number" ? clamp01(raw.confidence, topProb) : topProb;
    return {
      type: "choice",
      choice: raw.choice,
      probabilities,
      confidence
    };
  }
  if (typeof raw.score === "number") {
    const probsRaw = isRecord(raw.probabilities) ? raw.probabilities : {};
    const probabilities = {};
    let maxP = 0;
    for (const [key, val] of Object.entries(probsRaw)) {
      if (typeof val === "number" && Number.isFinite(val)) {
        const clamped = clamp01(val);
        probabilities[key] = clamped;
        if (clamped > maxP)
          maxP = clamped;
      }
    }
    const confidence = typeof raw.confidence === "number" ? clamp01(raw.confidence, maxP) : maxP;
    return {
      type: "score",
      score: raw.score,
      probabilities,
      confidence
    };
  }
  return null;
}
function sanitizeChoiceKey(rawKey, fallbackIndex) {
  const cleaned = rawKey.replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, 96);
  return cleaned.length > 0 ? cleaned : `opt_${fallbackIndex}`;
}
function createDecisionBridgeClient(options) {
  const fetchFn = options.fetchImpl ?? fetch;
  const base = options.bridgeUrl.replace(/\/+$/, "");
  const model = options.model ?? "gemini-decision-1";
  const defaultTimeoutMs = options.timeoutMs ?? 3500;
  const usesSystemOnePath = base.endsWith("/systemone");
  return {
    async checkHealth(timeoutMs = 1200) {
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const healthUrl = usesSystemOnePath ? `${base.replace(/\/v1\/systemone$|\/systemone$/, "")}/health` : `${base}/health`;
        const res = await fetchFn(healthUrl, { method: "GET", signal: controller.signal });
        return res.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async evaluate({ input, questions, timeoutMs = defaultTimeoutMs }) {
      const started = Date.now();
      if (Object.keys(questions).length === 0) {
        return { ok: true, ms: 0, model, inputTokens: 0, answers: {} };
      }
      const controller = new AbortController;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const endpoint = usesSystemOnePath ? base : `${base}/v1beta/decisions`;
        const payload = usesSystemOnePath ? buildSystemOnePayload(model, input, questions) : buildGooglePayload(model, input, questions);
        const res = await fetchFn(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
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
            error: `Decision bridge HTTP ${res.status}: ${rawText.slice(0, 240)}`
          };
        }
        const parsed = rawText ? JSON.parse(rawText) : {};
        if (!isRecord(parsed) || !isRecord(parsed.answers)) {
          return {
            ok: false,
            ms,
            model,
            inputTokens: 0,
            answers: {},
            error: "Decision bridge response missing answers map"
          };
        }
        const answers = {};
        for (const [qName, qVal] of Object.entries(parsed.answers)) {
          const norm = parseAnswer(qVal);
          if (norm)
            answers[qName] = norm;
        }
        const usage = isRecord(parsed.usage) ? parsed.usage : {};
        const inputTokens = typeof usage.total_input_tokens === "number" ? usage.total_input_tokens : typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        return {
          ok: true,
          ms,
          model: typeof parsed.model === "string" ? parsed.model : model,
          inputTokens,
          answers
        };
      } catch (err) {
        const ms = Date.now() - started;
        const message = err instanceof Error && err.name === "AbortError" ? `Decision bridge timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          ms,
          model,
          inputTokens: 0,
          answers: {},
          error: message
        };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
function normalizeGoogleInput(input) {
  if (typeof input === "string") {
    return input.trim().length > 0 ? input : "(empty)";
  }
  const merged = [];
  for (const block of input) {
    const prev = merged.at(-1);
    if (block.type === "text" && prev?.type === "text") {
      merged[merged.length - 1] = {
        type: "text",
        text: `${prev.text}
${block.text}`
      };
    } else {
      merged.push(block);
    }
  }
  return merged.length > 0 ? merged : "(empty)";
}
function buildGooglePayload(model, input, questions) {
  return {
    model,
    input: normalizeGoogleInput(input),
    questions
  };
}
function buildSystemOnePayload(model, input, questions) {
  const state = [];
  const images = [];
  if (typeof input === "string") {
    state.push(input);
  } else {
    for (const block of input) {
      if (block.type === "text") {
        state.push(block.text);
      } else if (block.type === "image" && block.data) {
        images.push(`data:${block.mime_type};base64,${block.data}`);
      }
    }
  }
  return {
    model,
    state: state.length === 1 ? state[0] : state,
    ...images.length > 0 ? { images } : {},
    questions
  };
}
function getNoulAnswer(result, key, fallback = 0) {
  const ans = result.answers[key];
  if (ans && "noul" in ans) {
    return { probability: ans.noul, confidence: ans.confidence };
  }
  return { probability: fallback, confidence: 0 };
}
function getChoiceAnswer(result, key, allowed, fallback) {
  const ans = result.answers[key];
  if (ans && "choice" in ans) {
    const matched = allowed.find((item) => item === ans.choice);
    if (matched !== undefined) {
      return {
        choice: matched,
        confidence: ans.confidence,
        probabilities: ans.probabilities
      };
    }
  }
  return { choice: fallback, confidence: 0, probabilities: {} };
}
function getScoreAnswer(result, key, fallback = 0) {
  const ans = result.answers[key];
  if (ans && "score" in ans) {
    return { score: ans.score, confidence: ans.confidence, probabilities: ans.probabilities };
  }
  return { score: fallback, confidence: 0, probabilities: {} };
}

// src/core/ui-compiler.ts
var CHART_KINDS = [
  "bar_ranked",
  "bar_whole_share",
  "line_trend",
  "progress_bars",
  "stat_tiles_only"
];
var SORT_ORDERS = ["preserve", "desc_primary", "asc_primary"];
var COLUMN_ROLES = [
  "primary_series",
  "secondary_series",
  "hero_stat",
  "table_only",
  "omit"
];
var TEMPORAL_PATTERNS = /^(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|Q[1-4]\s*\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{0,4}|W\d{1,2}|Day\s*\d+|Step\s*\d+|\d{1,2}:\d{2})$/i;
function parseNumericCell(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: raw };
  }
  if (typeof raw !== "string")
    return null;
  const trimmed = raw.trim();
  if (!trimmed)
    return null;
  const match = /^([+-]?)([$€£])?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]+))?\s*(%|ms|us|ns|s|x|Hz|KiB|MiB|GiB|TiB|KB|MB|GB|TB|G|T|k|M|B)?$/i.exec(trimmed);
  if (!match)
    return null;
  const sign = match[1] === "-" ? -1 : 1;
  const currency = match[2];
  const intPart = (match[3] ?? "0").replace(/,/g, "");
  const fracPart = match[4] ? `.${match[4]}` : "";
  const suffix = match[5];
  let multiplier = 1;
  let unit = currency ?? suffix;
  if (suffix === "G") {
    unit = "GB";
  } else if (suffix === "T") {
    unit = "TB";
  } else if (suffix === "k") {
    multiplier = 1000;
    unit = currency;
  } else if (suffix === "M" && currency) {
    multiplier = 1e6;
    unit = currency;
  } else if (suffix === "B" && currency) {
    multiplier = 1e9;
    unit = currency;
  }
  const num = sign * Number(`${intPart}${fracPart}`) * multiplier;
  if (!Number.isFinite(num))
    return null;
  return unit ? { value: num, unit } : { value: num };
}
function buildColumnProfiles(headers, rawRows) {
  const colCount = headers.length;
  const normalizedRows = rawRows.map((row) => Array.from({ length: colCount }, (_, idx) => {
    const cell = row[idx];
    if (cell === null || cell === undefined || cell === "")
      return null;
    const parsedNum = parseNumericCell(cell);
    if (parsedNum !== null)
      return parsedNum.value;
    return String(cell).trim();
  }));
  const usedKeys = new Set;
  const columns = headers.map((rawHeader, index) => {
    const name = rawHeader.trim() || `Column ${index + 1}`;
    let safeKey = sanitizeChoiceKey(`c${index}_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`, index);
    while (usedKeys.has(safeKey)) {
      safeKey = `${safeKey}_${index}`;
    }
    usedKeys.add(safeKey);
    const nums = [];
    const samples = [];
    let temporalHits = 0;
    let nonEmptyCount = 0;
    let detectedUnit;
    for (let r = 0;r < rawRows.length; r += 1) {
      const orig = rawRows[r]?.[index];
      const norm = normalizedRows[r]?.[index] ?? null;
      if (norm === null)
        continue;
      nonEmptyCount += 1;
      if (samples.length < 4)
        samples.push(norm);
      const parsedNum = parseNumericCell(orig);
      if (parsedNum !== null) {
        nums.push(parsedNum.value);
        if (!detectedUnit && parsedNum.unit)
          detectedUnit = parsedNum.unit;
      } else if (typeof norm === "string" && TEMPORAL_PATTERNS.test(norm)) {
        temporalHits += 1;
      }
    }
    const headerUnitMatch = /\((%|ms|s|USD|\$|MB|GB|KB|req\/s|ops\/s)\)/i.exec(name);
    if (!detectedUnit && headerUnitMatch?.[1]) {
      detectedUnit = headerUnitMatch[1];
    }
    const isNumeric = nonEmptyCount > 0 && nums.length >= Math.ceil(nonEmptyCount * 0.65);
    const isTemporal = !isNumeric && (nonEmptyCount > 0 && temporalHits >= Math.ceil(nonEmptyCount * 0.6) || /\b(?:date|time|month|quarter|year|week|day|timestamp)\b/i.test(name));
    const sum = isNumeric && nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
    const min = isNumeric && nums.length > 0 ? Math.min(...nums) : null;
    const max = isNumeric && nums.length > 0 ? Math.max(...nums) : null;
    const mean = sum !== null && nums.length > 0 ? sum / nums.length : null;
    const looksLikePercentageShare = isNumeric && nums.length >= 2 && min !== null && min >= 0 && sum !== null && (sum >= 98 && sum <= 102 || sum >= 0.98 && sum <= 1.02);
    return {
      index,
      name,
      safeKey,
      kind: isNumeric ? "number" : isTemporal ? "temporal" : "string",
      ...detectedUnit ? { unit: detectedUnit } : {},
      sampleValues: samples,
      numericCount: nums.length,
      min,
      max,
      sum,
      mean,
      looksLikePercentageShare
    };
  });
  return { columns, normalizedRows };
}
function tryExtractFromJson(text) {
  const candidates = [text.trim()];
  const jsonFence = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(text);
  if (jsonFence?.[1])
    candidates.unshift(jsonFence[1].trim());
  for (const candidate of candidates) {
    if (!candidate.startsWith("[") && !candidate.startsWith("{"))
      continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && !Array.isArray(parsed[0])) {
        const keySet = new Set;
        for (const item of parsed.slice(0, 50)) {
          if (item && typeof item === "object" && !Array.isArray(item)) {
            for (const k of Object.keys(item))
              keySet.add(k);
          }
        }
        const headers = [...keySet];
        if (headers.length === 0)
          continue;
        const rawRows = parsed.slice(0, 60).map((item) => {
          const rec = item;
          return headers.map((h) => rec[h] ?? null);
        });
        const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
        return { sourceKind: "json_records", columns, rows: normalizedRows };
      }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed;
        if (Array.isArray(obj.columns) && Array.isArray(obj.rows) && obj.rows.length > 0) {
          const headers = obj.columns.map((c) => String(c));
          const rawRows = obj.rows.filter(Array.isArray).slice(0, 60);
          const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
          return {
            ...typeof obj.title === "string" ? { title: obj.title } : {},
            sourceKind: "json_table",
            columns,
            rows: normalizedRows
          };
        }
        const entries = Object.entries(obj).filter(([, v]) => typeof v === "number" || typeof v === "string");
        if (entries.length >= 2) {
          const headers = ["Item", "Value"];
          const rawRows = entries.map(([k, v]) => [k, v]);
          const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
          return { sourceKind: "json_records", columns, rows: normalizedRows };
        }
      }
    } catch {}
  }
  return null;
}
function tryExtractMarkdownTable(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0;i < lines.length - 2; i += 1) {
    const headerLine = lines[i]?.trim() ?? "";
    const dividerLine = lines[i + 1]?.trim() ?? "";
    if (!headerLine.includes("|") || !/^\|?[\s:-]+\|[\s|:-]+$/.test(dividerLine)) {
      continue;
    }
    const splitPipe = (line) => {
      const stripped = line.replace(/^\|/, "").replace(/\|$/, "");
      return stripped.split("|").map((cell) => cell.trim().replace(/\*\*/g, "").replace(/`/g, ""));
    };
    const headers = splitPipe(headerLine);
    if (headers.length < 2)
      continue;
    const rawRows = [];
    for (let j = i + 2;j < lines.length && rawRows.length < 60; j += 1) {
      const rowLine = lines[j]?.trim() ?? "";
      if (!rowLine.includes("|"))
        break;
      const cells = splitPipe(rowLine);
      if (cells.length >= 2) {
        rawRows.push(cells);
      }
    }
    if (rawRows.length >= 1) {
      let title;
      for (let k = i - 1;k >= Math.max(0, i - 4); k -= 1) {
        const heading = /^#{1,4}\s+(.+)$/.exec(lines[k]?.trim() ?? "");
        if (heading?.[1]) {
          title = heading[1].trim();
          break;
        }
      }
      const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
      return {
        ...title ? { title } : {},
        sourceKind: "markdown_table",
        columns,
        rows: normalizedRows
      };
    }
  }
  return null;
}
function tryExtractOpenUiBlock(text) {
  const tableMatch = /Table\s*\(\s*(\[[^\]]+\])\s*,\s*(\[\s*\[[\s\S]*?\]\s*\])\s*\)/.exec(text);
  if (tableMatch?.[1] && tableMatch[2]) {
    try {
      const headers = JSON.parse(tableMatch[1]);
      const rawRows = JSON.parse(tableMatch[2]);
      if (Array.isArray(headers) && Array.isArray(rawRows) && rawRows.length > 0) {
        const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
        return { sourceKind: "openui_block", columns, rows: normalizedRows };
      }
    } catch {}
  }
  return null;
}
function tryExtractCsv(text) {
  const clean = text.trim().replace(/^```(?:csv|tsv)?\s*\n/i, "").replace(/\n```\s*$/i, "");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2)
    return null;
  const delim = lines[0].includes("\t") ? "\t" : ",";
  if (!lines[0].includes(delim))
    return null;
  const parseLine = (line) => {
    const out = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0;i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === delim && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseLine(lines[0]);
  if (headers.length < 2)
    return null;
  const rawRows = lines.slice(1, 61).map(parseLine);
  if (rawRows.some((r) => r.length !== headers.length))
    return null;
  const { columns, normalizedRows } = buildColumnProfiles(headers, rawRows);
  return { sourceKind: "csv", columns, rows: normalizedRows };
}
function extractStructuredDataset(rawInput) {
  return tryExtractFromJson(rawInput) ?? tryExtractOpenUiBlock(rawInput) ?? tryExtractMarkdownTable(rawInput) ?? tryExtractCsv(rawInput);
}
function buildCompilerQuestions(dataset, editInstruction) {
  const editPrefix = editInstruction?.trim() ? `Honor the user's explicit layout/edit instruction ("${editInstruction.trim()}") above defaults. ` : "";
  const labelCriteria = {};
  for (const col of dataset.columns) {
    labelCriteria[col.safeKey] = `Column "${col.name}" (${col.kind}), samples: ${col.sampleValues.slice(0, 3).join(", ")}`;
  }
  const questions = {
    chart_kind: {
      type: "choice",
      instructions: `${editPrefix}Choose the best primary openui-lang visual component for this dataset.`,
      criteria: {
        bar_ranked: "Standard BarChart comparing magnitudes across discrete categories or items.",
        bar_whole_share: "BarChart with whole=true where one series represents parts adding up to 100% or a single whole.",
        line_trend: "LineChart showing values ordered across time, dates, versions, or sequential steps.",
        progress_bars: "Stacked Progress bars when each row is an independent completion or utilization percentage (0..100).",
        stat_tiles_only: "Summary Stat tiles without a chart (only when <=2 rows or explicitly requested)."
      }
    },
    include_table: {
      type: "noul",
      instructions: `${editPrefix}Should the compiled openui-lang block include a companion Table beneath the visual chart?`,
      criteria: {
        true_description: "Include a companion detail Table (recommended when >=3 columns or exact lookup values help alongside the chart, unless the user asked to hide the table).",
        false_description: "Omit the detail Table (user asked to hide the table, compact stats/chart only, or a 2-column chart already shows every value clearly)."
      }
    },
    include_stats: {
      type: "noul",
      instructions: `${editPrefix}Should a compact top Row of hero Stat summary tiles be included above the chart?`,
      criteria: {
        true_description: "Include 2-4 summary Stat tiles highlighting key totals, averages, or leaders.",
        false_description: "Skip top Stat tiles when the user asked for a minimal chart-only view."
      }
    },
    sort_order: {
      type: "choice",
      instructions: `${editPrefix}How should rows be ordered in the chart and table?`,
      criteria: {
        asc_primary: "Sort ascending (smallest to largest) by the primary metric.",
        desc_primary: "Sort descending (largest to smallest) by the primary metric—ideal for ranked category BarCharts.",
        preserve: "Preserve original row order—mandatory for chronological/time-series data or ordered stages."
      }
    }
  };
  if (dataset.columns.length >= 2) {
    questions.label_col = {
      type: "choice",
      instructions: `${editPrefix}Which column provides the x-axis category or time label for each row?`,
      criteria: labelCriteria
    };
  }
  for (const col of dataset.columns) {
    if (col.kind !== "number")
      continue;
    questions[`role_${col.index}`] = {
      type: "choice",
      instructions: `${editPrefix}Assign a visual role to numeric column "${col.name}" (min=${col.min ?? "n/a"}, max=${col.max ?? "n/a"}, sum=${col.sum !== null ? Number(col.sum.toFixed(2)) : "n/a"}).`,
      criteria: {
        hero_stat: "Show as a top summary Stat tile and table column, not plotted on the main chart axis (useful when units/scales differ drastically from the primary series).",
        omit: "Exclude from the visual output (IDs, redundant index columns, or explicitly hidden).",
        primary_series: "Primary plotted Series on the BarChart / LineChart / Progress bars.",
        secondary_series: "Additional plotted Series sharing a comparable scale/unit with the primary series.",
        table_only: "Keep in the companion Table only without plotting as a chart Series."
      }
    };
  }
  return questions;
}
function buildFallbackCompilerPlan(dataset, editInstruction, ms = 0) {
  const edit = (editInstruction ?? "").toLowerCase();
  const labelCol = dataset.columns.find((c) => c.kind === "temporal") ?? dataset.columns.find((c) => c.kind === "string") ?? dataset.columns[0];
  const labelColumnIndex = labelCol?.index ?? 0;
  const numericCols = dataset.columns.filter((c) => c.kind === "number" && c.index !== labelColumnIndex);
  const firstNum = numericCols[0];
  let chartKind = "bar_ranked";
  if (edit.includes("line") || edit.includes("trend")) {
    chartKind = "line_trend";
  } else if (edit.includes("whole") || edit.includes("share") || edit.includes("stack")) {
    chartKind = "bar_whole_share";
  } else if (edit.includes("progress")) {
    chartKind = "progress_bars";
  } else if (edit.includes("stat only") || edit.includes("stats only") || numericCols.length === 0) {
    chartKind = "stat_tiles_only";
  } else if (labelCol?.kind === "temporal") {
    chartKind = "line_trend";
  } else if (firstNum?.looksLikePercentageShare) {
    chartKind = "bar_whole_share";
  }
  let sortOrder = chartKind === "line_trend" || labelCol?.kind === "temporal" ? "preserve" : "desc_primary";
  if (edit.includes("asc") || edit.includes("lowest"))
    sortOrder = "asc_primary";
  else if (edit.includes("desc") || edit.includes("highest") || edit.includes("rank"))
    sortOrder = "desc_primary";
  else if (edit.includes("preserve") || edit.includes("original"))
    sortOrder = "preserve";
  const includeTable = !edit.includes("no table") && !edit.includes("hide table") && dataset.rows.length > 1;
  const includeStats = !edit.includes("no stat") && !edit.includes("hide stat") && numericCols.length > 0;
  const columnRoles = {};
  numericCols.forEach((col, idx) => {
    if (idx === 0) {
      columnRoles[col.index] = "primary_series";
    } else if (idx === 1 && chartKind !== "bar_whole_share" && col.unit === firstNum?.unit && firstNum?.max && col.max && Math.max(firstNum.max, col.max) / Math.max(0.000001, Math.min(Math.abs(firstNum.max), Math.abs(col.max))) <= 10) {
      columnRoles[col.index] = "secondary_series";
    } else if (idx <= 2) {
      columnRoles[col.index] = "hero_stat";
    } else {
      columnRoles[col.index] = "table_only";
    }
  });
  return {
    chartKind,
    chartConfidence: 1,
    includeTable,
    includeStats,
    sortOrder,
    labelColumnIndex,
    columnRoles,
    ms,
    questionCount: 0,
    usedFallbackHeuristics: true
  };
}
function summarizeDatasetForPrompt(dataset, editInstruction) {
  const colLines = dataset.columns.map((c) => `- [${c.safeKey}] "${c.name}" (${c.kind}${c.unit ? `, unit=${c.unit}` : ""}${c.looksLikePercentageShare ? ", sums~100%" : ""}): samples=${JSON.stringify(c.sampleValues)}`);
  const previewRows = dataset.rows.slice(0, 12).map((r) => JSON.stringify(r));
  return [
    dataset.title ? `Dataset Title: ${dataset.title}` : `Dataset (${dataset.rows.length} rows, source=${dataset.sourceKind})`,
    editInstruction?.trim() ? `User Layout / Quick-Edit Request: ${editInstruction.trim()}` : "",
    "Columns:",
    ...colLines,
    "Sample Rows:",
    ...previewRows
  ].filter(Boolean).join(`
`);
}
function formatNumberCompact(num, unit) {
  const abs = Math.abs(num);
  let formatted;
  if (abs >= 1e6)
    formatted = `${(num / 1e6).toFixed(2).replace(/\.00$/, "")}M`;
  else if (abs >= 1e4)
    formatted = `${(num / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  else if (Number.isInteger(num))
    formatted = String(num);
  else
    formatted = num.toFixed(2).replace(/\.?0+$/, "");
  if (!unit)
    return formatted;
  if (unit === "$" || unit === "€" || unit === "£")
    return `${unit}${formatted}`;
  if (unit === "%")
    return `${formatted}%`;
  return `${formatted} ${unit}`;
}
function emitOpenUiProgram(dataset, plan) {
  const labelCol = dataset.columns[plan.labelColumnIndex] ?? dataset.columns[0];
  const numericCols = dataset.columns.filter((c) => c.kind === "number" && c.index !== labelCol.index);
  let primaryCols = numericCols.filter((c) => plan.columnRoles[c.index] === "primary_series");
  if (primaryCols.length === 0 && numericCols[0]) {
    primaryCols = [numericCols[0]];
  }
  const primaryCol = primaryCols[0];
  const secondaryCols = plan.chartKind === "bar_whole_share" ? [] : numericCols.filter((c) => c !== primaryCol && (plan.columnRoles[c.index] === "primary_series" || plan.columnRoles[c.index] === "secondary_series"));
  const plottedCols = primaryCol ? [primaryCol, ...secondaryCols].slice(0, 4) : [];
  const workingRows = [...dataset.rows];
  if (primaryCol && plan.sortOrder !== "preserve") {
    const pIdx = primaryCol.index;
    workingRows.sort((a, b) => {
      const av = typeof a[pIdx] === "number" ? a[pIdx] : Number.NEGATIVE_INFINITY;
      const bv = typeof b[pIdx] === "number" ? b[pIdx] : Number.NEGATIVE_INFINITY;
      return plan.sortOrder === "desc_primary" ? bv - av : av - bv;
    });
  }
  const rootChildren = [];
  const extraLines = [];
  if (plan.includeStats && primaryCol && workingRows.length > 0) {
    const statDefs = [];
    const statCandidates = [
      primaryCol,
      ...numericCols.filter((c) => c !== primaryCol && (plan.columnRoles[c.index] === "hero_stat" || plan.columnRoles[c.index] === "secondary_series"))
    ].slice(0, 3);
    statCandidates.forEach((col, idx) => {
      const vals = workingRows.map((r) => r[col.index]).filter((v) => typeof v === "number" && Number.isFinite(v));
      if (vals.length === 0)
        return;
      const leaderRow = workingRows.reduce((best, cur) => {
        const bv = typeof best[col.index] === "number" ? best[col.index] : -Infinity;
        const cv = typeof cur[col.index] === "number" ? cur[col.index] : -Infinity;
        return cv > bv ? cur : best;
      }, workingRows[0]);
      const leaderLabel = String(leaderRow[labelCol.index] ?? "").slice(0, 22);
      const leaderVal = typeof leaderRow[col.index] === "number" ? leaderRow[col.index] : vals[0];
      const statId = `st_${idx + 1}`;
      const isIntensiveMetric = col.looksLikePercentageShare || col.unit !== undefined && /^(?:%|ms|s|us|ns|Hz|x)$/i.test(col.unit) || /\b(?:latency|p50|p90|p95|p99|rate|ratio|score|ece|err|error|avg|mean|duration)\b/i.test(col.name);
      if (isIntensiveMetric) {
        const mean = vals.reduce((acc, v) => acc + v, 0) / vals.length;
        statDefs.push(`${statId} = Stat(${JSON.stringify(`Peak ${col.name}`)}, ${JSON.stringify(formatNumberCompact(leaderVal, col.unit))}, ${JSON.stringify(`${leaderLabel} · avg ${formatNumberCompact(mean, col.unit)}`)}, "info")`);
      } else {
        const total = vals.reduce((acc, v) => acc + v, 0);
        statDefs.push(`${statId} = Stat(${JSON.stringify(`Total ${col.name}`)}, ${JSON.stringify(formatNumberCompact(total, col.unit))}, ${JSON.stringify(`Max: ${leaderLabel}`)}, ${idx === 0 ? '"success"' : '"neutral"'})`);
      }
    });
    if (statDefs.length > 0) {
      const statRefs = statDefs.map((line) => line.split(" = ")[0]);
      rootChildren.push("stats");
      extraLines.push(`stats = Row([${statRefs.join(", ")}])`);
      extraLines.push(...statDefs);
    }
  }
  const labels = workingRows.map((r, idx) => String(r[labelCol.index] ?? `Row ${idx + 1}`));
  if (plottedCols.length > 0 && plan.chartKind !== "stat_tiles_only") {
    if (plan.chartKind === "progress_bars" && primaryCol) {
      const maxVal = primaryCol.max !== null && primaryCol.max > 100 ? Math.ceil(primaryCol.max) : 100;
      const progIds = [];
      workingRows.slice(0, 12).forEach((row, idx) => {
        const rawVal = typeof row[primaryCol.index] === "number" ? row[primaryCol.index] : 0;
        const clamped = Math.max(0, rawVal);
        const pid = `prog_${idx + 1}`;
        progIds.push(pid);
        extraLines.push(maxVal === 100 ? `${pid} = Progress(${JSON.stringify(labels[idx] ?? `Item ${idx + 1}`)}, ${Number(clamped.toFixed(2))})` : `${pid} = Progress(${JSON.stringify(labels[idx] ?? `Item ${idx + 1}`)}, ${Number(clamped.toFixed(2))}, ${maxVal})`);
      });
      if (progIds.length > 0) {
        const cardTitle = (dataset.title ?? primaryCol.name).slice(0, 28);
        rootChildren.push("visual");
        extraLines.push(`visual = Card(${JSON.stringify(cardTitle)}, [${progIds.join(", ")}])`);
      }
    } else {
      const seriesIds = [];
      const seriesLines = [];
      plottedCols.forEach((col, idx) => {
        const sid = `ser_${idx + 1}`;
        seriesIds.push(sid);
        const values = workingRows.map((r) => {
          const v = r[col.index];
          return typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(4)) : null;
        });
        seriesLines.push(`${sid} = Series(${JSON.stringify(col.name)}, ${JSON.stringify(values)})`);
      });
      const unit = primaryCol?.unit;
      rootChildren.push("chart");
      if (plan.chartKind === "line_trend") {
        extraLines.push(unit ? `chart = LineChart(${JSON.stringify(labels)}, [${seriesIds.join(", ")}], ${JSON.stringify(unit)})` : `chart = LineChart(${JSON.stringify(labels)}, [${seriesIds.join(", ")}])`);
      } else if (plan.chartKind === "bar_whole_share") {
        const singleSeries = seriesIds[0];
        extraLines.push(`chart = BarChart(${JSON.stringify(labels)}, [${singleSeries}], ${JSON.stringify(unit ?? "")}, true)`);
      } else {
        extraLines.push(unit ? `chart = BarChart(${JSON.stringify(labels)}, [${seriesIds.join(", ")}], ${JSON.stringify(unit)})` : `chart = BarChart(${JSON.stringify(labels)}, [${seriesIds.join(", ")}])`);
      }
      extraLines.push(...seriesLines);
    }
  }
  const visibleTableCols = dataset.columns.filter((c) => plan.columnRoles[c.index] !== "omit");
  const forceTable = rootChildren.length === 0;
  if ((plan.includeTable || forceTable) && visibleTableCols.length > 0) {
    const colHeaders = visibleTableCols.map((c) => c.name);
    const tableRows = workingRows.slice(0, 30).map((row) => visibleTableCols.map((col) => {
      const cell = row[col.index];
      if (cell === null || cell === undefined)
        return "—";
      if (typeof cell === "number") {
        return Number.isInteger(cell) ? cell : Number(cell.toFixed(3));
      }
      return cell;
    }));
    rootChildren.push("detail_table");
    extraLines.push(`detail_table = Table(${JSON.stringify(colHeaders)}, ${JSON.stringify(tableRows)})`);
  }
  return [`root = Stack([${rootChildren.join(", ")}])`, ...extraLines].join(`
`);
}
async function compileDatasetToUi(params) {
  const { dataset } = params;
  const questions = buildCompilerQuestions(dataset, params.editInstruction);
  const questionCount = Object.keys(questions).length;
  const promptText = summarizeDatasetForPrompt(dataset, params.editInstruction);
  const batch = await params.client.evaluate({
    input: promptText,
    questions,
    timeoutMs: params.timeoutMs ?? 3500
  });
  let plan;
  if (!batch.ok) {
    plan = buildFallbackCompilerPlan(dataset, params.editInstruction, batch.ms);
  } else {
    const fallback = buildFallbackCompilerPlan(dataset, params.editInstruction, batch.ms);
    const chartAns = getChoiceAnswer(batch, "chart_kind", CHART_KINDS, fallback.chartKind);
    const includeTableAns = getNoulAnswer(batch, "include_table", fallback.includeTable ? 0.8 : 0.2);
    const includeStatsAns = getNoulAnswer(batch, "include_stats", fallback.includeStats ? 0.8 : 0.2);
    const sortAns = getChoiceAnswer(batch, "sort_order", SORT_ORDERS, fallback.sortOrder);
    const allowedLabelKeys = dataset.columns.map((c) => c.safeKey);
    const defaultLabelKey = dataset.columns[fallback.labelColumnIndex]?.safeKey ?? allowedLabelKeys[0] ?? "";
    const labelAns = allowedLabelKeys.length >= 2 ? getChoiceAnswer(batch, "label_col", allowedLabelKeys, defaultLabelKey) : { choice: defaultLabelKey, confidence: 1 };
    const chosenLabelCol = dataset.columns.find((c) => c.safeKey === labelAns.choice) ?? dataset.columns[fallback.labelColumnIndex] ?? dataset.columns[0];
    const columnRoles = {};
    for (const col of dataset.columns) {
      if (col.kind !== "number" || col.index === chosenLabelCol.index)
        continue;
      const fbRole = fallback.columnRoles[col.index] ?? "table_only";
      const roleAns = getChoiceAnswer(batch, `role_${col.index}`, COLUMN_ROLES, fbRole);
      columnRoles[col.index] = roleAns.choice;
    }
    let effectiveChartKind = chartAns.choice;
    const primaryCandidate = dataset.columns.find((c) => columnRoles[c.index] === "primary_series") ?? dataset.columns.find((c) => c.kind === "number" && c.index !== chosenLabelCol.index);
    if (effectiveChartKind === "bar_whole_share" && primaryCandidate?.min !== null && primaryCandidate !== undefined && primaryCandidate.min < 0) {
      effectiveChartKind = "bar_ranked";
    }
    if (!primaryCandidate) {
      effectiveChartKind = "stat_tiles_only";
    }
    plan = {
      chartKind: effectiveChartKind,
      chartConfidence: chartAns.confidence,
      includeTable: includeTableAns.probability >= 0.5,
      includeStats: includeStatsAns.probability >= 0.5,
      sortOrder: sortAns.choice,
      labelColumnIndex: chosenLabelCol.index,
      columnRoles,
      ms: batch.ms,
      questionCount,
      usedFallbackHeuristics: false
    };
  }
  const source = emitOpenUiProgram(dataset, plan);
  const lint = lintOpenUiSource(source);
  return {
    ok: lint.valid,
    source,
    fencedMarkdown: `\`\`\`openui-lang
${source}
\`\`\``,
    dataset,
    plan,
    lint
  };
}
async function compileStructuredDataToUi(params) {
  const extracted = extractStructuredDataset(params.rawInput);
  if (!extracted) {
    throw new Error("Could not extract structured rows from input. Provide JSON records, { columns, rows }, CSV/TSV, a Markdown pipe table, or an openui-lang Table block.");
  }
  const dataset = params.title ? { ...extracted, title: params.title } : extracted;
  return compileDatasetToUi({
    dataset,
    ...params.editInstruction ? { editInstruction: params.editInstruction } : {},
    client: params.client,
    ...params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}
  });
}

// src/core/auto-block.ts
function inferStatusTone(val) {
  const upper = val.trim().toUpperCase();
  if (/\b(?:OK|HEALTHY|ONLINE|ACTIVE|PASS|PASSED|READY|SUCCESS|NOMINAL)\b/.test(upper)) {
    return "success";
  }
  if (/\b(?:WARN|WARNING|DEGRADED|SLOW|HIGH|PENDING|RETRY)\b/.test(upper)) {
    return "warning";
  }
  if (/\b(?:ERR|ERROR|FAIL|FAILED|DOWN|OFFLINE|CRITICAL|BLOCKED)\b/.test(upper)) {
    return "error";
  }
  return;
}
function inferMetricHeaderFromUnit(unitHint, introText, fallback) {
  const lowerIntro = introText.toLowerCase();
  const u = unitHint.trim();
  if (/^(?:ms|us|ns|s)$/i.test(u)) {
    if (lowerIntro.includes("p99"))
      return "P99 Latency";
    if (lowerIntro.includes("p95"))
      return "P95 Latency";
    if (lowerIntro.includes("duration"))
      return "Duration";
    return "Latency";
  }
  if (u === "%") {
    if (lowerIntro.includes("err") || fallback === "Secondary")
      return "Error Rate";
    if (lowerIntro.includes("pass"))
      return "Pass Rate";
    if (lowerIntro.includes("share"))
      return "Share";
    return "Rate";
  }
  if (u === "$" || u === "€" || u === "£")
    return "Cost";
  if (/^(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB|G|T)$/i.test(u))
    return "Size";
  if (/^(?:req\/s|ops\/s|Hz)$/i.test(u))
    return "Throughput";
  return fallback;
}
function tryExtractCliColumns(text) {
  const clean = text.trim().replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/i, "");
  const lines = clean.split(/\r?\n/);
  let tableStart = -1;
  let tableRows = [];
  for (let i = 0;i < lines.length - 2; i += 1) {
    const headerCells = (lines[i] ?? "").trim().split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (headerCells.length < 3)
      continue;
    if (headerCells.every((c) => /^[\d.,%-]+$/.test(c)))
      continue;
    const matched = [headerCells];
    for (let j = i + 1;j < lines.length; j += 1) {
      const rowText = (lines[j] ?? "").trim();
      if (!rowText)
        break;
      const cells = rowText.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
      if (cells.length === headerCells.length) {
        matched.push(cells);
      } else {
        break;
      }
    }
    if (matched.length >= 3) {
      tableStart = i;
      tableRows = matched;
      break;
    }
  }
  if (tableStart === -1 || tableRows.length < 3)
    return null;
  const csvEquivalent = tableRows.map((row) => row.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join(`
`);
  const extracted = extractStructuredDataset(csvEquivalent);
  if (!extracted || !extracted.columns.some((c) => c.kind === "number"))
    return null;
  const leadingLines = lines.slice(0, tableStart).map((l) => l.trim()).filter(Boolean);
  const trailingLines = lines.slice(tableStart + tableRows.length).map((l) => l.trim()).filter(Boolean);
  const title = leadingLines.length === 1 ? leadingLines[0].replace(/^#{1,4}\s+/, "").replace(/:\s*$/, "") : undefined;
  const dataset = title ? { ...extracted, title } : extracted;
  const prose = [...title ? [] : leadingLines, ...trailingLines].join(`
`);
  return { dataset, prose };
}
function tryExtractProseMetricList(text) {
  const lines = text.split(/\r?\n/);
  const metricRowRegex = /^(?:[-*•]|\d+[.)])?\s*`?([A-Za-z0-9_./ -]{2,38}?)`?\s*(?:[:—–-]\s*|\s+\()([+-]?[$€£]?\d[\d,.]*\s*(?:%|ms|us|ns|s|x|Hz|KB|MB|GB|TB|G|T|req\/s|ops\/s|k|M|B)?)(.*)$/i;
  const extractedRows = [];
  let nonNumericKvLineCount = 0;
  for (let i = 0;i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("|"))
      continue;
    const m = metricRowRegex.exec(trimmed);
    if (!m?.[1] || !m[2]) {
      if (/^(?:[-*•]\s*)?[A-Za-z][A-Za-z0-9 _/-]{1,30}\s*:\s*\S+/.test(trimmed) && !trimmed.endsWith(":")) {
        nonNumericKvLineCount += 1;
      }
      continue;
    }
    const rest = (m[3] ?? "").trim();
    if (/^\/\s*\d+/.test(rest)) {
      nonNumericKvLineCount += 1;
      continue;
    }
    const label = m[1].trim().replace(/\*+/g, "");
    const primaryRaw = m[2].trim();
    const secMatch = /([+-]?[$€£]?\d[\d,.]*\s*(?:%|ms|us|ns|s|x|KB|MB|GB|TB)?)/i.exec(rest);
    const secondaryRaw = secMatch?.[1]?.trim() ?? null;
    const unitMatch = /(%|ms|us|ns|s|x|Hz|KB|MB|GB|TB|G|T|\$|€|£)/i.exec(primaryRaw);
    const secUnitMatch = secondaryRaw ? /(%|ms|us|ns|s|x|KB|MB|GB|TB|\$|€|£)/i.exec(secondaryRaw) : null;
    extractedRows.push({
      lineIdx: i,
      label,
      primaryRaw,
      secondaryRaw,
      unitHint: unitMatch?.[1] ?? "",
      secUnitHint: secUnitMatch?.[1] ?? ""
    });
  }
  if (extractedRows.length < 3 || nonNumericKvLineCount >= 2)
    return null;
  const unitCounts = new Map;
  for (const r of extractedRows) {
    unitCounts.set(r.unitHint, (unitCounts.get(r.unitHint) ?? 0) + 1);
  }
  const topEntry = [...unitCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topEntry[1] < Math.ceil(extractedRows.length * 0.75)) {
    return null;
  }
  const hasSecondary = extractedRows.filter((r) => r.secondaryRaw !== null).length >= Math.ceil(extractedRows.length * 0.65);
  const firstRowLine = extractedRows[0].lineIdx;
  const lastRowLine = extractedRows.at(-1).lineIdx;
  const leadingLines = lines.slice(0, firstRowLine).map((l) => l.trim()).filter(Boolean);
  const introText = leadingLines.join(" ");
  const primaryHeader = inferMetricHeaderFromUnit(topEntry[0], introText, "Metric");
  const secUnit = extractedRows.find((r) => r.secUnitHint)?.secUnitHint ?? "";
  const secondaryHeader = inferMetricHeaderFromUnit(secUnit, introText, "Secondary");
  const headers = hasSecondary ? ["Item", primaryHeader, secondaryHeader] : ["Item", primaryHeader];
  const csvLines = [
    headers.join(","),
    ...extractedRows.map((r) => hasSecondary ? `"${r.label.replace(/"/g, '""')}","${r.primaryRaw}","${r.secondaryRaw ?? ""}"` : `"${r.label.replace(/"/g, '""')}","${r.primaryRaw}"`)
  ];
  const extracted = extractStructuredDataset(csvLines.join(`
`));
  if (!extracted)
    return null;
  let title;
  let keptLeading = leadingLines;
  if (leadingLines.length === 1 && (leadingLines[0].endsWith(":") || leadingLines[0].startsWith("#"))) {
    title = leadingLines[0].replace(/^#{1,4}\s+/, "").replace(/:\s*$/, "");
    keptLeading = [];
  }
  const consumedIdx = new Set(extractedRows.map((r) => r.lineIdx));
  const middleAndTrailing = lines.slice(firstRowLine).map((l, offset) => ({ text: l.trim(), idx: firstRowLine + offset })).filter((item) => item.text.length > 0 && !consumedIdx.has(item.idx) && item.idx > lastRowLine).map((item) => item.text);
  const prose = [...keptLeading, ...middleAndTrailing].join(`
`);
  const dataset = title ? { ...extracted, title } : extracted;
  return { dataset, prose };
}
function extractKeyValueCandidates(text) {
  const lines = text.split(/\r?\n/);
  const kvRegex = /^(?:[-*•]\s*)?\*{0,2}([A-Za-z][A-Za-z0-9 _/-]{1,32})\*{0,2}\s*:\s*(.{1,80})$/;
  const items = [];
  const usedLines = new Set;
  for (let i = 0;i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("http"))
      continue;
    const m = kvRegex.exec(trimmed);
    if (!m?.[1] || !m[2])
      continue;
    const label = m[1].trim();
    const value = m[2].trim().replace(/\*+/g, "");
    let numericPercent;
    const pctMatch = /^(\d+(?:\.\d+)?)\s*%$/.exec(value);
    const ratioMatch = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(?:\b|$)/.exec(value);
    if (pctMatch?.[1]) {
      const p = Number(pctMatch[1]);
      if (p >= 0 && p <= 100)
        numericPercent = p;
    } else if (ratioMatch?.[1] && ratioMatch[2]) {
      const num = Number(ratioMatch[1]);
      const den = Number(ratioMatch[2]);
      if (den > 0 && num >= 0 && num <= den) {
        numericPercent = Number((num / den * 100).toFixed(1));
      }
    }
    const tone = inferStatusTone(value);
    items.push({
      label,
      value,
      ...numericPercent !== undefined ? { numericPercent } : {},
      ...tone ? { tone } : {}
    });
    usedLines.add(i);
  }
  if (items.length < 3)
    return { items: [], prose: "" };
  const prose = lines.filter((_, idx) => !usedLines.has(idx)).map((l) => l.trim()).filter(Boolean).join(`
`);
  return { items: items.slice(0, 14), prose };
}
function extractStepCandidates(text) {
  const nonEmptyLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const rawLine of nonEmptyLines) {
    const line = rawLine.replace(/^`+|`+$/g, "").trim();
    if ((line.match(/->|→|⇒/g) ?? []).length >= 2 && line.length <= 260) {
      const parts = line.split(/\s*(?:->|→|⇒)\s*/).map((s) => s.replace(/^`+|`+$/g, "").trim()).filter(Boolean);
      if (parts.length >= 3 && parts.length <= 10) {
        const items = parts.map((p, idx) => ({
          title: p,
          status: idx === 0 ? "current" : "todo"
        }));
        const prose = nonEmptyLines.filter((l) => l !== rawLine).join(`
`);
        return { items, prose };
      }
    }
  }
  const lines = text.split(/\r?\n/);
  const stepRegex = /^(?:(\d+)[.)]\s+|[-*]\s*\[([ xX✓>-])\]\s+|(?:Step|Stage|Phase)\s+\d+\s*[:—-]\s*)(.+)$/i;
  const items = [];
  const used = new Set;
  for (let i = 0;i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    const m = stepRegex.exec(trimmed);
    if (!m?.[3])
      continue;
    const checkbox = m[2]?.toLowerCase();
    let body = m[3].trim();
    let status = "todo";
    if (checkbox === "x" || checkbox === "✓" || /\((?:done|completed|complete|passed)\)\s*$/i.test(body)) {
      status = "done";
    } else if (checkbox === ">" || checkbox === "-" || /\((?:current|running|in[- ]progress|active)\)\s*$/i.test(body)) {
      status = "current";
    } else if (/\((?:blocked|failed|error)\)\s*$/i.test(body)) {
      status = "blocked";
    }
    body = body.replace(/\s*\((?:done|completed|complete|passed|current|running|in[- ]progress|active|blocked|failed|error|todo|pending)\)\s*$/i, "");
    const splitIdx = body.indexOf(": ");
    const title = (splitIdx > 0 && splitIdx <= 84 ? body.slice(0, splitIdx) : body).replace(/\*+/g, "").trim();
    const detail = splitIdx > 0 && splitIdx <= 84 ? body.slice(splitIdx + 2).trim() : undefined;
    items.push({
      title,
      ...detail ? { detail } : {},
      status
    });
    used.add(i);
  }
  if (items.length < 3)
    return { items: [], prose: "" };
  const prose = lines.filter((_, idx) => !used.has(idx)).map((l) => l.trim()).filter(Boolean).join(`
`);
  return { items: items.slice(0, 12), prose };
}
function stripConsumedMarkdownTable(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let inTable = false;
  for (let i = 0;i < lines.length; i += 1) {
    const cur = (lines[i] ?? "").trim();
    const next = (lines[i + 1] ?? "").trim();
    if (!inTable && cur.includes("|") && /^\|?[\s:-]+\|[\s|:-]+$/.test(next)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      if (cur.includes("|"))
        continue;
      inTable = false;
    }
    if (cur && !/^#{1,4}\s+/.test(cur)) {
      kept.push(cur);
    }
  }
  return kept.join(`
`);
}
function extractArbitraryCandidates(rawContent) {
  const trimmed = rawContent.trim();
  const directDataset = extractStructuredDataset(trimmed);
  let dataset = directDataset;
  let datasetProse = "";
  if (directDataset) {
    if (directDataset.sourceKind === "markdown_table") {
      datasetProse = stripConsumedMarkdownTable(trimmed);
    }
  } else {
    const cli = tryExtractCliColumns(trimmed);
    if (cli) {
      dataset = cli.dataset;
      datasetProse = cli.prose;
    } else {
      const proseList = tryExtractProseMetricList(trimmed);
      if (proseList) {
        dataset = proseList.dataset;
        datasetProse = proseList.prose;
      }
    }
  }
  const rawSteps = extractStepCandidates(trimmed);
  const isLongMultiSectionDoc = trimmed.length > 1500 && (trimmed.match(/^#{1,3}\s+/gm) ?? []).length >= 3;
  const steps = isLongMultiSectionDoc && rawSteps.prose.length > trimmed.length * 0.8 ? { items: [], prose: "" } : rawSteps;
  if (isLongMultiSectionDoc && dataset && datasetProse.length > trimmed.length * 0.8) {
    dataset = null;
    datasetProse = "";
  }
  const rawKv = dataset || steps.items.length >= 3 ? { items: [], prose: "" } : extractKeyValueCandidates(trimmed);
  const kv = isLongMultiSectionDoc && rawKv.prose.length > trimmed.length * 0.8 ? { items: [], prose: "" } : rawKv;
  const accompanyingProse = dataset ? datasetProse : steps.items.length > 0 ? steps.prose : kv.items.length > 0 ? kv.prose : "";
  return {
    rawContent: trimmed,
    dataset,
    kvItems: kv.items,
    stepItems: steps.items,
    accompanyingProse
  };
}
function emitVerbatimOpenUi(rawContent) {
  return `root = Stack([body])
body = Text(${JSON.stringify(rawContent)})`;
}
function emitKvOpenUi(items, prose, keepProse) {
  const children = [];
  const lines = [];
  const gaugeItems = items.filter((i) => i.numericPercent !== undefined).slice(0, 4);
  const statusItems = items.filter((i) => i.tone !== undefined).slice(0, 3);
  if (statusItems.length > 0) {
    const statIds = statusItems.map((item, idx) => {
      const id = `st_${idx + 1}`;
      lines.push(`${id} = Stat(${JSON.stringify(item.label)}, ${JSON.stringify(item.value)}, "", ${JSON.stringify(item.tone ?? "neutral")})`);
      return id;
    });
    children.push("stats");
    lines.push(`stats = Row([${statIds.join(", ")}])`);
  }
  if (gaugeItems.length > 0) {
    gaugeItems.forEach((g, idx) => {
      const pid = `pg_${idx + 1}`;
      children.push(pid);
      lines.push(`${pid} = Progress(${JSON.stringify(g.label)}, ${g.numericPercent})`);
    });
  }
  const kvPairs = items.map((i) => ({ label: i.label, value: i.value }));
  children.push("kv");
  lines.push(`kv = KeyValue(${JSON.stringify(kvPairs)})`);
  if (keepProse && prose.trim()) {
    children.push("note");
    lines.push(`note = Text(${JSON.stringify(prose.trim())})`);
  }
  return [`root = Stack([${children.join(", ")}])`, ...lines].join(`
`);
}
function emitStepsOpenUi(items, prose, keepProse) {
  const children = ["flow"];
  const stepObjs = items.map((s) => ({
    title: s.title,
    ...s.detail ? { markdown: s.detail } : {},
    status: s.status
  }));
  const lines = [`flow = Steps(${JSON.stringify(stepObjs)}, "column")`];
  if (keepProse && prose.trim()) {
    children.push("note");
    lines.push(`note = Text(${JSON.stringify(prose.trim())})`);
  }
  return [`root = Stack([${children.join(", ")}])`, ...lines].join(`
`);
}
async function evaluateAutoVisual(params) {
  const started = Date.now();
  const candidates = extractArbitraryCandidates(params.content);
  const intent = params.intent?.trim() ?? "";
  const lowerIntent = intent.toLowerCase();
  const availableModes = ["verbatim"];
  if (candidates.dataset && candidates.dataset.columns.some((c) => c.kind === "number")) {
    availableModes.push("chart");
  }
  if (candidates.kvItems.length >= 3) {
    availableModes.push("stats_kv");
  }
  if (candidates.stepItems.length >= 3) {
    availableModes.push("steps_flow");
  }
  if (availableModes.length === 1) {
    const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
    return {
      ok: true,
      mode: "verbatim",
      shouldVisualizeProbability: 0,
      modeConfidence: 1,
      ms: 0,
      questionCount: 0,
      rawContent: candidates.rawContent,
      keepProse: true,
      accompanyingProse: "",
      availableModes,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
    };
  }
  if (params.forceMode === "verbatim" || lowerIntent === "verbatim" || lowerIntent === "raw text") {
    const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
    return {
      ok: true,
      mode: "verbatim",
      shouldVisualizeProbability: 0,
      manualOverride: true,
      modeConfidence: 1,
      ms: Date.now() - started,
      questionCount: 0,
      rawContent: candidates.rawContent,
      keepProse: true,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      ...candidates.kvItems.length > 0 ? { kvItems: candidates.kvItems } : {},
      ...candidates.stepItems.length > 0 ? { stepItems: candidates.stepItems } : {},
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
    };
  }
  const explicitChartEdit = params.forceMode === "chart" || /\b(?:bar_ranked|bar_whole_share|whole share|line_trend|line chart|progress_bars|sort asc|sort desc|ranked bar)\b/i.test(intent);
  if (explicitChartEdit && candidates.dataset) {
    const compiled = await compileDatasetToUi({
      dataset: candidates.dataset,
      ...intent ? { editInstruction: intent } : {},
      client: params.client,
      timeoutMs: params.timeoutMs ?? 3500
    });
    const openUiSource = candidates.accompanyingProse.trim().length > 0 ? compiled.source.replace(/^root = Stack\(\[([^\]]*)\]\)/, (_, inner) => `root = Stack([${inner ? `${inner}, ` : ""}prose_note])`) + `
prose_note = Text(${JSON.stringify(candidates.accompanyingProse.trim())})` : compiled.source;
    return {
      ok: true,
      mode: "chart",
      shouldVisualizeProbability: 0.99,
      manualOverride: Boolean(params.forceMode),
      modeConfidence: 1,
      ms: Date.now() - started,
      questionCount: compiled.plan.questionCount,
      rawContent: candidates.rawContent,
      keepProse: Boolean(candidates.accompanyingProse.trim()),
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      compiled,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
    };
  }
  const visualCandidates = availableModes.filter((m) => m !== "verbatim");
  const familyCriteria = {};
  if (visualCandidates.includes("chart")) {
    familyCriteria.chart = "Quantitative chart (BarChart, LineChart, or Progress) + hero Stats/Table for multi-item numeric comparisons, CLI tables, or trends.";
  }
  if (visualCandidates.includes("stats_kv")) {
    familyCriteria.stats_kv = "Structured KeyValue pairs with hero Stat badges and utilization Progress bars for heterogeneous system/status readouts.";
  }
  if (visualCandidates.includes("steps_flow")) {
    familyCriteria.steps_flow = "Connected Steps workflow diagram showing status (done, current, todo, blocked) across sequential stages.";
  }
  const questions = {
    should_visualize: {
      type: "noul",
      instructions: `${intent ? `Context/intent: "${intent}". ` : ""}Would rendering a native visual UI block (chart/bars, key-value gauges, or step flow) improve scannability over repeating the raw text verbatim?`,
      criteria: {
        true_description: "Tabular CLI command output (df, ps, docker, benchmarks), multi-item quantitative comparisons, utilization breakdowns, structured status KV dumps, or multi-stage checklists/pipelines.",
        false_description: "Narrative prose, debugging explanations, source code snippets, or conversational paragraphs where a visual widget would add noise."
      }
    },
    ...visualCandidates.length >= 2 ? {
      visual_family: {
        type: "choice",
        instructions: `${intent ? `Honor intent "${intent}" if applicable. ` : ""}Which visual family fits this output best?`,
        criteria: familyCriteria
      }
    } : {},
    ...candidates.accompanyingProse.trim() ? {
      keep_prose: {
        type: "noul",
        instructions: "Does the surrounding text outside the extracted items carry non-redundant explanation/context worth keeping below the visual?",
        criteria: {
          true_description: "Surrounding prose explains root causes, caveats, conclusions, or action items not shown in the numbers.",
          false_description: 'Surrounding text is just a generic lead-in like "Here are the results:".'
        }
      }
    } : {},
    ...candidates.dataset ? buildCompilerQuestions(candidates.dataset, intent) : {}
  };
  const questionCount = Object.keys(questions).length;
  const candidateSummary = [
    intent ? `Agent/User Intent: ${intent}` : "",
    `Available candidate structures: ${availableModes.join(", ")}`,
    candidates.dataset ? `Extracted dataset: ${candidates.dataset.rows.length} rows x ${candidates.dataset.columns.map((c) => `${c.name}(${c.kind})`).join(", ")}` : "",
    candidates.kvItems.length > 0 ? `Extracted KV pairs: ${candidates.kvItems.length}` : "",
    candidates.stepItems.length > 0 ? `Extracted steps: ${candidates.stepItems.length}` : "",
    `Raw Content:
${candidates.rawContent.slice(0, 5000)}`
  ].filter(Boolean).join(`

`);
  const batch = await params.client.evaluate({
    input: candidateSummary,
    questions,
    timeoutMs: params.timeoutMs ?? 3800
  });
  const ms = Date.now() - started;
  if (!batch.ok) {
    const fbMode = params.forceMode ?? (availableModes.includes("chart") ? "chart" : availableModes.includes("steps_flow") ? "steps_flow" : availableModes.includes("stats_kv") ? "stats_kv" : "verbatim");
    return buildResultForChosenMode({
      chosenMode: fbMode,
      shouldVisProb: fbMode === "verbatim" ? 0.1 : 0.8,
      modeConf: 1,
      keepProse: Boolean(candidates.accompanyingProse.trim()),
      ms,
      questionCount,
      candidates,
      availableModes,
      batch: null,
      intent
    });
  }
  const shouldVis = getNoulAnswer(batch, "should_visualize", 0.5);
  const defaultFamily = visualCandidates[0] ?? "chart";
  const familyAns = visualCandidates.length >= 2 ? getChoiceAnswer(batch, "visual_family", visualCandidates, defaultFamily) : { choice: defaultFamily, confidence: shouldVis.confidence };
  const keepProseAns = candidates.accompanyingProse.trim() ? getNoulAnswer(batch, "keep_prose", 0.7) : { probability: 0, confidence: 1 };
  const chosenMode = params.forceMode && availableModes.includes(params.forceMode) ? params.forceMode : shouldVis.probability < 0.5 ? "verbatim" : familyAns.choice;
  return buildResultForChosenMode({
    chosenMode,
    shouldVisProb: shouldVis.probability,
    modeConf: familyAns.confidence,
    keepProse: keepProseAns.probability >= 0.45,
    ms,
    questionCount,
    candidates,
    availableModes,
    batch,
    intent
  });
}
function buildResultForChosenMode(params) {
  const { chosenMode, candidates, keepProse, availableModes } = params;
  if (chosenMode === "chart" && candidates.dataset) {
    const dataset = candidates.dataset;
    const fbPlan = buildFallbackCompilerPlan(dataset, params.intent, params.ms);
    let plan = fbPlan;
    if (params.batch?.ok) {
      const chartAns = getChoiceAnswer(params.batch, "chart_kind", ["bar_ranked", "bar_whole_share", "line_trend", "progress_bars", "stat_tiles_only"], fbPlan.chartKind);
      const incTable = getNoulAnswer(params.batch, "include_table", fbPlan.includeTable ? 0.8 : 0.2);
      const incStats = getNoulAnswer(params.batch, "include_stats", fbPlan.includeStats ? 0.8 : 0.2);
      const sortAns = getChoiceAnswer(params.batch, "sort_order", ["preserve", "desc_primary", "asc_primary"], fbPlan.sortOrder);
      const labelKeys = dataset.columns.map((c) => c.safeKey);
      const defKey = dataset.columns[fbPlan.labelColumnIndex]?.safeKey ?? labelKeys[0] ?? "";
      const labelAns = labelKeys.length >= 2 ? getChoiceAnswer(params.batch, "label_col", labelKeys, defKey) : { choice: defKey, confidence: 1 };
      const chosenLabel = dataset.columns.find((c) => c.safeKey === labelAns.choice) ?? dataset.columns[fbPlan.labelColumnIndex] ?? dataset.columns[0];
      const roles = {};
      for (const col of dataset.columns) {
        if (col.kind !== "number" || col.index === chosenLabel.index)
          continue;
        const rAns = getChoiceAnswer(params.batch, `role_${col.index}`, ["primary_series", "secondary_series", "hero_stat", "table_only", "omit"], fbPlan.columnRoles[col.index] ?? "table_only");
        roles[col.index] = rAns.choice;
      }
      plan = {
        chartKind: chartAns.choice,
        chartConfidence: chartAns.confidence,
        includeTable: incTable.probability >= 0.5,
        includeStats: incStats.probability >= 0.5,
        sortOrder: sortAns.choice,
        labelColumnIndex: chosenLabel.index,
        columnRoles: roles,
        ms: params.ms,
        questionCount: params.questionCount,
        usedFallbackHeuristics: false
      };
    }
    const chartSource = emitOpenUiProgram(dataset, plan);
    const lint = lintOpenUiSource(chartSource);
    const compiled = {
      ok: lint.valid,
      source: chartSource,
      fencedMarkdown: `\`\`\`openui-lang
${chartSource}
\`\`\``,
      dataset,
      plan,
      lint
    };
    const fullSource = keepProse && candidates.accompanyingProse.trim() ? chartSource.replace(/^root = Stack\(\[([^\]]*)\]\)/, (_, inner) => `root = Stack([${inner ? `${inner}, ` : ""}prose_note])`) + `
prose_note = Text(${JSON.stringify(candidates.accompanyingProse.trim())})` : chartSource;
    return {
      ok: true,
      mode: "chart",
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      compiled,
      openUiSource: fullSource,
      fencedMarkdown: `\`\`\`openui-lang
${fullSource}
\`\`\``
    };
  }
  if (chosenMode === "stats_kv" && candidates.kvItems.length > 0) {
    const openUiSource = emitKvOpenUi(candidates.kvItems, candidates.accompanyingProse, keepProse);
    return {
      ok: true,
      mode: "stats_kv",
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      kvItems: candidates.kvItems,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
    };
  }
  if (chosenMode === "steps_flow" && candidates.stepItems.length > 0) {
    const openUiSource = emitStepsOpenUi(candidates.stepItems, candidates.accompanyingProse, keepProse);
    return {
      ok: true,
      mode: "steps_flow",
      shouldVisualizeProbability: params.shouldVisProb,
      modeConfidence: params.modeConf,
      ms: params.ms,
      questionCount: params.questionCount,
      rawContent: candidates.rawContent,
      keepProse,
      accompanyingProse: candidates.accompanyingProse,
      availableModes,
      stepItems: candidates.stepItems,
      openUiSource,
      fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
    };
  }
  const openUiSource = emitVerbatimOpenUi(candidates.rawContent);
  return {
    ok: true,
    mode: "verbatim",
    shouldVisualizeProbability: params.shouldVisProb,
    modeConfidence: params.modeConf,
    ms: params.ms,
    questionCount: params.questionCount,
    rawContent: candidates.rawContent,
    keepProse: true,
    accompanyingProse: candidates.accompanyingProse,
    availableModes,
    ...candidates.kvItems.length > 0 ? { kvItems: candidates.kvItems } : {},
    ...candidates.stepItems.length > 0 ? { stepItems: candidates.stepItems } : {},
    openUiSource,
    fencedMarkdown: `\`\`\`openui-lang
${openUiSource}
\`\`\``
  };
}

// src/core/visual-critic.ts
var VISUAL_DEFECT_CHOICES = [
  "blank_or_script_error",
  "horizontal_overflow",
  "low_theme_contrast",
  "none",
  "outer_card_border_chrome",
  "text_or_svg_collision"
];
function buildVisualCriticQuestions() {
  return {
    has_clipping: {
      type: "noul",
      instructions: "Looking at both the 360px phone viewport (first image) and 720px desktop viewport (second image), is there visible text/SVG label collision, clipped content, overlapping boxes, or horizontal truncation?",
      criteria: {
        true_description: "Labels overlap, boxes or SVG graphics clip at the viewport edge, or controls collide.",
        false_description: "All text, diagrams, and controls fit cleanly inside both 360px and 720px viewports without overlap or clipping."
      }
    },
    is_blank: {
      type: "noul",
      instructions: "Does either rendered viewport appear blank, visually empty, or broken (missing intended drawing/UI)?",
      criteria: {
        true_description: "Canvas/page is blank, nearly empty, or shows broken/unrendered output.",
        false_description: "The intended interface or drawing is clearly visible and populated."
      }
    },
    mobile_fit: {
      type: "score",
      instructions: "Rate how cleanly the layout adapts to the 360px mobile viewport (first image).",
      criteria: [
        "Broken on mobile: severe horizontal cutoff, crushed columns, or unreadable overlapping text.",
        "Cramped on mobile: squeezed multi-column layout or minor edge clipping.",
        "Acceptable mobile fit: readable and usable with minor spacing compromises.",
        "Clean responsive fit: stacks or wraps naturally at 360px with balanced spacing."
      ]
    },
    contrast_legibility: {
      type: "score",
      instructions: "Rate text and graphic contrast/legibility against the dark OpenChamber background.",
      criteria: [
        "Illegible: dark-on-dark or light-on-light text that cannot be read.",
        "Poor contrast: key labels or diagram lines are washed out or hard to read.",
        "Readable: clear contrast across primary and secondary elements.",
        "Crisp hierarchy: strong contrast, clear tone separation, and clean typography."
      ]
    },
    primary_defect: {
      type: "choice",
      instructions: 'Identify the single most significant visual issue across the 360px and 720px renders, or "none" if clean.',
      criteria: {
        blank_or_script_error: "Empty/blank frame or failed canvas/SVG render.",
        horizontal_overflow: "Fixed-width layout or wide row overflowing past the 360px or 720px column.",
        low_theme_contrast: "Unreadable dark-on-dark or low-contrast text/strokes due to missing theme colors.",
        none: "Clean render with good contrast, legibility, and 360px/720px fit.",
        outer_card_border_chrome: "Unwanted outer wrapper card border/banner header fighting OpenChamber chat framing.",
        text_or_svg_collision: "Overlapping SVG labels, clipped diagram elements, or colliding controls."
      }
    }
  };
}
async function evaluateVisualCritic(params) {
  const started = Date.now();
  const findings = [];
  for (const vp of params.viewports) {
    if (vp.pageErrors.length > 0) {
      findings.push({
        source: "dom",
        severity: "error",
        code: `js_error_${vp.width}px`,
        message: `Uncaught runtime error at ${vp.width}px: ${vp.pageErrors[0]}`
      });
    }
    if (vp.isCollapsedOrEmpty) {
      findings.push({
        source: "dom",
        severity: "error",
        code: `empty_render_${vp.width}px`,
        message: `Rendered page at ${vp.width}px has zero visible content or collapsed height (${vp.scrollHeight}px).`
      });
    } else if (vp.hasHorizontalOverflow) {
      findings.push({
        source: "dom",
        severity: "warning",
        code: `horizontal_overflow_${vp.width}px`,
        message: `Horizontal overflow at ${vp.width}px viewport: scrollWidth=${vp.scrollWidth}px exceeds clientWidth=${vp.clientWidth}px. Stack or wrap elements for 360px phone fit.`
      });
    }
  }
  const blocks = [];
  for (const vp of params.viewports) {
    if (vp.pngBase64) {
      blocks.push({
        type: "image",
        mime_type: "image/png",
        data: vp.pngBase64,
        resolution: "medium"
      });
    }
  }
  const domSummary = params.viewports.map((vp, idx) => `Image ${idx + 1}: viewport=${vp.width}x${vp.height}px, scrollWidth=${vp.scrollWidth}px, scrollHeight=${vp.scrollHeight}px, overflow=${vp.hasHorizontalOverflow}, jsErrors=${JSON.stringify(vp.pageErrors)}`).join(`
`);
  blocks.push({
    type: "text",
    text: [
      params.title ? `Rendered HTML Title: ${params.title}` : "Rendered OpenChamber HTML Page",
      domSummary,
      `HTML Excerpt:
${params.htmlSource.slice(0, 3000)}`
    ].join(`

`)
  });
  const batch = await params.client.evaluate({
    input: blocks,
    questions: buildVisualCriticQuestions(),
    timeoutMs: params.timeoutMs ?? 4500
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
      primaryDefect: "none",
      primaryDefectConfidence: 0,
      viewports: params.viewports.map((vp) => ({
        width: vp.width,
        scrollWidth: vp.scrollWidth,
        scrollHeight: vp.scrollHeight,
        hasHorizontalOverflow: vp.hasHorizontalOverflow,
        pageErrors: vp.pageErrors,
        ...params.includeDataUrls && vp.pngBase64 ? { pngDataUrl: `data:image/png;base64,${vp.pngBase64}` } : {}
      })),
      findings
    };
  }
  const clipping = getNoulAnswer(batch, "has_clipping", 0);
  const blank = getNoulAnswer(batch, "is_blank", 0);
  const mobileFit = getScoreAnswer(batch, "mobile_fit", 3);
  const contrast = getScoreAnswer(batch, "contrast_legibility", 3);
  const defect = getChoiceAnswer(batch, "primary_defect", VISUAL_DEFECT_CHOICES, "none");
  const threshold = params.config.advisoryThreshold;
  if (blank.probability >= threshold) {
    findings.push({
      source: "visual_critic",
      severity: "error",
      code: "visual_blank_or_broken",
      probability: blank.probability,
      message: `Multimodal Visual Critic flagged blank/broken render (p=${blank.probability.toFixed(2)}). Check script initialization, SVG viewBox/height, and theme colors.`
    });
  }
  if (clipping.probability >= threshold) {
    findings.push({
      source: "visual_critic",
      severity: "warning",
      code: "visual_clipping_or_overlap",
      probability: clipping.probability,
      message: `Multimodal Visual Critic detected text/SVG collision or clipping across 360px/720px renders (p=${clipping.probability.toFixed(2)}, primary=${defect.choice}).`
    });
  }
  if (mobileFit.score < 1.55) {
    findings.push({
      source: "visual_critic",
      severity: "warning",
      code: "poor_mobile_360_fit",
      message: `360px phone layout scored ${mobileFit.score.toFixed(2)}/3.00: stack multi-column boxes vertically on narrow viewports.`
    });
  }
  if (contrast.score < 1.55) {
    findings.push({
      source: "visual_critic",
      severity: "warning",
      code: "low_contrast_legibility",
      message: `Contrast/legibility scored ${contrast.score.toFixed(2)}/3.00 against dark theme: ensure custom surfaces set explicit foreground colors or use var(--foreground) / var(--muted-foreground).`
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
      ...params.includeDataUrls && vp.pngBase64 ? { pngDataUrl: `data:image/png;base64,${vp.pngBase64}` } : {}
    })),
    findings
  };
}

// src/core/render-gate.ts
function summarizeHtmlForPolicyCheck(html) {
  if (html.length <= 9000)
    return html;
  const slimmedCss = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => `<style>/* ${css.length} chars of CSS omitted */</style>`);
  return slimmedCss.slice(0, 9000);
}
function buildHtmlPolicyQuestions() {
  return {
    is_data_in_html: {
      type: "noul",
      instructions: "Is this HTML page JUST a plain data chart, simple Markdown-style table, or static metric comparison that OpenChamber's built-in openui-lang components (BarChart, LineChart, Table, Stat, Card) could draw directly—as opposed to a bespoke application/dashboard UI mockup with custom interactive trays, sparklines, status pills, or layout design?",
      criteria: {
        true_description: "A plain static data table, basic bar/line chart, or KPI list with no bespoke product UI layout, interactive drawers/trays, or custom visual design.",
        false_description: "An application UI mockup (including dashboard/matrix UI designs with expandable failure trays, inline spark-strips, custom toolbars, or interactive state) or custom SVG diagram that openui-lang cannot express."
      }
    },
    has_viewport_height_bug: {
      type: "noul",
      instructions: "Does the HTML/CSS use 100vh or height:100% on html/body or wrap the entire root in an unnecessary outer card border/banner title against OpenChamber render rules?",
      criteria: {
        true_description: "Uses 100vh / height:100% on html/body or adds a redundant outer card border and banner header around the entire page.",
        false_description: "Uses content-driven or fixed drawing pixel heights and sits cleanly on the chat background."
      }
    }
  };
}
function buildUiPolicyQuestions(awaitAnswer) {
  return {
    tufte_quality: {
      type: "score",
      instructions: "Rate the communication & data-ink clarity of this openui-lang block (clear visual hierarchy, concise labels, meaningful chart/control selection, non-redundant structure).",
      criteria: [
        "Cluttered or mismatched: wrong chart type (e.g. LineChart for unordered categories or whole=true on non-additive numbers) or verbose wall-of-text cards.",
        "Mediocre: verbose labels or redundant components.",
        "Good: appropriate component choices and readable labels.",
        "High data-ink clarity: crisp Tufte pairing of visuals and numbers with concise scannable labels."
      ]
    },
    ...awaitAnswer ? {
      is_trivial_yes_no: {
        type: "noul",
        instructions: "Is this waiting UI page asking a trivial single-question closed clarification where free-form user conditions add no value (better suited to the lightweight question tool)?",
        criteria: {
          true_description: "Trivial binary/closed factual clarification with no scope/trade-off nuance.",
          false_description: "Direction-setting scope, design, or trade-off choice where user condition notes are helpful."
        }
      }
    } : {}
  };
}
function buildQuestionToolPolicyQuestions() {
  return {
    needs_render_ui_await: {
      type: "noul",
      instructions: "Is this `question` tool call asking the user to make an architectural, scope, or trade-off decision that sets the direction of the work (where OpenChamber rules require `openchamber_render` with `ui` and `awaitAnswer: true` so the user can add condition notes)?",
      criteria: {
        true_description: "Sets project direction, architecture, scope, or trade-offs where the user may want to attach conditions/constraints to their pick.",
        false_description: "Quick, self-contained clarification fully answered by picking one of the listed options."
      }
    }
  };
}
function formatAdvisoryNote(findings) {
  if (findings.length === 0)
    return null;
  const bullets = findings.map((f) => {
    const tag = f.source === "visual_critic" || f.source === "dom" ? "Visual Critic" : f.source === "ast" ? "AST Lint" : "Policy Gate";
    return `- [${tag} · ${f.severity}] ${f.message}`;
  });
  return [
    "[Decision UI Advisory]",
    ...bullets,
    "If any issue above degrades usability or violates the surface contract, re-render cleanly before concluding; otherwise continue."
  ].join(`
`);
}
async function evaluateRenderGate(params) {
  const started = Date.now();
  const findings = [];
  const threshold = params.config.advisoryThreshold;
  if (params.targetTool === "question") {
    const serialized = JSON.stringify(params.rawInput).slice(0, 4000);
    if (params.config.renderGateEnabled) {
      const batch = await params.client.evaluate({
        input: `Tool call: question
Input:
${serialized}`,
        questions: buildQuestionToolPolicyQuestions(),
        timeoutMs: 2200
      });
      if (batch.ok) {
        const check = getNoulAnswer(batch, "needs_render_ui_await", 0);
        if (check.probability >= threshold) {
          findings.push({
            source: "decision",
            severity: "warning",
            code: "prefer_render_ui_await",
            probability: check.probability,
            message: `Direction-setting choice detected on \`question\` tool (p=${check.probability.toFixed(2)}): prefer \`openchamber_render\` with \`ui\` (\`openui-lang\`) and \`awaitAnswer: true\` next time so the user can attach conditions in \`data.note\`.`
          });
        }
      }
    }
    const advisoryNote = formatAdvisoryNote(findings);
    return {
      targetTool: "question",
      mode: "question",
      clean: findings.length === 0,
      ms: Date.now() - started,
      findings,
      advisoryNote
    };
  }
  const nestedParams = params.rawInput.parameters && typeof params.rawInput.parameters === "object" && !Array.isArray(params.rawInput.parameters) ? params.rawInput.parameters : {};
  const merged = { ...params.rawInput, ...nestedParams };
  const ui = typeof merged.ui === "string" ? merged.ui.trim() : "";
  const html = typeof merged.html === "string" ? merged.html.trim() : "";
  const title = typeof merged.title === "string" ? merged.title.trim() : undefined;
  const awaitAnswer = merged.awaitAnswer === true || merged.awaitAnswer === "true";
  if (ui) {
    const astLint = lintOpenUiSource(ui);
    for (const issue of astLint.issues) {
      findings.push({
        source: "ast",
        severity: issue.severity,
        code: issue.code,
        message: issue.line ? `Line ${issue.line}: ${issue.message}` : issue.message
      });
    }
    if (params.config.renderGateEnabled) {
      const batch = await params.client.evaluate({
        input: `openchamber_render (ui, awaitAnswer=${awaitAnswer}, title=${title ?? "none"}):
${ui.slice(0, 6000)}`,
        questions: buildUiPolicyQuestions(awaitAnswer),
        timeoutMs: 2500
      });
      if (batch.ok) {
        const tufte = getScoreAnswer(batch, "tufte_quality", 3);
        if (tufte.score < 1.4) {
          findings.push({
            source: "decision",
            severity: "warning",
            code: "low_tufte_clarity",
            message: `openui-lang communication/Tufte clarity scored ${tufte.score.toFixed(2)}/3.00: verify chart type matches data semantics and trim verbose card text.`
          });
        }
      }
    }
    const advisoryNote = formatAdvisoryNote(findings);
    return {
      targetTool: "openchamber_render",
      mode: "ui",
      clean: findings.length === 0,
      ms: Date.now() - started,
      findings,
      advisoryNote,
      astLint
    };
  }
  let visualCritic;
  const htmlPolicyPromise = params.config.renderGateEnabled ? params.client.evaluate({
    input: `openchamber_render (html, awaitAnswer=${awaitAnswer}, title=${title ?? "none"}):
${summarizeHtmlForPolicyCheck(html)}`,
    questions: buildHtmlPolicyQuestions(),
    timeoutMs: 3000
  }) : Promise.resolve(null);
  const criticPromise = params.config.visualCriticEnabled && params.captureHtml && html.length > 0 ? params.captureHtml(html).then((viewports) => evaluateVisualCritic({
    viewports,
    htmlSource: html,
    ...title ? { title } : {},
    client: params.client,
    config: params.config,
    includeDataUrls: params.includeScreenshotsInResult === true
  })).catch(() => {
    return;
  }) : Promise.resolve(undefined);
  const [policyBatch, criticRes] = await Promise.all([htmlPolicyPromise, criticPromise]);
  if (/html\s*,\s*body[^}]*(?:100vh|height\s*:\s*100%)|body\s*\{[^}]*(?:100vh|height\s*:\s*100%)/i.test(html)) {
    findings.push({
      source: "ast",
      severity: "warning",
      code: "html_100vh_body",
      message: "HTML sets `100vh` or `height: 100%` on `html`/`body`; OpenChamber sizes frames to content height—use fixed pixel heights on drawings instead."
    });
  }
  if (policyBatch?.ok) {
    const dataInHtml = getNoulAnswer(policyBatch, "is_data_in_html", 0);
    if (dataInHtml.probability >= threshold) {
      findings.push({
        source: "decision",
        severity: "warning",
        code: "data_rendered_as_html",
        probability: dataInHtml.probability,
        message: `HTML appears to render charts/tables/comparisons (p=${dataInHtml.probability.toFixed(2)}), which OpenChamber rules reserve for \`openui-lang\` blocks ("Never for data").`
      });
    }
  }
  if (criticRes) {
    visualCritic = criticRes;
    findings.push(...criticRes.findings);
  }
  const advisoryNote = formatAdvisoryNote(findings);
  return {
    targetTool: "openchamber_render",
    mode: "html",
    clean: findings.length === 0,
    ms: Date.now() - started,
    findings,
    advisoryNote,
    ...visualCritic ? { visualCritic } : {}
  };
}
var MISSED_VISUAL_ARCHETYPES = [
  "bar_plus_table",
  "line_plus_stats",
  "none",
  "share_whole_bar",
  "steps_flow"
];
async function evaluateTurnEndMissedVisual(params) {
  const text = params.replyText.trim();
  if (!params.config.turnEndDetectorEnabled || text.length < 180 || /```openui(?:-lang)?/i.test(text)) {
    return { missed: false, probability: 0, archetype: "none", ms: 0 };
  }
  const numberMatches = text.match(/\b\d+(?:\.\d+)?%?\b/g) ?? [];
  const hasPipeTable = /\|.+\|\s*\n\s*\|[\s:-]+\|/.test(text);
  if (numberMatches.length < 4 && !hasPipeTable) {
    return { missed: false, probability: 0, archetype: "none", ms: 0 };
  }
  const batch = await params.client.evaluate({
    input: `Assistant reply:
${text.slice(0, 5000)}`,
    questions: {
      missed_visual: {
        type: "noul",
        instructions: "Did this plain-text assistant reply present a multi-item numerical comparison, Markdown numeric table, or metric breakdown that would be substantially clearer with an inline openui-lang visual companion (BarChart, LineChart, Progress, Stat)?",
        criteria: {
          true_description: "Contains a naked numeric Markdown table or dense multi-item metric comparison with no visual chart/stat block.",
          false_description: "Prose, code, logs, line numbers, or a brief 2-number mention that needs no chart."
        }
      },
      archetype: {
        type: "choice",
        instructions: "Which openui-lang visual would best complement this reply?",
        criteria: {
          bar_plus_table: "BarChart paired with Table across categories.",
          line_plus_stats: "LineChart with summary Stat tiles over time/sequence.",
          none: "Plain text is better.",
          share_whole_bar: "Whole-share BarChart adding up to 100%.",
          steps_flow: "Steps flow diagram."
        }
      }
    },
    timeoutMs: 2500
  });
  if (!batch.ok) {
    return { missed: false, probability: 0, archetype: "none", ms: batch.ms };
  }
  const missedAns = getNoulAnswer(batch, "missed_visual", 0);
  const archAns = getChoiceAnswer(batch, "archetype", MISSED_VISUAL_ARCHETYPES, "bar_plus_table");
  return {
    missed: missedAns.probability >= params.config.advisoryThreshold,
    probability: missedAns.probability,
    archetype: archAns.choice,
    ms: batch.ms
  };
}

// src/core/surface-router.ts
var ALLOWED_UI_SURFACES = [
  "plain_reply",
  "reply_ui_block",
  "reply_decision_cards",
  "render_ui_await",
  "render_html_mockup",
  "question_tool"
];
var ALLOWED_VISUAL_ARCHETYPES = [
  "none",
  "bar_plus_table",
  "share_whole_bar",
  "line_plus_stats",
  "steps_flow",
  "stat_summary",
  "choice_form",
  "custom_html"
];
function buildSurfaceRouterQuestions() {
  return {
    needs_ui: {
      type: "noul",
      instructions: "Would a high-quality response to the latest user request either render structured visual UI (charts, tables, metrics, architecture/step flows, HTML mockups) OR present an interactive user decision widget/form?",
      criteria: {
        true_description: "The user asks to compare items, inspect metrics/benchmarks/breakdowns, explain a multi-step flow/pipeline, mock up/design an interface, or weigh architectural options/trade-offs.",
        false_description: "The user asks for direct code edits, bug fixes, shell/git operations, file lookups, or a brief factual/code answer best shown as plain Markdown and code fences."
      }
    },
    surface: {
      type: "choice",
      instructions: "Select the single best OpenChamber response surface for the latest user request.",
      criteria: {
        plain_reply: "Plain Markdown prose and code blocks only; no UI blocks, forms, or HTML render pages needed.",
        question_tool: "Quick closed clarification question whose short options completely cover the answer, with no free-form conditions needed.",
        render_html_mockup: "openchamber_render with self-contained HTML/SVG for a visual UI mockup, layout preview, or custom drawing that UI blocks cannot express (never for data charts/tables).",
        render_ui_await: "openchamber_render with ui (openui-lang) and awaitAnswer: true for a direction-setting choice, scope decision, or trade-off where the user may add condition notes.",
        reply_decision_cards: "Inline openui-lang block in the reply with one stacked Card and action Buttons per item to collect decisions across multiple separate items.",
        reply_ui_block: "Inline fenced openui-lang block in the reply for structured data, comparisons, charts, tables, stats, or step flows."
      }
    },
    archetype: {
      type: "choice",
      instructions: "If a visual or interactive component is warranted, which primary composition fits best?",
      criteria: {
        bar_plus_table: "Ranked or grouped BarChart paired with a companion detail Table across categories.",
        choice_form: "Interactive Choice / Input / Slider / Button controls for collecting user direction.",
        custom_html: "Custom HTML/CSS/SVG visual mockup or diagram.",
        line_plus_stats: "LineChart over time or ordered steps paired with summary Stat tiles.",
        none: "No visual widget needed.",
        share_whole_bar: "BarChart with whole=true showing parts adding up to 100% / a total.",
        stat_summary: "Compact Row of Stat tiles with KeyValue or Progress bars.",
        steps_flow: "Steps flow joined by arrows showing stages, status, or request routing."
      }
    }
  };
}
var ARCHETYPE_HINTS = {
  none: "",
  bar_plus_table: "Prefer `BarChart` paired with a `Table` inside `Stack([...])` (never leave a numeric comparison table without a visual companion).",
  share_whole_bar: "Prefer `BarChart(labels, [Series(...)], unit, true)` (`whole = true`) paired with `Stat` or `Table` for part-of-whole shares.",
  line_plus_stats: "Prefer `Row([Stat(...), ...])` above `LineChart` inside `Stack([...])` for trends over time/sequence.",
  steps_flow: 'Prefer `Steps([...], "column")` (mobile-safe) paired with compact `Stat` or `Callout` nodes for flows and lifecycles.',
  stat_summary: "Prefer `Row([Stat(...), ...])` with `Progress` or `KeyValue` stacked directly under `Stack([...])`.",
  choice_form: "Use concise `Choice` options with descriptions where needed; keep `Card` titles and `Badge` labels to 1-2 words for 360px mobile screens.",
  custom_html: "Use `openchamber_render` with `html` for visual mockups/drawings only (never for charts or tables)."
};
var SURFACE_DIRECTIVES = {
  reply_ui_block: "Render quantitative comparisons, metrics, or multi-stage structure in a fenced ```openui-lang block (`root = Stack([...])`). You can either stream raw output/tables/metrics/steps directly into `AutoVisual(content, intent)` (which uses Gemini Decision 1 to draw an inline visual or keep text verbatim) or compose explicit `BarChart`/`LineChart`/`Steps`/`Stat`/`Table` nodes.",
  reply_decision_cards: "Present multi-item decisions as an inline ```openui-lang block with stacked `Card`s (`root = Stack([...])`), short 1-2 word titles/Badges, and adjacent `Button(label, variant, cardTitle)` controls.",
  render_ui_await: "If asking the user to choose scope, architecture, or trade-offs, call `openchamber_render` with `ui` (`openui-lang`) and `awaitAnswer: true` (never `question`) so the user can attach conditions in `data.note`.",
  render_html_mockup: "Use `openchamber_render` with `html` for the visual interface mockup or custom SVG drawing, leaving `html`/`body` backgroundless unless mocking up a standalone themed app.",
  question_tool: "If a quick closed-set clarification is required before acting, use `question`; if it sets project direction/trade-offs, upgrade to `openchamber_render(ui, awaitAnswer: true)`."
};
function interpretSurfaceRoute(batch, config) {
  if (!batch.ok) {
    return {
      needsUiProbability: 0.5,
      surface: "plain_reply",
      surfaceConfidence: 0,
      archetype: "none",
      archetypeConfidence: 0,
      action: "noop",
      directiveText: null,
      ms: batch.ms
    };
  }
  const needsUi = getNoulAnswer(batch, "needs_ui", 0.5);
  const surfaceAns = getChoiceAnswer(batch, "surface", ALLOWED_UI_SURFACES, "plain_reply");
  const archetypeAns = getChoiceAnswer(batch, "archetype", ALLOWED_VISUAL_ARCHETYPES, "none");
  if (needsUi.probability >= config.injectDirectiveMinProbability && surfaceAns.choice !== "plain_reply" && surfaceAns.confidence >= config.minChoiceConfidence) {
    const baseDirective = SURFACE_DIRECTIVES[surfaceAns.choice];
    const archetypeHint = archetypeAns.choice !== "none" && archetypeAns.confidence >= 0.4 ? ` ${ARCHETYPE_HINTS[archetypeAns.choice]}` : "";
    const directiveText = `<decision_ui_route surface="${surfaceAns.choice}" archetype="${archetypeAns.choice}">
${baseDirective}${archetypeHint}
</decision_ui_route>`;
    return {
      needsUiProbability: needsUi.probability,
      surface: surfaceAns.choice,
      surfaceConfidence: surfaceAns.confidence,
      archetype: archetypeAns.choice,
      archetypeConfidence: archetypeAns.confidence,
      action: "inject_user_tail",
      directiveText,
      ms: batch.ms
    };
  }
  return {
    needsUiProbability: needsUi.probability,
    surface: surfaceAns.choice,
    surfaceConfidence: surfaceAns.confidence,
    archetype: archetypeAns.choice,
    archetypeConfidence: archetypeAns.confidence,
    action: "noop",
    directiveText: null,
    ms: batch.ms
  };
}
async function evaluateSurfaceRoute(params) {
  const trimmed = params.latestUserText.trim();
  if (!trimmed) {
    return {
      needsUiProbability: 0,
      surface: "plain_reply",
      surfaceConfidence: 1,
      archetype: "none",
      archetypeConfidence: 1,
      action: "noop",
      directiveText: null,
      ms: 0
    };
  }
  const inputParts = [
    ...params.recentHistory?.trim() ? [`Recent conversation context:
${params.recentHistory.trim().slice(-2000)}`] : [],
    `Latest user request:
${trimmed.slice(0, 4000)}`
  ].join(`

`);
  const batch = await params.client.evaluate({
    input: inputParts,
    questions: buildSurfaceRouterQuestions(),
    timeoutMs: params.timeoutMs ?? 1500
  });
  return interpretSurfaceRoute(batch, params.config);
}

// src/node/config-store.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// src/core/types.ts
var DEFAULT_DECISION_UI_CONFIG = {
  bridgeUrl: "http://127.0.0.1:4006",
  model: "gemini-decision-1",
  loopbackPort: 4007,
  surfaceRouterEnabled: true,
  renderGateEnabled: true,
  visualCriticEnabled: true,
  turnEndDetectorEnabled: true,
  injectDirectiveMinProbability: 0.65,
  minChoiceConfidence: 0.48,
  advisoryThreshold: 0.65
};

// src/node/config-store.ts
function expandTildePath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed === "~")
    return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}
function renderTildePath(absPath) {
  const home = os.homedir();
  if (absPath === home)
    return "~";
  if (absPath.startsWith(`${home}/`))
    return `~/${absPath.slice(home.length + 1)}`;
  return absPath;
}
function resolveConfigFilePath(env = process.env) {
  const override = env.DECISION_UI_CONFIG_PATH?.trim();
  if (override)
    return expandTildePath(override);
  return path.join(os.homedir(), ".config", "openchamber", "decision-ui.json");
}
function clampProb(val, fallback) {
  const n = typeof val === "number" && Number.isFinite(val) ? val : fallback;
  return Math.min(0.99, Math.max(0.01, n));
}
function parseDecisionUiConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_DECISION_UI_CONFIG;
  }
  const rec = raw;
  return {
    bridgeUrl: typeof rec.bridgeUrl === "string" && rec.bridgeUrl.trim().length > 0 ? rec.bridgeUrl.trim().replace(/\/+$/, "") : DEFAULT_DECISION_UI_CONFIG.bridgeUrl,
    model: typeof rec.model === "string" && rec.model.trim().length > 0 ? rec.model.trim() : DEFAULT_DECISION_UI_CONFIG.model,
    loopbackPort: typeof rec.loopbackPort === "number" && Number.isInteger(rec.loopbackPort) && rec.loopbackPort >= 0 ? rec.loopbackPort : DEFAULT_DECISION_UI_CONFIG.loopbackPort,
    surfaceRouterEnabled: typeof rec.surfaceRouterEnabled === "boolean" ? rec.surfaceRouterEnabled : DEFAULT_DECISION_UI_CONFIG.surfaceRouterEnabled,
    renderGateEnabled: typeof rec.renderGateEnabled === "boolean" ? rec.renderGateEnabled : DEFAULT_DECISION_UI_CONFIG.renderGateEnabled,
    visualCriticEnabled: typeof rec.visualCriticEnabled === "boolean" ? rec.visualCriticEnabled : DEFAULT_DECISION_UI_CONFIG.visualCriticEnabled,
    turnEndDetectorEnabled: typeof rec.turnEndDetectorEnabled === "boolean" ? rec.turnEndDetectorEnabled : DEFAULT_DECISION_UI_CONFIG.turnEndDetectorEnabled,
    injectDirectiveMinProbability: clampProb(rec.injectDirectiveMinProbability, DEFAULT_DECISION_UI_CONFIG.injectDirectiveMinProbability),
    minChoiceConfidence: clampProb(rec.minChoiceConfidence, DEFAULT_DECISION_UI_CONFIG.minChoiceConfidence),
    advisoryThreshold: clampProb(rec.advisoryThreshold, DEFAULT_DECISION_UI_CONFIG.advisoryThreshold)
  };
}
function loadDecisionUiConfig(env = process.env) {
  const filePath = resolveConfigFilePath(env);
  try {
    if (!fs.existsSync(filePath))
      return DEFAULT_DECISION_UI_CONFIG;
    const content = fs.readFileSync(filePath, "utf8");
    return parseDecisionUiConfig(JSON.parse(content));
  } catch {
    return DEFAULT_DECISION_UI_CONFIG;
  }
}
function saveDecisionUiConfig(patch, env = process.env) {
  const current = loadDecisionUiConfig(env);
  const next = parseDecisionUiConfig({ ...current, ...patch });
  const filePath = resolveConfigFilePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}
`, "utf8");
  return next;
}

// src/node/headless-capture.ts
import { spawn } from "node:child_process";
import fs2 from "node:fs";
import os2 from "node:os";
import path2 from "node:path";
var OPENCHAMBER_HOST_PRELUDE_CSS = `
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
function injectHostThemeIntoHtml(rawHtml) {
  const viewportMeta = /<meta[^>]+name=["']viewport["']/i.test(rawHtml) ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">';
  const styleTag = `${viewportMeta}<style data-oc-host-theme>${OPENCHAMBER_HOST_PRELUDE_CSS}</style>`;
  if (/<head[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(/<head([^>]*)>/i, `<head$1>${styleTag}`);
  }
  if (/<html[\s>]/i.test(rawHtml)) {
    return rawHtml.replace(/<html([^>]*)>/i, `<html$1><head>${styleTag}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${styleTag}</head><body>${rawHtml}</body></html>`;
}
function discoverHeadlessChromeBinary() {
  const envBin = process.env.DECISION_UI_CHROME_BIN?.trim();
  if (envBin && fs2.existsSync(envBin))
    return envBin;
  const pwCache = path2.join(os2.homedir(), ".cache", "ms-playwright");
  if (fs2.existsSync(pwCache)) {
    try {
      const entries = fs2.readdirSync(pwCache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse();
      for (const dir of entries) {
        const candidate = path2.join(pwCache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell");
        if (fs2.existsSync(candidate))
          return candidate;
      }
      const fullEntries = fs2.readdirSync(pwCache).filter((name) => name.startsWith("chromium-")).sort().reverse();
      for (const dir of fullEntries) {
        const candidate = path2.join(pwCache, dir, "chrome-linux64", "chrome");
        if (fs2.existsSync(candidate))
          return candidate;
      }
    } catch {}
  }
  const systemCandidates = [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];
  for (const bin of systemCandidates) {
    if (fs2.existsSync(bin))
      return bin;
  }
  return null;
}

class CdpConnection {
  ws;
  nextId = 1;
  pending = new Map;
  listeners = new Map;
  constructor(ws) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (typeof msg.id === "number") {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message ?? "CDP error"));
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
      } catch {}
    });
    ws.addEventListener("close", () => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }
  static async connect(wsUrl, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error(`Timed out connecting to CDP at ${wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to CDP at ${wsUrl}`));
      });
    });
  }
  on(method, handler) {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
    return () => {
      const cur = this.listeners.get(method) ?? [];
      this.listeners.set(method, cur.filter((h) => h !== handler));
    };
  }
  send(method, params = {}, sessionId, timeoutMs = 4000) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP WebSocket is not open"));
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
        }
      });
      this.ws.send(JSON.stringify({
        id,
        method,
        params,
        ...sessionId ? { sessionId } : {}
      }));
    });
  }
  get isOpen() {
    return this.ws.readyState === WebSocket.OPEN;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}
var warmBrowser = null;
var launchingPromise = null;
async function getWarmBrowser() {
  if (warmBrowser && warmBrowser.cdp.isOpen && warmBrowser.proc.exitCode === null) {
    return warmBrowser;
  }
  if (launchingPromise)
    return launchingPromise;
  launchingPromise = (async () => {
    const binary = discoverHeadlessChromeBinary();
    if (!binary) {
      throw new Error("No headless Chrome / Chromium binary found for Visual Critic.");
    }
    const proc = spawn(binary, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise((resolve, reject) => {
      let stderrBuf = "";
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("Timed out waiting for headless Chrome DevTools endpoint."));
      }, 5000);
      proc.stderr?.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Headless Chrome exited early with code ${code ?? "unknown"}`));
      });
    });
    const cdp = await CdpConnection.connect(wsUrl);
    const handle = { proc, cdp };
    warmBrowser = handle;
    const cleanup = () => {
      if (warmBrowser === handle)
        warmBrowser = null;
      cdp.close();
      if (proc.exitCode === null) {
        proc.kill("SIGKILL");
      }
    };
    proc.once("exit", cleanup);
    process.once("exit", cleanup);
    return handle;
  })();
  try {
    return await launchingPromise;
  } finally {
    launchingPromise = null;
  }
}
async function closeWarmBrowser() {
  const current = warmBrowser;
  warmBrowser = null;
  if (!current)
    return;
  current.cdp.close();
  if (current.proc.exitCode === null) {
    current.proc.kill("SIGTERM");
  }
}
async function captureHtmlViewports(rawHtml, options = {}) {
  const widths = options.viewports ?? [360, 720];
  const maxHeight = options.maxHeight ?? 1400;
  const settleMs = options.settleMs ?? 90;
  const html = options.injectTheme === false ? rawHtml : injectHostThemeIntoHtml(rawHtml);
  const { cdp } = await getWarmBrowser();
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const targetId = String(created.targetId ?? "");
  if (!targetId) {
    throw new Error("CDP failed to create page target");
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = String(attached.sessionId ?? "");
  const pageErrors = [];
  const unsubException = cdp.on("Runtime.exceptionThrown", (params, evtSession) => {
    if (evtSession !== sessionId)
      return;
    const details = params.exceptionDetails;
    const exception = details?.exception;
    const desc = typeof exception?.description === "string" ? exception.description.split(`
`)[0] : typeof details?.text === "string" ? details.text : "Script error";
    if (desc && pageErrors.length < 5) {
      pageErrors.push(desc.slice(0, 180));
    }
  });
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    const frameTree = await cdp.send("Page.getFrameTree", {}, sessionId);
    const frame = frameTree.frameTree?.frame;
    const frameId = frame?.id ?? targetId;
    await cdp.send("Page.setDocumentContent", { frameId, html }, sessionId);
    if (settleMs > 0) {
      await new Promise((r) => setTimeout(r, settleMs));
    }
    const screenshots = [];
    for (const width of widths) {
      pageErrors.length = 0;
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 540,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      await cdp.send("Runtime.evaluate", {
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
        returnByValue: true
      }, sessionId);
      await new Promise((r) => setTimeout(r, 35));
      const metricsRes = await cdp.send("Runtime.evaluate", {
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
        returnByValue: true
      }, sessionId);
      const rawVal = metricsRes.result?.value ?? {};
      const scrollWidth = Number(rawVal.scrollWidth ?? width);
      const clientWidth = Number(rawVal.clientWidth ?? width);
      const scrollHeight = Number(rawVal.scrollHeight ?? 0);
      const textLen = Number(rawVal.textLen ?? 0);
      const visualNodes = Number(rawVal.visualNodes ?? 0);
      const captureHeight = Math.min(maxHeight, Math.max(180, scrollHeight + 16));
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: captureHeight,
        deviceScaleFactor: 1,
        mobile: false
      }, sessionId);
      const shotRes = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: 0, y: 0, width, height: captureHeight, scale: 1 }
      }, sessionId);
      const pngBase64 = String(shotRes.data ?? "");
      screenshots.push({
        width,
        height: captureHeight,
        pngBase64,
        scrollWidth,
        scrollHeight,
        clientWidth,
        hasHorizontalOverflow: scrollWidth > clientWidth + 4,
        isCollapsedOrEmpty: textLen === 0 && visualNodes === 0 || scrollHeight < 8,
        pageErrors: [...pageErrors]
      });
    }
    return screenshots;
  } finally {
    unsubException();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// service/server.ts
var MAX_RECENT_EVENTS = 40;
function readBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body exceeded maximum size"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}
function listenLoopback(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}
async function startDecisionUiServers(options = {}) {
  const env = options.env ?? process.env;
  const serviceToken = env.OPENCHAMBER_SERVICE_TOKEN ?? "";
  const hasHostEnv = Boolean(env.OPENCHAMBER_SERVICE_PORT && env.OPENCHAMBER_SERVICE_TOKEN);
  const serviceHost = hasHostEnv ? createServiceHost({ env }) : null;
  let config = loadDecisionUiConfig(env);
  let bridgeHealthy = false;
  let lastHealthCheckAt = 0;
  const counters = {
    surfaceRoutes: 0,
    directedSurfaceTurns: 0,
    uiCompiles: 0,
    renderGates: 0,
    renderAdvisories: 0,
    visualCritics: 0,
    missedVisuals: 0
  };
  let recent = [];
  let boundLoopbackPort = null;
  const pushTelemetry = (entry) => {
    const full = {
      id: crypto.randomUUID().slice(0, 8),
      timestamp: Date.now(),
      ...entry
    };
    recent = [full, ...recent].slice(0, MAX_RECENT_EVENTS);
    serviceHost?.emit("telemetry", {
      id: full.id,
      timestamp: full.timestamp,
      kind: full.kind,
      summary: full.summary,
      ms: full.ms,
      clean: full.clean ?? null
    });
    return full;
  };
  const makeClient = () => createDecisionBridgeClient({
    bridgeUrl: config.bridgeUrl,
    model: config.model,
    ...options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}
  });
  const refreshBridgeHealth = async (force = false) => {
    if (!force && Date.now() - lastHealthCheckAt < 5000) {
      return bridgeHealthy;
    }
    lastHealthCheckAt = Date.now();
    bridgeHealthy = await makeClient().checkHealth(1000);
    return bridgeHealthy;
  };
  const getSnapshot = async () => {
    const healthy = await refreshBridgeHealth(false);
    return {
      bridgeHealthy: healthy,
      bridgeUrl: config.bridgeUrl,
      loopbackPort: boundLoopbackPort ?? config.loopbackPort,
      config,
      counters: { ...counters },
      recent
    };
  };
  const buildGuestStatusView = async () => {
    const healthy = await refreshBridgeHealth(false);
    const rows = [
      {
        kind: "line",
        id: "bridge",
        label: "Decisions Bridge",
        dot: healthy ? "success" : "warning",
        value: healthy ? `${config.model} (:4006)` : "offline (:4006)"
      },
      {
        kind: "line",
        id: "router",
        label: "Surface Router",
        dot: config.surfaceRouterEnabled ? "info" : "muted",
        value: config.surfaceRouterEnabled ? `${counters.surfaceRoutes} turns · ${counters.directedSurfaceTurns} nudged` : "paused",
        actions: [
          {
            kind: "button",
            id: "toggle-router",
            label: config.surfaceRouterEnabled ? "Pause" : "Enable",
            variant: "outline"
          }
        ]
      },
      {
        kind: "line",
        id: "compiler",
        label: "Stitch Compiler",
        dot: "success",
        value: `${counters.uiCompiles} blocks compiled`
      },
      {
        kind: "line",
        id: "gate",
        label: "Render Gate & Critic",
        dot: config.renderGateEnabled || config.visualCriticEnabled ? "info" : "muted",
        value: `${counters.renderGates} checks · ${counters.renderAdvisories} advisories`,
        actions: [
          {
            kind: "button",
            id: "toggle-critic",
            label: config.visualCriticEnabled ? "Critic On" : "Critic Off",
            variant: "outline"
          }
        ]
      }
    ];
    const latest = recent[0];
    if (latest) {
      rows.push({
        kind: "note",
        id: "latest-event",
        text: `${latest.summary} (${latest.ms} ms)`,
        tone: latest.clean === false ? "warning" : "muted"
      });
    } else {
      rows.push({
        kind: "note",
        id: "config-path",
        text: `Config: ${renderTildePath(resolveConfigFilePath(env))}`,
        tone: "muted"
      });
    }
    return { rows };
  };
  const handleApiRoute = async (method, pathname, rawBody) => {
    if (method === "GET" && pathname === "/health") {
      const healthy = await refreshBridgeHealth(false);
      return {
        status: 200,
        body: {
          status: "ok",
          service: "decision-ui",
          bridgeHealthy: healthy,
          loopbackPort: boundLoopbackPort
        }
      };
    }
    if (method === "GET" && pathname === "/status") {
      return { status: 200, body: await buildGuestStatusView() };
    }
    if (method === "POST" && pathname === "/status") {
      const payload = rawBody ? JSON.parse(rawBody) : {};
      if (payload.id === "toggle-router") {
        config = saveDecisionUiConfig({ surfaceRouterEnabled: !config.surfaceRouterEnabled }, env);
      } else if (payload.id === "toggle-critic") {
        const nextVal = !config.visualCriticEnabled;
        config = saveDecisionUiConfig({ visualCriticEnabled: nextVal, renderGateEnabled: nextVal || config.renderGateEnabled }, env);
      } else if (payload.id === "reset-stats") {
        Object.assign(counters, {
          surfaceRoutes: 0,
          directedSurfaceTurns: 0,
          uiCompiles: 0,
          renderGates: 0,
          renderAdvisories: 0,
          visualCritics: 0,
          missedVisuals: 0
        });
        recent = [];
      }
      return { status: 200, body: await buildGuestStatusView() };
    }
    if (method === "GET" && pathname === "/state") {
      return { status: 200, body: await getSnapshot() };
    }
    if (method === "POST" && pathname === "/config") {
      const patch = rawBody ? JSON.parse(rawBody) : {};
      config = saveDecisionUiConfig(patch, env);
      await refreshBridgeHealth(true);
      return { status: 200, body: await getSnapshot() };
    }
    if (method === "POST" && (pathname === "/route" || pathname === "/plugin/route")) {
      const reqData = rawBody ? JSON.parse(rawBody) : {};
      if (!config.surfaceRouterEnabled) {
        return {
          status: 200,
          body: {
            enabled: false,
            decision: {
              needsUiProbability: 0.5,
              surface: "plain_reply",
              surfaceConfidence: 0,
              archetype: "none",
              archetypeConfidence: 0,
              action: "noop",
              directiveText: null,
              ms: 0
            }
          }
        };
      }
      const decision = await evaluateSurfaceRoute({
        client: makeClient(),
        config,
        latestUserText: String(reqData.latestUserText ?? ""),
        ...reqData.recentHistory ? { recentHistory: reqData.recentHistory } : {}
      });
      counters.surfaceRoutes += 1;
      if (decision.action === "inject_user_tail") {
        counters.directedSurfaceTurns += 1;
      }
      pushTelemetry({
        kind: "surface_route",
        summary: decision.action === "inject_user_tail" ? `Tail nudge -> ${decision.surface} (${decision.archetype}, p=${decision.needsUiProbability.toFixed(2)})` : `No-op (cache intact, ${decision.surface}, p=${decision.needsUiProbability.toFixed(2)})`,
        ms: decision.ms,
        clean: true,
        ...reqData.sessionId ? { sessionId: reqData.sessionId } : {}
      });
      return { status: 200, body: { enabled: true, decision } };
    }
    if (method === "POST" && (pathname === "/compile" || pathname === "/plugin/compile")) {
      const reqData = rawBody ? JSON.parse(rawBody) : {};
      const result = await compileStructuredDataToUi({
        rawInput: String(reqData.rawInput ?? ""),
        ...reqData.editInstruction ? { editInstruction: reqData.editInstruction } : {},
        ...reqData.title ? { title: reqData.title } : {},
        client: makeClient()
      });
      counters.uiCompiles += 1;
      pushTelemetry({
        kind: "ui_compile",
        summary: `Compiled ${result.dataset.rows.length} rows -> ${result.plan.chartKind} (${result.plan.questionCount} Qs, 0 out tok)`,
        ms: result.plan.ms,
        clean: result.ok,
        ...reqData.sessionId ? { sessionId: reqData.sessionId } : {}
      });
      return { status: 200, body: result };
    }
    if (method === "POST" && (pathname === "/auto-visual" || pathname === "/plugin/auto-visual")) {
      const reqData = rawBody ? JSON.parse(rawBody) : {};
      const result = await evaluateAutoVisual({
        content: String(reqData.content ?? ""),
        ...reqData.intent ? { intent: reqData.intent } : {},
        ...reqData.forceMode ? { forceMode: reqData.forceMode } : {},
        client: makeClient(),
        config
      });
      counters.uiCompiles += 1;
      pushTelemetry({
        kind: "ui_compile",
        summary: result.mode === "verbatim" ? `AutoVisual -> verbatim (p=${result.shouldVisualizeProbability.toFixed(2)})` : `AutoVisual -> ${result.mode === "chart" ? result.compiled?.plan.chartKind ?? "chart" : result.mode} (${result.questionCount} Qs, 0 out tok)`,
        ms: result.ms,
        clean: result.ok,
        ...reqData.sessionId ? { sessionId: reqData.sessionId } : {}
      });
      return { status: 200, body: result };
    }
    if (method === "POST" && (pathname === "/gate" || pathname === "/plugin/gate")) {
      const reqData = rawBody ? JSON.parse(rawBody) : {};
      const targetTool = reqData.targetTool === "question" ? "question" : "openchamber_render";
      const gateRes = await evaluateRenderGate({
        targetTool,
        rawInput: reqData.rawInput ?? {},
        client: makeClient(),
        config,
        captureHtml: (html) => captureHtmlViewports(html, { viewports: [360, 720] }),
        includeScreenshotsInResult: reqData.includeScreenshots === true
      });
      counters.renderGates += 1;
      if (!gateRes.clean)
        counters.renderAdvisories += 1;
      if (gateRes.visualCritic?.evaluated)
        counters.visualCritics += 1;
      pushTelemetry({
        kind: gateRes.visualCritic ? "visual_critic" : "render_gate",
        summary: gateRes.clean ? `${gateRes.mode.toUpperCase()} gate clean${gateRes.visualCritic?.evaluated ? ` (360/720 fit=${gateRes.visualCritic.mobileFitScore.toFixed(1)}/3)` : ""}` : `${gateRes.mode.toUpperCase()} advisory: ${gateRes.findings.length} finding(s) (${gateRes.findings[0]?.code ?? "issue"})`,
        ms: gateRes.ms,
        clean: gateRes.clean,
        ...reqData.sessionId ? { sessionId: reqData.sessionId } : {}
      });
      return { status: 200, body: gateRes };
    }
    if (method === "POST" && pathname === SESSION_EVENTS_PATH) {
      const evt = readSessionEventRequest(rawBody);
      if (!evt) {
        return { status: 400, body: { ok: false, error: "Invalid session event payload" } };
      }
      if (evt.event.type === "turn-finished" && evt.content?.type === "turn-finished") {
        const reply = evt.content.reply;
        const sessionId = evt.event.session.id;
        evaluateTurnEndMissedVisual({
          replyText: reply,
          client: makeClient(),
          config
        }).then((check) => {
          if (!check.missed)
            return;
          counters.missedVisuals += 1;
          const entry = pushTelemetry({
            kind: "missed_visual",
            summary: `Turn reply had unvisualized data -> try "${check.archetype}" (p=${check.probability.toFixed(2)})`,
            ms: check.ms,
            clean: false,
            sessionId,
            detail: {
              archetype: check.archetype,
              probability: check.probability,
              replyPreview: reply.slice(0, 500)
            }
          });
          serviceHost?.emit("missed-visual", {
            id: entry.id,
            sessionId,
            archetype: check.archetype,
            probability: check.probability
          });
        }).catch(() => {});
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { error: `Unknown route ${method} ${pathname}` } };
  };
  let loopbackServer = null;
  const desiredLoopback = options.loopbackPortOverride !== undefined ? options.loopbackPortOverride : config.loopbackPort;
  if (desiredLoopback !== null) {
    loopbackServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const body = req.method === "POST" ? await readBody(req) : "";
        const out = await handleApiRoute(req.method ?? "GET", reqUrl.pathname, body);
        sendJson(res, out.status, out.body);
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err)
        });
      }
    });
    try {
      boundLoopbackPort = await listenLoopback(loopbackServer, desiredLoopback);
    } catch {
      loopbackServer = null;
      boundLoopbackPort = null;
    }
  }
  let serviceServer = null;
  let boundServicePort = null;
  const desiredServicePort = options.servicePort !== undefined ? options.servicePort : env.OPENCHAMBER_SERVICE_PORT ? Number(env.OPENCHAMBER_SERVICE_PORT) : null;
  if (desiredServicePort !== null && Number.isInteger(desiredServicePort)) {
    serviceServer = http.createServer(async (req, res) => {
      if (serviceToken && req.headers.authorization !== `Bearer ${serviceToken}`) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const body = req.method === "POST" ? await readBody(req) : "";
        const out = await handleApiRoute(req.method ?? "GET", reqUrl.pathname, body);
        sendJson(res, out.status, out.body);
      } catch (err) {
        sendJson(res, 400, {
          error: err instanceof Error ? err.message : String(err)
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
        new Promise((resolve) => {
          if (!loopbackServer)
            return resolve();
          loopbackServer.close(() => resolve());
        }),
        new Promise((resolve) => {
          if (!serviceServer)
            return resolve();
          serviceServer.close(() => resolve());
        }),
        closeWarmBrowser()
      ]);
    }
  };
}

// service/main.ts
var running = await startDecisionUiServers({ env: process.env });
var shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.once("SIGINT", () => {
  shutdown();
});
process.once("SIGTERM", () => {
  shutdown();
});
