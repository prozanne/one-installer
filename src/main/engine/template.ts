const USER_VAR_RE = /\{\{([a-zA-Z_][a-zA-Z0-9_.]*)\}\}/g;
const SYS_VAR_RE = /\{([A-Z][a-zA-Z0-9]*)\}/g;

export type SystemVars = Record<string, string>;
export type Context = Record<string, unknown>;

const get = (obj: Context, path: string): unknown => {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as object)) {
      return (acc as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
};

export function renderTemplate(input: string, ctx: Context, sysVars: SystemVars = {}): string {
  let result = input.replace(USER_VAR_RE, (_, key: string) => {
    const value = get(ctx, key);
    if (value === undefined) throw new Error(`Template variable not defined: {{${key}}}`);
    return String(value);
  });
  result = result.replace(SYS_VAR_RE, (_, key: string) => {
    if (!(key in sysVars)) throw new Error(`System variable not defined: {${key}}`);
    return sysVars[key]!;
  });
  return result;
}

export function resolveVariables(input: string): { userVars: string[]; systemVars: string[] } {
  const userVars = new Set<string>();
  const systemVars = new Set<string>();
  for (const m of input.matchAll(USER_VAR_RE)) userVars.add(m[1]!);
  for (const m of input.matchAll(SYS_VAR_RE)) systemVars.add(m[1]!);
  return { userVars: [...userVars], systemVars: [...systemVars] };
}
