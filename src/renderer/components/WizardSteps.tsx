import type { WizardStepT } from '@shared/schema';

interface BaseProps<T = unknown> {
  value: T;
  setValue: (v: T) => void;
  error: string | null;
}

export function LicenseStep({
  step,
  value,
  setValue,
  error,
}: BaseProps<boolean> & { step: Extract<WizardStepT, { type: 'license' }> }) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">License agreement</h2>
      <div className="bg-white border border-black/10 rounded-md p-4 max-h-72 overflow-auto text-sm leading-6 whitespace-pre-wrap">
        {step.text?.default ??
          `[End User License Agreement contents would appear here, loaded from ${step.fileFromPayload ?? 'the package'}.]`}
      </div>
      <label className="mt-4 flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => setValue(e.target.checked)}
          className="mt-1"
        />
        <span className="text-sm">I accept the terms of the license agreement.</span>
      </label>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

export function PathStep({
  step,
  value,
  setValue,
  error,
}: BaseProps<string> & { step: Extract<WizardStepT, { type: 'path' }> }) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">{step.label.default}</h2>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full font-mono text-sm px-3 py-2 border border-black/15 rounded-md focus:outline-none focus:border-teal"
      />
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

export function CheckboxGroupStep({
  step,
  value,
  setValue,
  error,
}: BaseProps<Record<string, boolean>> & {
  step: Extract<WizardStepT, { type: 'checkboxGroup' }>;
}) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">{step.label.default}</h2>
      <div className="space-y-2">
        {step.items.map((item) => (
          <label
            key={item.id}
            className={`flex items-start gap-3 cursor-pointer ${item.required ? 'opacity-80' : ''}`}
          >
            <input
              type="checkbox"
              checked={value?.[item.id] ?? false}
              disabled={item.required}
              onChange={(e) => setValue({ ...value, [item.id]: e.target.checked })}
              className="mt-1"
            />
            <span className="text-sm">
              {item.label.default}
              {item.required && <span className="text-black/40"> (required)</span>}
            </span>
          </label>
        ))}
      </div>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

export function SelectStep({
  step,
  value,
  setValue,
  error,
}: BaseProps<string> & { step: Extract<WizardStepT, { type: 'select' }> }) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">{step.label.default}</h2>
      <div className="space-y-2">
        {step.options.map((opt) => (
          <label key={opt.value} className="flex items-center gap-3 cursor-pointer">
            <input
              type="radio"
              name={step.id}
              checked={value === opt.value}
              onChange={() => setValue(opt.value)}
            />
            <span className="text-sm">{opt.label.default}</span>
          </label>
        ))}
      </div>
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

export function TextStep({
  step,
  value,
  setValue,
  error,
}: BaseProps<string> & { step: Extract<WizardStepT, { type: 'text' }> }) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">
        {step.label.default}
        {step.optional && <span className="ml-2 text-sm text-black/40">(optional)</span>}
      </h2>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full text-sm px-3 py-2 border border-black/15 rounded-md focus:outline-none focus:border-teal"
      />
      {step.regex && (
        <div className="mt-1 text-xs text-black/40 font-mono">Pattern: {step.regex}</div>
      )}
      {error && <div className="mt-2 text-sm text-red-600">{error}</div>}
    </div>
  );
}

export function SummaryStep({ answers }: { answers: Record<string, unknown> }) {
  return (
    <div>
      <h2 className="text-lg font-medium mb-3">Ready to install</h2>
      <div className="bg-white border border-black/10 rounded-md p-4 text-sm">
        <div className="font-medium mb-2">Your selections</div>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 gap-x-3 font-mono text-xs">
          {Object.entries(answers).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-black/50">{k}</dt>
              <dd className="break-all">{JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
