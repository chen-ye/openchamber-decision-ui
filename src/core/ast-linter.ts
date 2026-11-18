import type { AstLintIssue, AstLintReport } from './types.ts';

export const BUILTIN_UI_COMPONENTS = new Set([
  'Stack',
  'Row',
  'Card',
  'Tabs',
  'Tab',
  'Details',
  'Text',
  'Badge',
  'Callout',
  'KeyValue',
  'Table',
  'Stat',
  'Progress',
  'Steps',
  'BarChart',
  'LineChart',
  'Series',
  'Choice',
  'Input',
  'DateInput',
  'Slider',
  'Button',
  'AutoVisual',
]);

const MOBILE_HEAVY_IN_ROW = new Set([
  'Table',
  'BarChart',
  'LineChart',
  'KeyValue',
  'Progress',
  'Steps',
]);

const VISUAL_COMPANION_COMPONENTS = new Set(['BarChart', 'LineChart', 'Progress', 'Stat']);

type ParsedExpr =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'array'; readonly items: ReadonlyArray<ParsedExpr> }
  | { readonly kind: 'object'; readonly entries: ReadonlyArray<{ readonly key: string; readonly value: ParsedExpr }> }
  | {
      readonly kind: 'call';
      readonly typeName: string;
      readonly args: ReadonlyArray<ParsedExpr>;
      readonly hasNamedArg: boolean;
      readonly line: number;
    };

interface BindingNode {
  readonly name: string;
  readonly line: number;
  readonly expr: ParsedExpr;
}

class ExprParser {
  private pos = 0;
  private readonly src: string;
  private readonly line: number;

  constructor(src: string, line: number) {
    this.src = src;
    this.line = line;
  }

  public isAtEnd(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) {
      this.pos += 1;
    }
  }

  private peek(): string {
    return this.src[this.pos] ?? '';
  }

  public parseExpr(): ParsedExpr {
    this.skipWs();
    const ch = this.peek();
    if (ch === '"' || ch === "'") {
      return { kind: 'string', value: this.parseString() };
    }
    if (ch === '[') {
      return this.parseArray();
    }
    if (ch === '{') {
      return this.parseObject();
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      return this.parseNumber();
    }
    const ident = this.parseIdentifier();
    if (!ident) {
      throw new Error(`Unexpected token "${ch || 'EOF'}" at col ${this.pos + 1}`);
    }
    this.skipWs();
    if (this.peek() === '(') {
      return this.parseCall(ident);
    }
    if (ident === 'true') return { kind: 'boolean', value: true };
    if (ident === 'false') return { kind: 'boolean', value: false };
    if (ident === 'null') return { kind: 'null' };
    return { kind: 'ref', name: ident };
  }

  private parseString(): string {
    const quote = this.src[this.pos]!;
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      this.pos += 1;
      if (c === '\\') {
        const next = this.src[this.pos] ?? '';
        this.pos += 1;
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else out += next;
        continue;
      }
      if (c === quote) {
        return out;
      }
      out += c;
    }
    throw new Error('Unterminated string literal');
  }

  private parseNumber(): ParsedExpr {
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (this.pos < this.src.length && /[0-9.]/.test(this.src[this.pos]!)) {
      this.pos += 1;
    }
    const raw = this.src.slice(start, this.pos);
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number "${raw}"`);
    }
    return { kind: 'number', value: num };
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.pos]!)) {
      this.pos += 1;
    }
    return this.src.slice(start, this.pos);
  }

  private parseArray(): ParsedExpr {
    this.pos += 1; // '['
    const items: ParsedExpr[] = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.pos += 1;
      return { kind: 'array', items };
    }
    while (this.pos < this.src.length) {
      items.push(this.parseExpr());
      this.skipWs();
      if (this.peek() === ',') {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'array', items };
        }
        continue;
      }
      if (this.peek() === ']') {
        this.pos += 1;
        return { kind: 'array', items };
      }
      throw new Error(`Expected "," or "]" in array at col ${this.pos + 1}`);
    }
    throw new Error('Unterminated array "["');
  }

  private parseObject(): ParsedExpr {
    this.pos += 1; // '{'
    const entries: Array<{ key: string; value: ParsedExpr }> = [];
    this.skipWs();
    if (this.peek() === '}') {
      this.pos += 1;
      return { kind: 'object', entries };
    }
    while (this.pos < this.src.length) {
      this.skipWs();
      const key =
        this.peek() === '"' || this.peek() === "'" ? this.parseString() : this.parseIdentifier();
      if (!key) {
        throw new Error(`Expected object key at col ${this.pos + 1}`);
      }
      this.skipWs();
      if (this.peek() !== ':') {
        throw new Error(`Expected ":" after object key "${key}"`);
      }
      this.pos += 1;
      const value = this.parseExpr();
      entries.push({ key, value });
      this.skipWs();
      if (this.peek() === ',') {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', entries };
        }
        continue;
      }
      if (this.peek() === '}') {
        this.pos += 1;
        return { kind: 'object', entries };
      }
      throw new Error(`Expected "," or "}" in object at col ${this.pos + 1}`);
    }
    throw new Error('Unterminated object "{"');
  }

  private parseCall(typeName: string): ParsedExpr {
    this.pos += 1; // '('
    const args: ParsedExpr[] = [];
    let hasNamedArg = false;
    this.skipWs();
    if (this.peek() === ')') {
      this.pos += 1;
      return { kind: 'call', typeName, args, hasNamedArg, line: this.line };
    }
    while (this.pos < this.src.length) {
      this.skipWs();
      const saved = this.pos;
      const maybeName = this.parseIdentifier();
      this.skipWs();
      if (maybeName && this.peek() === ':') {
        hasNamedArg = true;
        this.pos += 1; // consume ':' and still parse value to keep going
      } else {
        this.pos = saved;
      }
      args.push(this.parseExpr());
      this.skipWs();
      if (this.peek() === ',') {
        this.pos += 1;
        this.skipWs();
        if (this.peek() === ')') {
          this.pos += 1;
          return { kind: 'call', typeName, args, hasNamedArg, line: this.line };
        }
        continue;
      }
      if (this.peek() === ')') {
        this.pos += 1;
        return { kind: 'call', typeName, args, hasNamedArg, line: this.line };
      }
      throw new Error(`Expected "," or ")" in ${typeName}(...) at col ${this.pos + 1}`);
    }
    throw new Error(`Unterminated call to ${typeName}(...)`);
  }
}

/**
 * Splits physical lines into logical `ident = expr` statements, joining multi-line
 * brackets/parens cleanly so multiline arrays/objects parse accurately.
 */
function splitStatements(rawSource: string): ReadonlyArray<{ readonly line: number; readonly text: string }> {
  const clean = rawSource
    .trim()
    .replace(/^```(?:openui-lang|openui)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '');
  const rawLines = clean.split(/\r?\n/);

  const statements: Array<{ line: number; text: string }> = [];
  let buffer = '';
  let startLine = 1;
  let depth = 0;
  let inQuote: string | null = null;

  for (let i = 0; i < rawLines.length; i += 1) {
    const lineText = rawLines[i] ?? '';
    const trimmed = lineText.trim();
    if (!buffer && (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#'))) {
      continue;
    }
    if (!buffer) {
      startLine = i + 1;
      buffer = trimmed;
    } else {
      buffer += `\n${trimmed}`;
    }

    for (let j = 0; j < trimmed.length; j += 1) {
      const c = trimmed[j]!;
      if (inQuote) {
        if (c === '\\') {
          j += 1;
        } else if (c === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (c === '"' || c === "'") {
        inQuote = c;
      } else if (c === '(' || c === '[' || c === '{') {
        depth += 1;
      } else if (c === ')' || c === ']' || c === '}') {
        depth = Math.max(0, depth - 1);
      }
    }

    if (depth === 0 && !inQuote) {
      statements.push({ line: startLine, text: buffer });
      buffer = '';
    }
  }

  if (buffer) {
    statements.push({ line: startLine, text: buffer });
  }
  return statements;
}

/**
 * Deterministic `<1 ms` static AST linter for OpenChamber's `openui-lang` DSL:
 * - Verifies `root = Stack([...])` entry & reachability
 * - Catches named-argument errors (`title: "..."` inside component calls)
 * - Enforces parent-child nesting invariants (`Card`, `Row`, `Tabs`, `Details`)
 * - Flags 360px mobile layout traps (`Row` squeezing wide components, long `Badge` labels on titled `Card`s)
 * - Enforces Tufte numeric-table visual pairing (`Table` with >=2 numbers requires `BarChart`/`LineChart`/`Progress`/`Stat`)
 */
export function lintOpenUiSource(source: string): AstLintReport {
  const issues: AstLintIssue[] = [];
  const componentCounts: Record<string, number> = {};
  const statements = splitStatements(source);

  if (statements.length === 0) {
    return {
      valid: false,
      componentCounts,
      issues: [{ code: 'empty_program', severity: 'error', message: 'openui-lang program is empty.' }],
    };
  }

  const bindings = new Map<string, BindingNode>();
  let firstBindingName: string | null = null;

  for (const stmt of statements) {
    const eqMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]+)$/.exec(stmt.text);
    if (!eqMatch || !eqMatch[1] || !eqMatch[2]) {
      issues.push({
        code: 'syntax_error',
        severity: 'error',
        line: stmt.line,
        message: `Expected "name = Component(...)" assignment on line ${stmt.line}.`,
      });
      continue;
    }
    const name = eqMatch[1];
    const rhs = eqMatch[2];
    if (firstBindingName === null) firstBindingName = name;

    try {
      const parser = new ExprParser(rhs, stmt.line);
      const expr = parser.parseExpr();
      if (!parser.isAtEnd()) {
        issues.push({
          code: 'syntax_error',
          severity: 'error',
          line: stmt.line,
          message: `Unexpected trailing characters in "${name}" assignment on line ${stmt.line}.`,
        });
      }
      bindings.set(name, { name, line: stmt.line, expr });
    } catch (err) {
      issues.push({
        code: 'syntax_error',
        severity: 'error',
        line: stmt.line,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rootBinding = bindings.get('root');
  if (!rootBinding || rootBinding.expr.kind !== 'call' || rootBinding.expr.typeName !== 'Stack') {
    issues.push({
      code: 'missing_root_stack',
      severity: 'error',
      line: rootBinding?.line ?? 1,
      message: 'openui-lang must define "root = Stack([...])" as its root container.',
    });
  } else if (firstBindingName !== 'root') {
    issues.push({
      code: 'missing_root_stack',
      severity: 'warning',
      line: rootBinding.line,
      message: 'First line should be "root = Stack([...])" so streaming renders progressively.',
    });
  }

  const visitedBindings = new Set<string>();
  let numericTableCellCount = 0;

  const resolveExpr = (expr: ParsedExpr): ParsedExpr => {
    if (expr.kind === 'ref') {
      const target = bindings.get(expr.name);
      if (!target) {
        issues.push({
          code: 'undefined_reference',
          severity: 'error',
          message: `Undefined identifier "${expr.name}" referenced in UI tree.`,
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

  const walk = (rawExpr: ParsedExpr, parentComponent: string | null): void => {
    const expr = resolveExpr(rawExpr);

    if (expr.kind === 'array') {
      for (const item of expr.items) {
        walk(item, parentComponent);
      }
      return;
    }

    if (expr.kind === 'object') {
      for (const entry of expr.entries) {
        walk(entry.value, parentComponent);
      }
      return;
    }

    if (expr.kind !== 'call') {
      return;
    }

    const { typeName, args, hasNamedArg, line } = expr;
    componentCounts[typeName] = (componentCounts[typeName] ?? 0) + 1;

    if (hasNamedArg) {
      issues.push({
        code: 'named_argument',
        severity: 'error',
        line,
        message: `${typeName}(...) uses named arguments ("key: value"); openui-lang only supports positional arguments.`,
      });
    }

    if (!BUILTIN_UI_COMPONENTS.has(typeName)) {
      const isPascalCase = /^[A-Z][A-Za-z0-9]*$/.test(typeName);
      issues.push({
        code: 'unknown_component',
        severity: isPascalCase ? 'warning' : 'error',
        line,
        message: isPascalCase
          ? `"${typeName}" is not one of the 22 built-in openui-lang components (ensure an extension provides it).`
          : `Unknown component "${typeName}".`,
      });
    }

    // Parent-child nesting rules from catalog.ts / guidance.ts
    if (parentComponent === 'Card' && (typeName === 'Card' || typeName === 'Tabs')) {
      issues.push({
        code: 'invalid_nesting',
        severity: 'error',
        line,
        message: `Card cannot contain ${typeName}; stack Cards directly under Stack([...]).`,
      });
    }
    if (
      parentComponent === 'Row' &&
      (typeName === 'Row' || typeName === 'Card' || typeName === 'Tabs' || typeName === 'Details')
    ) {
      issues.push({
        code: 'invalid_nesting',
        severity: 'error',
        line,
        message: `Row cannot contain ${typeName} (Row children must be leaf components; put Cards directly in Stack([...])).`,
      });
    }
    if (parentComponent === 'Tab' && typeName === 'Tabs') {
      issues.push({
        code: 'invalid_nesting',
        severity: 'error',
        line,
        message: 'Tab cannot nest another Tabs component.',
      });
    }
    if (
      parentComponent === 'Details' &&
      (typeName === 'Card' || typeName === 'Tabs' || typeName === 'Details')
    ) {
      issues.push({
        code: 'invalid_nesting',
        severity: 'error',
        line,
        message: `Details cannot contain ${typeName}.`,
      });
    }

    // Mobile 360px layout rule: Row squeezes content-heavy children to min-w-[12rem]
    if (parentComponent === 'Row' && MOBILE_HEAVY_IN_ROW.has(typeName)) {
      issues.push({
        code: 'mobile_row_squeeze',
        severity: 'warning',
        line,
        message: `Placing ${typeName} inside Row([...]) squeezes columns on ~360-412px mobile screens; place ${typeName} directly inside Stack([...]) and reserve Row for Stat tiles, Badges, or Buttons.`,
      });
    }

    // Mobile Card header Badge rule: Card(title, [Badge(label, ...), ...])
    if (typeName === 'Card' && args.length >= 2) {
      const titleArg = resolveExpr(args[0]!);
      const childrenArg = resolveExpr(args[1]!);
      if (
        titleArg.kind === 'string' &&
        titleArg.value.trim().length > 0 &&
        childrenArg.kind === 'array'
      ) {
        for (const childRaw of childrenArg.items) {
          const child = resolveExpr(childRaw);
          if (child.kind !== 'call' || child.typeName !== 'Badge') break;
          const badgeLabel = child.args[0] ? resolveExpr(child.args[0]) : null;
          if (badgeLabel?.kind === 'string') {
            const text = badgeLabel.value.trim();
            const wordCount = text.split(/\s+/).filter(Boolean).length;
            if (text.length > 16 || wordCount > 2) {
              issues.push({
                code: 'long_card_badge',
                severity: 'warning',
                line: child.line,
                message: `Leading Card Badge "${text}" is too long (${text.length} chars); Card hoists leading Badges with shrink-0 and starves CardTitle on mobile. Keep Badge labels to 1-2 short words and move details to KeyValue/Table.`,
              });
            }
          }
        }
      }
    }

    // Count numeric cells inside Table(columns, rows) for Tufte pairing check
    if (typeName === 'Table' && args.length >= 2) {
      const rowsArg = resolveExpr(args[1]!);
      if (rowsArg.kind === 'array') {
        for (const rowRaw of rowsArg.items) {
          const row = resolveExpr(rowRaw);
          if (row.kind === 'array') {
            for (const cellRaw of row.items) {
              const cell = resolveExpr(cellRaw);
              if (cell.kind === 'number') {
                numericTableCellCount += 1;
              } else if (
                cell.kind === 'string' &&
                /^[$€£+-]?\d[\d,.]*\s*(?:%|ms|s|x|KB|MB|GB)?$/i.test(cell.value.trim())
              ) {
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
    visitedBindings.add('root');
    walk(rootBinding.expr, null);
  }

  for (const [name, node] of bindings.entries()) {
    if (!visitedBindings.has(name)) {
      issues.push({
        code: 'unreachable_binding',
        severity: 'warning',
        line: node.line,
        message: `Binding "${name}" is unreachable from root.`,
      });
    }
  }

  const hasVisualCompanion = Object.keys(componentCounts).some(
    (name) => VISUAL_COMPANION_COMPONENTS.has(name) && (componentCounts[name] ?? 0) > 0,
  );
  if ((componentCounts.Table ?? 0) > 0 && numericTableCellCount >= 2 && !hasVisualCompanion) {
    issues.push({
      code: 'tufte_table_without_visual',
      severity: 'warning',
      message:
        'Tufte data-ink check: numeric Table has no visual companion (pair numeric comparisons with BarChart, LineChart, Progress, or Stat tiles).',
    });
  }

  const hasErrors = issues.some((issue) => issue.severity === 'error');
  return {
    valid: !hasErrors,
    componentCounts,
    issues,
  };
}
