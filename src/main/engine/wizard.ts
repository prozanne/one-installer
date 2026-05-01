import type { WizardStepT } from '@shared/schema';
import type { AnswerValue } from '@shared/types';
import { ok, err, type Result } from '@shared/types';

export function computeWizardOrder(steps: WizardStepT[]): WizardStepT[] {
  return [...steps];
}

export function validateAnswer(step: WizardStepT, answer: unknown): Result<AnswerValue, string> {
  switch (step.type) {
    case 'license':
      return answer === true ? ok(true) : err('License must be accepted');
    case 'path': {
      if (typeof answer !== 'string') return err('Path must be a string');
      if (answer.trim() === '') return err('Path cannot be empty');
      return ok(answer);
    }
    case 'text': {
      if (typeof answer !== 'string') return err('Text must be a string');
      if (!step.optional && answer.trim() === '') return err('Field is required');
      if (step.regex) {
        const re = new RegExp(step.regex);
        if (!re.test(answer)) return err(`Does not match pattern: ${step.regex}`);
      }
      return ok(answer);
    }
    case 'select': {
      if (typeof answer !== 'string') return err('Select value must be a string');
      const valid = step.options.some((o) => o.value === answer);
      return valid ? ok(answer) : err(`Value '${answer}' not in options`);
    }
    case 'checkboxGroup': {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        return err('Checkbox group answer must be an object');
      }
      const obj = answer as Record<string, unknown>;
      for (const item of step.items) {
        const v = obj[item.id];
        if (typeof v !== 'boolean') return err(`Missing or non-boolean for '${item.id}'`);
        if (item.required && v === false) return err(`'${item.id}' is required`);
      }
      const out: Record<string, boolean> = {};
      for (const item of step.items) out[item.id] = obj[item.id] as boolean;
      return ok(out);
    }
    case 'summary':
      return ok(true);
  }
}

export interface WizardDiff {
  mustAsk: WizardStepT[];
  reused: Record<string, unknown>;
  canSkipWizard: boolean;
}

const stepKey = (s: WizardStepT): string => ('id' in s ? s.id : s.type);

export function diffWizardForReuse(
  newSteps: WizardStepT[],
  oldSteps: WizardStepT[],
  savedAnswers: Record<string, unknown>,
): WizardDiff {
  const oldByKey = new Map(oldSteps.map((s) => [stepKey(s), s]));
  const mustAsk: WizardStepT[] = [];
  const reused: Record<string, unknown> = {};
  for (const ns of newSteps) {
    if (ns.type === 'summary') continue;
    const key = stepKey(ns);
    const os = oldByKey.get(key);
    if (os && os.type === ns.type && key in savedAnswers) {
      reused[key] = savedAnswers[key];
    } else {
      mustAsk.push(ns);
    }
  }
  return { mustAsk, reused, canSkipWizard: mustAsk.length === 0 };
}
