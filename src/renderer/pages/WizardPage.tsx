import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store';
import { validateAnswer } from '@main/engine/wizard';
import {
  LicenseStep,
  PathStep,
  CheckboxGroupStep,
  SelectStep,
  TextStep,
  SummaryStep,
} from '../components/WizardSteps';
import type { WizardStepT } from '@shared/schema';

export function WizardPage() {
  const navigate = useNavigate();
  const sideload = useStore((s) => s.sideload);
  const wizardAnswers = useStore((s) => s.wizardAnswers);
  const setAnswer = useStore((s) => s.setAnswer);
  const resetWizard = useStore((s) => s.resetWizard);

  const [stepIdx, setStepIdx] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  const steps: WizardStepT[] = useMemo(
    () => sideload?.manifest.wizard ?? [],
    [sideload?.manifest.wizard],
  );

  if (!sideload) {
    return (
      <div>
        No package open.{' '}
        <button onClick={() => navigate('/')} className="text-teal underline">
          Back home
        </button>
      </div>
    );
  }

  const step = steps[stepIdx];
  if (!step) return null;

  const answerForStep = (s: WizardStepT): unknown => {
    switch (s.type) {
      case 'summary':
        return undefined;
      case 'license':
        return (wizardAnswers[s.id] as boolean | undefined) ?? false;
      case 'path':
        return (wizardAnswers[s.id] as string | undefined) ?? s.default;
      case 'text':
        return (wizardAnswers[s.id] as string | undefined) ?? s.default;
      case 'select':
        return (
          (wizardAnswers[s.id] as string | undefined) ??
          s.options.find((o) => o.default)?.value ??
          s.options[0]!.value
        );
      case 'checkboxGroup': {
        const cur = (wizardAnswers[s.id] as Record<string, boolean> | undefined) ?? {};
        const out: Record<string, boolean> = {};
        for (const item of s.items) out[item.id] = cur[item.id] ?? item.default;
        return out;
      }
    }
  };

  const setStepAnswer = (v: unknown) => {
    if ('id' in step) setAnswer(step.id, v);
  };

  const handleNext = () => {
    setStepError(null);
    if (step.type !== 'summary') {
      const value = answerForStep(step);
      const v = validateAnswer(step, value);
      if (!v.ok) {
        setStepError(v.error);
        return;
      }
      // Persist normalized value
      if ('id' in step) setAnswer(step.id, v.value);
    }
    if (stepIdx === steps.length - 1) {
      // Confirmed at summary — run install
      void runInstall();
    } else {
      setStepIdx(stepIdx + 1);
    }
  };

  const handleBack = () => {
    setStepError(null);
    if (stepIdx === 0) {
      resetWizard();
      navigate('/');
    } else {
      setStepIdx(stepIdx - 1);
    }
  };

  async function runInstall() {
    if (!sideload) return;
    navigate('/progress');
    await window.vdxIpc.installRun({
      sessionId: sideload.sessionId,
      wizardAnswers,
      kind: sideload.kind ?? 'app',
    });
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <div className="text-xs text-black/50 mb-1 font-mono">{sideload.manifest.id}</div>
        <h1 className="text-xl font-semibold">
          Install {sideload.manifest.name.default} v{sideload.manifest.version}
        </h1>
        {!sideload.signatureValid && (
          <div className="mt-2 text-xs px-3 py-1.5 bg-amber-50 border border-amber-300 text-amber-900 rounded inline-block">
            ⚠ Untrusted publisher (developer mode)
          </div>
        )}
      </div>

      <div className="mb-6 flex items-center gap-2 text-xs text-black/50">
        Step {stepIdx + 1} of {steps.length}
        <div className="h-1 flex-1 bg-black/5 rounded-full overflow-hidden">
          <div
            className="h-full bg-teal transition-all"
            style={{ width: `${((stepIdx + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="bg-canvas">
        {step.type === 'license' && (
          <LicenseStep
            step={step}
            value={answerForStep(step) as boolean}
            setValue={setStepAnswer}
            error={stepError}
          />
        )}
        {step.type === 'path' && (
          <PathStep
            step={step}
            value={answerForStep(step) as string}
            setValue={setStepAnswer}
            error={stepError}
          />
        )}
        {step.type === 'checkboxGroup' && (
          <CheckboxGroupStep
            step={step}
            value={answerForStep(step) as Record<string, boolean>}
            setValue={setStepAnswer}
            error={stepError}
          />
        )}
        {step.type === 'select' && (
          <SelectStep
            step={step}
            value={answerForStep(step) as string}
            setValue={setStepAnswer}
            error={stepError}
          />
        )}
        {step.type === 'text' && (
          <TextStep
            step={step}
            value={answerForStep(step) as string}
            setValue={setStepAnswer}
            error={stepError}
          />
        )}
        {step.type === 'summary' && <SummaryStep answers={wizardAnswers} />}
      </div>

      <div className="mt-8 flex justify-between">
        <button
          onClick={handleBack}
          className="text-sm px-4 py-2 rounded-md border border-black/10 hover:bg-black/5"
        >
          {stepIdx === 0 ? 'Cancel' : 'Back'}
        </button>
        <button
          onClick={handleNext}
          className="text-sm px-4 py-2 rounded-md bg-teal text-white hover:bg-teal/90"
        >
          {stepIdx === steps.length - 1 ? 'Install' : 'Next'}
        </button>
      </div>
    </div>
  );
}
