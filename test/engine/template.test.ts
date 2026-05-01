import { describe, it, expect } from 'vitest';
import { renderTemplate, resolveVariables } from '@main/engine/template';

const sysVars = {
  ProgramFiles: 'C:/Program Files',
  LocalAppData: 'C:/Users/u/AppData/Local',
};

describe('renderTemplate', () => {
  it('substitutes simple var', () => {
    const ctx = { installPath: 'C:/X' };
    expect(renderTemplate('{{installPath}}/bin', ctx)).toBe('C:/X/bin');
  });

  it('substitutes nested', () => {
    const ctx = { components: { core: true, samples: false } };
    expect(renderTemplate('{{components.core}}', ctx)).toBe('true');
  });

  it('substitutes system vars', () => {
    expect(renderTemplate('{ProgramFiles}/X', {}, sysVars)).toBe('C:/Program Files/X');
  });

  it('throws on undefined variable', () => {
    expect(() => renderTemplate('{{missing}}', {})).toThrow();
  });

  it('handles multiple substitutions', () => {
    expect(renderTemplate('{ProgramFiles}/{{name}}/bin', { name: 'X' }, sysVars)).toBe(
      'C:/Program Files/X/bin',
    );
  });
});

describe('resolveVariables', () => {
  it('returns map of all referenced names', () => {
    const ref = resolveVariables('{ProgramFiles}/{{name}}/{{components.core}}');
    expect(ref.systemVars).toEqual(['ProgramFiles']);
    expect(ref.userVars).toEqual(['name', 'components.core']);
  });
});
