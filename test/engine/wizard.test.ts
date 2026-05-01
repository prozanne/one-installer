import { describe, it, expect } from 'vitest';
import { validateAnswer, computeWizardOrder, diffWizardForReuse } from '@main/engine/wizard';
import type { WizardStepT } from '@shared/schema';

describe('validateAnswer', () => {
  it('accepts valid checkbox group with required item set', () => {
    const step: WizardStepT = {
      type: 'checkboxGroup',
      id: 'comp',
      label: { default: 'C' },
      items: [
        { id: 'core', label: { default: 'Core' }, default: true, required: true },
        { id: 'samples', label: { default: 'S' }, default: false, required: false },
      ],
    };
    expect(validateAnswer(step, { core: true, samples: false }).ok).toBe(true);
  });

  it('rejects checkbox group missing required item', () => {
    const step: WizardStepT = {
      type: 'checkboxGroup',
      id: 'comp',
      label: { default: 'C' },
      items: [{ id: 'core', label: { default: 'Core' }, default: true, required: true }],
    };
    const r = validateAnswer(step, { core: false });
    expect(r.ok).toBe(false);
  });

  it('rejects text not matching regex', () => {
    const step: WizardStepT = {
      type: 'text',
      id: 'name',
      label: { default: 'N' },
      default: '',
      regex: '^[a-z]{1,4}$',
      optional: false,
    };
    expect(validateAnswer(step, 'TOOLONG').ok).toBe(false);
    expect(validateAnswer(step, 'abc').ok).toBe(true);
  });

  it('rejects path that is empty when not optional', () => {
    const step: WizardStepT = { type: 'path', id: 'p', label: { default: 'P' }, default: '' };
    expect(validateAnswer(step, '').ok).toBe(false);
    expect(validateAnswer(step, 'C:/X').ok).toBe(true);
  });

  it('accepts license when answer is true', () => {
    const step: WizardStepT = { type: 'license', id: 'eula', fileFromPayload: 'EULA.txt' };
    expect(validateAnswer(step, true).ok).toBe(true);
    expect(validateAnswer(step, false).ok).toBe(false);
  });

  it('rejects select value not in options', () => {
    const step: WizardStepT = {
      type: 'select',
      id: 'sc',
      label: { default: 'S' },
      options: [{ value: 'a', label: { default: 'A' }, default: true }],
    };
    expect(validateAnswer(step, 'a').ok).toBe(true);
    expect(validateAnswer(step, 'unknown').ok).toBe(false);
  });
});

describe('computeWizardOrder', () => {
  it('returns steps in declaration order', () => {
    const steps: WizardStepT[] = [
      { type: 'path', id: 'p', label: { default: 'P' }, default: '' },
      { type: 'summary' },
    ];
    expect(computeWizardOrder(steps).map((s) => s.type)).toEqual(['path', 'summary']);
  });
});

describe('diffWizardForReuse', () => {
  const oldSteps: WizardStepT[] = [
    { type: 'path', id: 'installPath', label: { default: 'P' }, default: '' },
    {
      type: 'select',
      id: 'shortcut',
      label: { default: 'S' },
      options: [{ value: 'menu', label: { default: 'M' }, default: true }],
    },
    { type: 'summary' },
  ];

  const savedAnswers = { installPath: 'C:/X', shortcut: 'menu' };

  it('reuses everything when wizard unchanged', () => {
    const diff = diffWizardForReuse(oldSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk).toEqual([]);
    expect(diff.reused).toEqual({ installPath: 'C:/X', shortcut: 'menu' });
    expect(diff.canSkipWizard).toBe(true);
  });

  it('asks only the new step when one is added', () => {
    const newSteps: WizardStepT[] = [
      ...oldSteps.slice(0, 2),
      {
        type: 'text',
        id: 'deviceName',
        label: { default: 'D' },
        default: '',
        optional: true,
      },
      { type: 'summary' },
    ];
    const diff = diffWizardForReuse(newSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk.map((s) => ('id' in s ? s.id : s.type))).toEqual(['deviceName']);
    expect(diff.reused).toEqual({ installPath: 'C:/X', shortcut: 'menu' });
    expect(diff.canSkipWizard).toBe(false);
  });

  it('asks the changed step when type differs', () => {
    const newSteps: WizardStepT[] = [
      {
        type: 'text',
        id: 'installPath',
        label: { default: 'P' },
        default: '',
        optional: false,
      },
      ...oldSteps.slice(1),
    ];
    const diff = diffWizardForReuse(newSteps, oldSteps, savedAnswers);
    expect(diff.mustAsk.map((s) => ('id' in s ? s.id : s.type))).toEqual(['installPath']);
    expect(diff.reused.installPath).toBeUndefined();
  });
});
