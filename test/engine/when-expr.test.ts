import { describe, it, expect } from 'vitest';
import { evaluateWhen, parseWhen } from '@main/engine/when-expr';

const ctx = {
  components: { core: true, samples: false, vstPath: true },
  shortcut: 'desktop+menu',
};

describe('parseWhen + evaluateWhen', () => {
  it('evaluates a single var', () => {
    expect(evaluateWhen('{{components.core}}', ctx)).toBe(true);
    expect(evaluateWhen('{{components.samples}}', ctx)).toBe(false);
  });

  it('evaluates equality', () => {
    expect(evaluateWhen("{{shortcut}} == 'desktop+menu'", ctx)).toBe(true);
    expect(evaluateWhen("{{shortcut}} == 'none'", ctx)).toBe(false);
  });

  it('evaluates inequality', () => {
    expect(evaluateWhen("{{shortcut}} != 'none'", ctx)).toBe(true);
  });

  it('evaluates && and ||', () => {
    expect(evaluateWhen('{{components.core}} && {{components.samples}}', ctx)).toBe(false);
    expect(evaluateWhen('{{components.core}} || {{components.samples}}', ctx)).toBe(true);
  });

  it('evaluates !', () => {
    expect(evaluateWhen('!{{components.samples}}', ctx)).toBe(true);
  });

  it('evaluates parens', () => {
    expect(
      evaluateWhen(
        "({{components.core}} || {{components.samples}}) && {{shortcut}} == 'desktop+menu'",
        ctx,
      ),
    ).toBe(true);
  });

  it('rejects forbidden syntax', () => {
    expect(() => parseWhen('process.exit()')).toThrow();
    expect(() => parseWhen('{{x}} + 1')).toThrow();
    expect(() => parseWhen('{{x}}; {{y}}')).toThrow();
  });

  it('returns true for empty when (treat as always true)', () => {
    expect(evaluateWhen(undefined, ctx)).toBe(true);
    expect(evaluateWhen('', ctx)).toBe(true);
  });
});
