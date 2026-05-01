# VDX Installer — Phase 1.1: Electron Shell + Sideload UI

> Continues Phase 1.0. Goal: end-to-end runnable app on macOS dev — drop a `.vdxpkg` → wizard → install → see installed apps list → uninstall.

**Architecture:** Electron + electron-vite (bundles main, preload, renderer). React 19 + TypeScript + Tailwind + Zustand. Typed IPC (zod-validated). Engine from Phase 1.0 driven by `MockPlatform` in dev (real Windows impl deferred to 1.2).

**Out of scope (later phases):** Real Windows platform, code signing, catalog network, self-update, settings UI beyond defaults, i18n, tray.

## File structure

```
vdx-installer/
├─ electron.vite.config.ts              electron-vite config
├─ tailwind.config.js
├─ postcss.config.js
├─ index.html                            renderer entry
├─ src/
│  ├─ main/index.ts                      (already exists — engine façade; rename existing → engine.ts)
│  ├─ main/electron-main.ts              new: Electron main process entry
│  ├─ main/host.ts                       new: paths, dev-keys, app data dir
│  ├─ main/ipc/                          new: server side
│  │  ├─ contracts.ts                    zod IPC schemas
│  │  ├─ server.ts                       handler registration
│  │  ├─ install.ts                      install:prepare / install:run handlers
│  │  ├─ uninstall.ts
│  │  ├─ apps.ts                         apps:list
│  │  ├─ sideload.ts                     sideload:open
│  │  └─ progress.ts                     event emitter
│  ├─ preload/index.ts                   contextBridge typed client
│  ├─ renderer/
│  │  ├─ main.tsx                        React entry + router
│  │  ├─ App.tsx                         layout shell
│  │  ├─ ipc-client.ts                   typed wrapper around window.ipc
│  │  ├─ store.ts                        Zustand store
│  │  ├─ pages/
│  │  │   ├─ HomePage.tsx               installed list + drop zone
│  │  │   ├─ WizardPage.tsx
│  │  │   └─ ProgressPage.tsx
│  │  ├─ components/
│  │  │   ├─ WizardSteps/{License,Path,CheckboxGroup,Select,Text,Summary}.tsx
│  │  │   ├─ ProgressBar.tsx
│  │  │   ├─ AppCard.tsx
│  │  │   └─ DropZone.tsx
│  │  ├─ styles.css                      tailwind directives
│  └─ shared/ipc-types.ts                shared zod IPC schemas
```

## Tasks

### Task 1: install electron + vite + react + tailwind

- Install: `electron@33` `electron-vite` `electron-builder` `react@^19` `react-dom@^19` `react-router-dom@^6` `zustand` `tailwindcss` `postcss` `autoprefixer` `@types/react` `@types/react-dom` `@vitejs/plugin-react`
- Add `tailwind.config.js`, `postcss.config.js`, `electron.vite.config.ts`
- Add scripts: `"dev": "electron-vite dev"`, `"build": "electron-vite build"`, `"start": "electron-vite preview"`, `"dist": "electron-vite build && electron-builder --mac --dir"` (mac dev) / `--win` (real release)
- Move existing `src/main/index.ts` to `src/main/engine.ts` and re-export from main façade

### Task 2: shared IPC contracts (zod)

`src/shared/ipc-types.ts` defines:
- `apps:list` → `InstalledStateT['apps']`
- `sideload:open` (vdxpkgPath) → `{ ok: true, manifest, defaults }` | `{ ok: false, error }`
- `install:run` ({ manifest, payloadBytesB64, wizardAnswers }) → `{ ok, installPath, error? }`
- `uninstall:run` (appId) → `{ ok, error? }`
- Event channel: `install:progress` ({ phase, message, percent? })

### Task 3: Electron main process

- Single instance lock, single BrowserWindow, dev URL or file URL
- Wire IPC handlers
- Initialize installed-store with `app.getPath('userData')` paths
- For dev: use `MockPlatform`. Add a way to switch to real Windows later.

### Task 4: preload + renderer bootstrap

- Preload exposes `window.ipc` typed via shared contracts
- React + router (memory router OK)
- Tailwind globals
- Layout shell: header w/ "VDX Installer" title + dev mode badge, content area, footer w/ version

### Task 5: Home page

- "Installed apps" list with uninstall button per row
- Drop zone for `.vdxpkg` files
- File-open dialog button as alternative

### Task 6: Wizard page (all step types)

- Each step type as own component
- Forward/Back navigation, summary page
- Cancel returns home

### Task 7: Progress + error pages

- Live progress events from main
- Error view with diagnostics-friendly text

### Task 8: Sideload flow integration

- main: parse vdxpkg → respond to renderer with manifest + recommended defaults
- renderer: navigate to wizard
- on confirm: call install:run, navigate to progress, show result

### Task 9: Smoke test (manual)

- Run `npm run dev`
- Drop a `.vdxpkg` produced by `makeVdxpkg` test helper
- Walk through wizard, install
- Verify app shows in installed list
- Uninstall

This phase is intentionally manual for the smoke verification — Playwright/Electron E2E lands later.

---

That is a lot. Starts now.
