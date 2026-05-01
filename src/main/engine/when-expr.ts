import type { Context } from './template';

type Token =
  | { kind: 'var'; path: string }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'op'; value: '==' | '!=' | '&&' | '||' | '!' | '(' | ')' };

const VAR_RE = /^\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/;
const STR_RE = /^'([^']*)'/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (c === '!' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '!=' });
      i += 2;
      continue;
    }
    if (c === '!') {
      tokens.push({ kind: 'op', value: '!' });
      i++;
      continue;
    }
    if (c === '=' && input[i + 1] === '=') {
      tokens.push({ kind: 'op', value: '==' });
      i += 2;
      continue;
    }
    if (c === '&' && input[i + 1] === '&') {
      tokens.push({ kind: 'op', value: '&&' });
      i += 2;
      continue;
    }
    if (c === '|' && input[i + 1] === '|') {
      tokens.push({ kind: 'op', value: '||' });
      i += 2;
      continue;
    }
    const rest = input.slice(i);
    const v = VAR_RE.exec(rest);
    if (v) {
      tokens.push({ kind: 'var', path: v[1]! });
      i += v[0].length;
      continue;
    }
    const s = STR_RE.exec(rest);
    if (s) {
      tokens.push({ kind: 'str', value: s[1]! });
      i += s[0].length;
      continue;
    }
    if (rest.startsWith('true')) {
      tokens.push({ kind: 'bool', value: true });
      i += 4;
      continue;
    }
    if (rest.startsWith('false')) {
      tokens.push({ kind: 'bool', value: false });
      i += 5;
      continue;
    }
    throw new Error(`when-expr: unexpected token at position ${i} ('${rest.slice(0, 8)}...')`);
  }
  return tokens;
}

type Ast =
  | { kind: 'var'; path: string }
  | { kind: 'lit'; value: string | boolean }
  | { kind: 'not'; rhs: Ast }
  | { kind: 'eq' | 'neq' | 'and' | 'or'; lhs: Ast; rhs: Ast };

class Parser {
  private pos = 0;
  constructor(private toks: Token[]) {}

  parse(): Ast {
    const ast = this.parseOr();
    if (this.pos !== this.toks.length) throw new Error('when-expr: trailing tokens');
    return ast;
  }

  private parseOr(): Ast {
    let lhs = this.parseAnd();
    while (this.peekOp('||')) {
      this.pos++;
      const rhs = this.parseAnd();
      lhs = { kind: 'or', lhs, rhs };
    }
    return lhs;
  }

  private parseAnd(): Ast {
    let lhs = this.parseEq();
    while (this.peekOp('&&')) {
      this.pos++;
      const rhs = this.parseEq();
      lhs = { kind: 'and', lhs, rhs };
    }
    return lhs;
  }

  private parseEq(): Ast {
    const lhs = this.parseUnary();
    if (this.peekOp('==')) {
      this.pos++;
      return { kind: 'eq', lhs, rhs: this.parseUnary() };
    }
    if (this.peekOp('!=')) {
      this.pos++;
      return { kind: 'neq', lhs, rhs: this.parseUnary() };
    }
    return lhs;
  }

  private parseUnary(): Ast {
    if (this.peekOp('!')) {
      this.pos++;
      return { kind: 'not', rhs: this.parseUnary() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Ast {
    const t = this.toks[this.pos];
    if (!t) throw new Error('when-expr: unexpected end');
    if (t.kind === 'op' && t.value === '(') {
      this.pos++;
      const inner = this.parseOr();
      const close = this.toks[this.pos];
      if (!close || close.kind !== 'op' || close.value !== ')') {
        throw new Error("when-expr: expected ')'");
      }
      this.pos++;
      return inner;
    }
    if (t.kind === 'var') {
      this.pos++;
      return { kind: 'var', path: t.path };
    }
    if (t.kind === 'str') {
      this.pos++;
      return { kind: 'lit', value: t.value };
    }
    if (t.kind === 'bool') {
      this.pos++;
      return { kind: 'lit', value: t.value };
    }
    throw new Error(`when-expr: unexpected token kind ${t.kind}`);
  }

  private peekOp(v: string): boolean {
    const t = this.toks[this.pos];
    return !!t && t.kind === 'op' && t.value === v;
  }
}

export function parseWhen(input: string): Ast {
  return new Parser(tokenize(input)).parse();
}

function getVar(ctx: Context, path: string): string | boolean | undefined {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur === 'boolean' || typeof cur === 'string') return cur;
  return undefined;
}

function evalAst(ast: Ast, ctx: Context): boolean {
  switch (ast.kind) {
    case 'lit':
      return ast.value === true || (typeof ast.value === 'string' && ast.value !== '');
    case 'var': {
      const v = getVar(ctx, ast.path);
      return v === true || (typeof v === 'string' && v !== '');
    }
    case 'not':
      return !evalAst(ast.rhs, ctx);
    case 'and':
      return evalAst(ast.lhs, ctx) && evalAst(ast.rhs, ctx);
    case 'or':
      return evalAst(ast.lhs, ctx) || evalAst(ast.rhs, ctx);
    case 'eq':
    case 'neq': {
      const l = resolveValue(ast.lhs, ctx);
      const r = resolveValue(ast.rhs, ctx);
      const eq = l === r;
      return ast.kind === 'eq' ? eq : !eq;
    }
  }
}

function resolveValue(ast: Ast, ctx: Context): string | boolean | undefined {
  if (ast.kind === 'lit') return ast.value;
  if (ast.kind === 'var') return getVar(ctx, ast.path);
  throw new Error('when-expr: invalid operand for == / !=');
}

export function evaluateWhen(expr: string | undefined, ctx: Context): boolean {
  if (!expr || expr.trim() === '') return true;
  return evalAst(parseWhen(expr), ctx);
}
