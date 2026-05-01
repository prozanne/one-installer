/**
 * Generate a sample agent-catalog suitable for hosting on GitHub Pages:
 *
 *   dist/agent-catalog/
 *     ├─ catalog.json          ← list of available agents
 *     ├─ catalog.json.sig      ← Ed25519 signature over catalog.json
 *     ├─ vdx-sample-agent-1.0.0.vdxpkg
 *     ├─ vdx-sample-agent-1.0.0.vdxpkg.sha256
 *     └─ README.md             ← deploy-to-Pages instructions
 *
 * The .vdxpkg in this catalog is fully signed by the dev key so a freshly
 * configured `vdx.config.json` pointing at this dir (file:// URLs) installs
 * end-to-end. For real internal deployment, replace dev key with the
 * production VDX Ed25519 signing key (samsung HSM).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ed from '@noble/ed25519';
import { makeVdxpkg } from '../test/helpers/make-vdxpkg';
import { getDevKeys } from '../test/helpers/key-fixtures';
import type { Manifest, CatalogT } from '../src/shared/schema';

interface AgentSpec {
  id: string;
  name: { default: string; ko?: string };
  description: { default: string; ko?: string };
  version: string;
}

const AGENTS: AgentSpec[] = [
  {
    id: 'com.samsung.vdx.code-assistant',
    name: { default: 'Code Assistant', ko: '코드 어시스턴트' },
    description: {
      default: 'Lightweight LLM-backed code completion agent.',
      ko: '경량 LLM 기반 코드 자동완성 에이전트입니다.',
    },
    version: '1.0.0',
  },
  {
    id: 'com.samsung.vdx.review-agent',
    name: { default: 'Review Agent', ko: '리뷰 에이전트' },
    description: {
      default: 'Automated PR-review agent — comments inline.',
      ko: 'PR 자동 리뷰 에이전트입니다.',
    },
    version: '1.0.0',
  },
];

async function buildAgentVdxpkg(spec: AgentSpec): Promise<Buffer> {
  const manifest: Omit<Manifest, 'payload'> = {
    schemaVersion: 1,
    id: spec.id,
    name: spec.name,
    version: spec.version,
    publisher: 'Samsung',
    description: spec.description,
    size: { download: 1024, installed: 4096 },
    minHostVersion: '0.1.0',
    targets: { os: 'win32', arch: ['x64'] },
    installScope: { supports: ['user'], default: 'user' },
    requiresReboot: false,
    license: { type: 'EULA', file: 'EULA.txt', required: true },
    wizard: [
      { type: 'license', id: 'eula', fileFromPayload: 'EULA.txt' },
      {
        type: 'path',
        id: 'installPath',
        label: { default: 'Install location', ko: '설치 위치' },
        default: 'C:/Users/u/AppData/Local/Programs/Samsung/' + spec.id.split('.').pop(),
      },
      { type: 'summary' },
    ],
    install: { extract: [{ from: '**/*', to: '{{installPath}}' }] },
    postInstall: [
      {
        type: 'shortcut',
        where: 'startMenu',
        target: '{{installPath}}/agent.exe',
        name: spec.name.default,
      },
    ],
    uninstall: {
      removePaths: ['{{installPath}}'],
      removeShortcuts: true,
      removeEnvPath: true,
    },
  };

  const { vdxpkgBytes } = await makeVdxpkg({
    manifest,
    payloadFiles: {
      'agent.exe': Buffer.from([0x4d, 0x5a, 0x90, 0x00]), // MZ header — placeholder PE
      'EULA.txt': `Sample EULA for ${spec.name.default}\n\nFor smoke testing only.\n`,
      'agent.json': JSON.stringify({ id: spec.id, version: spec.version }, null, 2),
    },
  });
  return vdxpkgBytes;
}

async function main() {
  const outDir = resolve('dist/agent-catalog');
  mkdirSync(outDir, { recursive: true });

  // Build each agent's .vdxpkg and capture its sha256.
  const apps: CatalogT['apps'] = [];
  for (const spec of AGENTS) {
    const bytes = await buildAgentVdxpkg(spec);
    const fileName = `${spec.id.replace(/[^a-z0-9.-]/gi, '-')}-${spec.version}.vdxpkg`;
    writeFileSync(resolve(outDir, fileName), bytes);
    // sha256 sidecar — operators can verify-by-eye when uploading.
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(resolve(outDir, `${fileName}.sha256`), `${sha}  ${fileName}\n`);

    apps.push({
      id: spec.id,
      displayName: spec.name,
      displayDescription: spec.description,
      latestVersion: spec.version,
      // Relative URL — the catalog must be served from the same Pages root
      // so this resolves correctly. README explains the relative-path
      // contract; operators who serve from a CDN should rewrite to absolute.
      packageUrl: `https://samsung.github.io/agent-catalog/${fileName}`,
      category: 'agents',
      channels: ['stable'],
      tags: ['llm'],
      minHostVersion: '0.1.0',
      deprecated: false,
      replacedBy: null,
      addedAt: '2026-04-30T00:00:00.000Z',
    });
  }

  const catalog: CatalogT = {
    schemaVersion: 1,
    kind: 'agent',
    updatedAt: new Date().toISOString(),
    channels: ['stable'],
    categories: [{ id: 'agents', label: { default: 'Agents', ko: '에이전트' } }],
    featured: AGENTS.map((a) => a.id),
    apps,
  };

  const catalogJson = JSON.stringify(catalog, null, 2);
  const catalogPath = resolve(outDir, 'catalog.json');
  writeFileSync(catalogPath, catalogJson);

  // Sign the catalog with the dev key. In production this signing happens in
  // CI via the HSM; the public key embedded in the host must match.
  const { priv } = await getDevKeys();
  const sig = await ed.signAsync(Buffer.from(catalogJson), priv);
  writeFileSync(resolve(outDir, 'catalog.json.sig'), Buffer.from(sig));

  // README that gets shipped with the catalog so the operator knows how to
  // wire this up. Plain markdown, GitHub Pages renders it.
  const readme = `# Agent Catalog (sample)

Generated by \`scripts/make-sample-agent-catalog.ts\`. Drop the contents of this
directory into the root of an \`agent-catalog\` GitHub Pages branch:

\`\`\`sh
git clone <agent-catalog repo>
cp -r dist/agent-catalog/* <agent-catalog repo>/
cd <agent-catalog repo>
git add . && git commit -m "Publish ${new Date().toISOString().slice(0, 10)}" && git push
\`\`\`

## Files

| Path | Purpose |
|---|---|
| \`catalog.json\` | The catalog the host fetches. |
| \`catalog.json.sig\` | Ed25519 signature over \`catalog.json\` (dev key — replace in prod). |
| \`*.vdxpkg\` | Signed package payloads referenced by entries in catalog.json. |
| \`*.vdxpkg.sha256\` | Sidecar checksum so operators can verify uploads by eye. |

## Configuring the host

In each user's \`vdx.config.json\` (next to the EXE in production, or the
project root in dev), add an \`agentCatalog\` block:

\`\`\`json
{
  "agentCatalog": {
    "url":    "https://samsung.github.io/agent-catalog/catalog.json",
    "sigUrl": "https://samsung.github.io/agent-catalog/catalog.json.sig"
  }
}
\`\`\`

The host's embedded VDX public key verifies \`catalog.json.sig\`. Both the
catalog signature and each \`.vdxpkg\` signature must verify against keys the
host trusts; otherwise the user sees a strong warning before installing.

## Production replacement checklist

- [ ] Replace the dev signing key with the production VDX Ed25519 key (HSM).
- [ ] Move signing into CI (GitHub Actions OIDC → HSM).
- [ ] Replace placeholder \`agent.exe\` payloads with the real agent executables.
- [ ] Switch from \`samsung.github.io\` placeholders to the real Pages domain.
`;
  writeFileSync(resolve(outDir, 'README.md'), readme);

  console.log(`Wrote agent-catalog (${AGENTS.length} agents) to ${outDir}`);
  console.log('Files:');
  console.log('  ' + 'catalog.json');
  console.log('  ' + 'catalog.json.sig');
  console.log('  ' + 'README.md');
  for (const spec of AGENTS) {
    const f = `${spec.id.replace(/[^a-z0-9.-]/gi, '-')}-${spec.version}.vdxpkg`;
    console.log('  ' + f);
    console.log('  ' + f + '.sha256');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
