# VDX Installer — Data Model & Schema Relationships

**Companion to:** `2026-05-01-vdx-installer-design.md`
**Scope:** Visual representations of data structures, their relationships, lifecycles, and on-disk representations. This is the "shape of the data" view of the system, complementing the behavioral view in `2026-05-01-vdx-installer-flows.md`.

---

## 1. Schema entity relationships

```mermaid
erDiagram
    CATALOG ||--o{ APP_ENTRY : "lists"
    APP_ENTRY ||--|| GITHUB_REPO : "points to"
    GITHUB_REPO ||--o{ RELEASE : "has many"
    RELEASE ||--|| MANIFEST : "contains"
    RELEASE ||--|| PAYLOAD_ZIP : "contains"
    RELEASE ||--|| MANIFEST_SIG : "contains"
    MANIFEST ||--o{ WIZARD_STEP : "declares"
    MANIFEST ||--o{ POST_INSTALL_ACTION : "declares"
    MANIFEST ||--|| UNINSTALL : "declares"
    MANIFEST ||--|| INSTALL : "declares"
    INSTALLED_APP }o--|| MANIFEST : "snapshot of"
    INSTALLED_APP ||--o{ JOURNAL_STEP : "tracks"
    INSTALLED_APP ||--|| WIZARD_ANSWERS : "stores"
    JOURNAL_STEP ||--|| INVERSE_OP : "knows how to"
    INSTALLED_JSON ||--o{ INSTALLED_APP : "contains"
    INSTALLED_JSON ||--|| HOST_SETTINGS : "contains"

    CATALOG {
        int schemaVersion
        string updatedAt
        string[] channels
        Category[] categories
        string[] featured
    }

    APP_ENTRY {
        string id PK
        string repo
        string category
        string[] channels
        string[] tags
        string minHostVersion
        bool deprecated
    }

    MANIFEST {
        int schemaVersion
        string id PK
        Localized name
        string version
        string publisher
        Localized description
        string icon
        Size size
        Payload payload
        string minHostVersion
        Targets targets
        InstallScope installScope
        bool requiresReboot
    }

    INSTALLED_APP {
        string id PK
        string version
        string installScope
        string installPath
        Object wizardAnswers
        JournalStep[] journal
        Manifest manifestSnapshot
        string installedAt
        string updateChannel
        string autoUpdate
        string source
    }
```

---

## 2. Manifest internal structure

```mermaid
graph TB
    Man[manifest.json] --> Meta[metadata]
    Man --> Pay[payload<br/>filename + sha256]
    Man --> Targets[targets<br/>os, arch, minOsBuild]
    Man --> Scope[installScope<br/>supports, default]
    Man --> Wiz[wizard array]
    Man --> Inst[install]
    Man --> Post[postInstall array]
    Man --> Un[uninstall]

    Wiz --> WL[license]
    Wiz --> WP[path]
    Wiz --> WC[checkboxGroup]
    Wiz --> WS[select]
    Wiz --> WT[text]
    Wiz --> WSm[summary]

    Inst --> Ext[extract array<br/>from, to, when]

    Post --> PSc[shortcut]
    Post --> PR[registry]
    Post --> PE[envPath]
    Post --> PX[exec - allowedHashes]

    Un --> UR[removePaths]
    Un --> URg[removeRegistry]
    Un --> USc[removeShortcuts]
    Un --> UEnv[removeEnvPath]
    Un --> UPre[preExec]

    classDef container fill:#eef6ff,stroke:#3b82f6;
    classDef wizard fill:#fef3c7,stroke:#f59e0b;
    classDef action fill:#fee2e2,stroke:#dc2626;
    class Wiz container
    class WL,WP,WC,WS,WT,WSm wizard
    class PSc,PR,PE,PX action
```

---

## 3. Trust artifact relationships

```mermaid
graph LR
    subgraph HSM["Cloud HSM (Azure / Google)"]
        EVK[Authenticode EV<br/>private key]
        EdK[Ed25519<br/>private key]
    end

    subgraph CI["GitHub Actions (OIDC-bound)"]
        Sign1[Sign EXE workflow]
        Sign2[Sign manifest workflow]
        Sign3[Sign catalog workflow]
    end

    subgraph Artifacts["Distributed artifacts"]
        Exe[vdx-installer-Setup.exe]
        Cat[catalog.json + .sig]
        Man[manifest.json + .sig]
    end

    subgraph Host["Inside vdx-installer.exe"]
        Pub[Embedded VDX<br/>Ed25519 public key]
        OS[Windows<br/>Authenticode trust store]
    end

    EVK -.HSM access.-> Sign1
    EdK -.HSM access.-> Sign2
    EdK -.HSM access.-> Sign3
    Sign1 --> Exe
    Sign2 --> Man
    Sign3 --> Cat
    Pub -.verifies.-> Cat
    Pub -.verifies.-> Man
    OS -.verifies.-> Exe
    Exe -.contains.-> Pub

    classDef key fill:#fee2e2,stroke:#dc2626;
    classDef ci fill:#dbeafe,stroke:#3b82f6;
    classDef art fill:#f0fdf4,stroke:#16a34a;
    classDef host fill:#fef3c7,stroke:#f59e0b;
    class HSM key
    class CI ci
    class Artifacts art
    class Host host
```

---

## 4. installed.json layout

```mermaid
graph TB
    Root[installed.json] --> Schema[schema: 1]
    Root --> Host[host: { version }]
    Root --> Last[lastCatalogSync]
    Root --> Settings[settings]
    Root --> Apps[apps map]

    Settings --> SLang[language]
    Settings --> SChan[updateChannel]
    Settings --> SAuto[autoUpdateHost / Apps]
    Settings --> SCache[cacheLimitGb]
    Settings --> SProxy[proxy]
    Settings --> STel[telemetry]
    Settings --> STray[trayMode]
    Settings --> SDev[developerMode]

    Apps --> A1[com.samsung.vdx.exampleapp]
    Apps --> A2[com.samsung.vdx.anotherapp]
    Apps --> A3[...]

    A1 --> AVer[version]
    A1 --> AScope[installScope]
    A1 --> APath[installPath]
    A1 --> AAns[wizardAnswers]
    A1 --> AJ[journal array]
    A1 --> AMan[manifestSnapshot]
    A1 --> AAt[installedAt]
    A1 --> AAu[autoUpdate]
    A1 --> ASrc[source]

    AJ --> J1[extract step]
    AJ --> J2[shortcut step]
    AJ --> J3[registry step]
    AJ --> J4[envPath step]
```

---

## 5. Filesystem layout (full)

```mermaid
graph TB
    Root["%APPDATA%/vdx-installer/"]
    Root --> St[installed.json]
    Root --> StB[installed.json.bak]
    Root --> Cache[cache/]
    Root --> Logs[logs/]
    Root --> Locks[locks/]
    Root --> Journal[journal/]

    Cache --> CCat[catalog/<br/>catalog.json snapshots]
    Cache --> CApp[<app-id>/]
    CApp --> CVer[<version>/]
    CVer --> CPay[payload.zip]
    CVer --> CMan[manifest.json]
    CVer --> CSig[manifest.json.sig]
    CVer --> CPart[payload.zip.partial<br/>during download]

    Logs --> L1[installer-2026-04-30.log]
    Logs --> L2[installer-2026-05-01.log]
    Logs --> L3[...rolling 14d]

    Locks --> LK1[<app-id>.lock]

    Journal --> Tx1[<txid>.json<br/>pending tx during install]

    classDef state fill:#dcfce7,stroke:#16a34a;
    classDef cache fill:#dbeafe,stroke:#3b82f6;
    classDef logs fill:#fef3c7,stroke:#f59e0b;
    classDef tx fill:#fee2e2,stroke:#dc2626;
    class St,StB state
    class Cache,CCat,CApp,CVer,CPay,CMan,CSig,CPart cache
    class Logs,L1,L2,L3 logs
    class Locks,LK1,Journal,Tx1 tx
```

Plus the app's own install destination (e.g., `%LocalAppData%\Programs\Samsung\<App>` or `C:\Program Files\Samsung\<App>` per scope) which is *outside* this directory tree.

---

## 6. Wizard answer types

```mermaid
classDiagram
    class WizardStep {
        <<abstract>>
        +string id
        +string type
    }

    class LicenseStep {
        +"license" type
        +string fileFromPayload
        +Localized? text
    }

    class PathStep {
        +"path" type
        +Localized label
        +string default
        +string[] validate
    }

    class CheckboxGroupStep {
        +"checkboxGroup" type
        +Localized label
        +Item[] items
    }

    class SelectStep {
        +"select" type
        +Localized label
        +Option[] options
    }

    class TextStep {
        +"text" type
        +Localized label
        +string default
        +string regex
        +bool optional
    }

    class SummaryStep {
        +"summary" type
    }

    WizardStep <|-- LicenseStep
    WizardStep <|-- PathStep
    WizardStep <|-- CheckboxGroupStep
    WizardStep <|-- SelectStep
    WizardStep <|-- TextStep
    WizardStep <|-- SummaryStep

    class WizardAnswers {
        +Map~string, AnswerValue~ answers
    }

    class AnswerValue {
        <<union>>
        bool
        string
        Map~string, bool~
    }

    WizardAnswers --> AnswerValue : "id -> value"
```

---

## 7. Post-install action types

```mermaid
classDiagram
    class PostInstallAction {
        <<abstract>>
        +string type
        +string? when
    }

    class ShortcutAction {
        +"shortcut" type
        +"desktop|startMenu|programs" where
        +string target
        +string name
        +string? args
    }

    class RegistryAction {
        +"registry" type
        +"HKCU|HKLM" hive
        +string key
        +Map~string, RegValue~ values
    }

    class EnvPathAction {
        +"envPath" type
        +"user|machine" scope
        +string add
    }

    class ExecAction {
        +"exec" type
        +string cmd
        +string[] args
        +int timeoutSec
        +string[] allowedHashes
    }

    PostInstallAction <|-- ShortcutAction
    PostInstallAction <|-- RegistryAction
    PostInstallAction <|-- EnvPathAction
    PostInstallAction <|-- ExecAction

    class JournalStep {
        +string type
        +Object inverse
    }

    ShortcutAction --> JournalStep : "creates inverse: delete shortcut"
    RegistryAction --> JournalStep : "creates inverse: restore prev value"
    EnvPathAction --> JournalStep : "creates inverse: remove entry"
    ExecAction --> JournalStep : "creates record (no inverse)"
```

---

## 8. State transitions: an installed app over time

```mermaid
stateDiagram-v2
    [*] --> Browsing: appears in catalog
    Browsing --> Installing: user clicks Install
    Installing --> Installed: tx commits
    Installing --> [*]: tx aborts (rollback)
    Installed --> Updating: new version + user/auto trigger
    Updating --> Installed: tx commits
    Updating --> Installed: tx aborts (kept old version)
    Installed --> Uninstalling: user / Apps & features
    Uninstalling --> [*]: tx commits
    Uninstalling --> Installed: tx aborts (kept install)
    Installed --> NeedsHostUpdate: catalog requires newer host
    NeedsHostUpdate --> Installed: host updated
    Installed --> Deprecated: catalog marks deprecated
    Deprecated --> Installed: visible warning, still works
```

---

## 9. Mapping: manifest fields → effects on system

```mermaid
graph LR
    subgraph Manifest
        IPath[install.extract]
        Sc[postInstall.shortcut]
        Reg[postInstall.registry]
        Env[postInstall.envPath]
        Exec[postInstall.exec]
        Un[uninstall.*]
    end

    subgraph SystemEffect
        Files[Files in installPath]
        Lnk[.lnk on Desktop / Start Menu]
        RegKey[HKCU/HKLM keys]
        Path[user/machine PATH var]
        Proc[Process spawned once]
        ARP[Apps & features entry]
    end

    Implicit[host implicit] --> ARP

    IPath --> Files
    Sc --> Lnk
    Reg --> RegKey
    Env --> Path
    Exec --> Proc
    Un -.removes.-> Files
    Un -.removes.-> Lnk
    Un -.removes.-> RegKey
    Un -.removes.-> Path
    Un -.removes.-> ARP

    classDef sys fill:#f0fdf4,stroke:#16a34a;
    class Files,Lnk,RegKey,Path,Proc,ARP sys
```

---

## 10. IPC channels and zod schemas

```mermaid
graph LR
    subgraph SharedSchemas[shared/ipc.ts]
        S1[CatalogListReq/Res]
        S2[CatalogRefreshReq/Res]
        S3[InstallPrepareReq/Res]
        S4[InstallRunReq/Res]
        S5[InstallProgressEvent]
        S6[UpdateCheckReq/Res]
        S7[UpdateRunReq/Res]
        S8[UninstallRunReq/Res]
        S9[SettingsGetReq/Res]
        S10[SettingsSetReq/Res]
        S11[AuthSetTokenReq/Res]
        S12[AuthClearTokenReq/Res]
        S13[DiagExportReq/Res]
        S14[DiagOpenLogsReq/Res]
        S15[CatalogUpdatedEvent]
        S16[UpdateAvailableEvent]
    end

    subgraph Renderer[Renderer typed client]
        RC[ipc client]
    end
    subgraph Main[Main typed handler]
        MH[ipc server]
    end

    RC -. zod-validates request .- SharedSchemas
    MH -. zod-validates request .- SharedSchemas
    RC -- IPC --> MH
    MH -- IPC --> RC

    classDef schema fill:#fef3c7,stroke:#f59e0b;
    class SharedSchemas schema
```

Channel naming convention: `<domain>:<verb>` for commands (`install:run`); past-tense events fired from main use `<domain>:<eventName>` (`catalog:updated`, `install:progress`).

---

## 11. Versioning of artifacts

```mermaid
graph LR
    subgraph V1["v1 artifacts (current)"]
        H1[Host 1.x.x]
        M1[manifest schemaVersion 1]
        C1[catalog schemaVersion 1]
        I1[installed.json schema 1]
    end

    subgraph V2["v2 artifacts (future)"]
        H2[Host 2.x.x]
        M2[manifest schemaVersion 2]
        C2[catalog schemaVersion 2]
        I2[installed.json schema 2]
    end

    H1 -.reads.-> M1
    H1 -.reads.-> C1
    H1 -.reads.-> I1

    H2 -.reads.-> M2
    H2 -.reads.-> M1
    H2 -.reads.-> C2
    H2 -.reads.-> C1
    H2 -.reads + migrates.-> I1
    H2 -.reads.-> I2

    classDef v1 fill:#dbeafe,stroke:#3b82f6;
    classDef v2 fill:#dcfce7,stroke:#16a34a;
    class V1 v1
    class V2 v2
```

Compatibility commitment: a host of major version N reads manifests/catalogs from major version N-1 for at least one major-version cycle. installed.json is migrated forward in place; never broken backwards.

---

## 12. Trust → action chain

```mermaid
flowchart LR
    UserClick[User clicks Install] --> CatTrust{Catalog<br/>signature OK?}
    CatTrust -->|Yes| ManFetch[Fetch manifest + sig]
    CatTrust -->|No| WarnCat[Use cached or block]
    ManFetch --> ManTrust{Manifest<br/>signature OK?}
    ManTrust -->|Yes| Schema[zod schema validate]
    ManTrust -->|No| RejectMan[Reject]
    Schema --> Static[Static checks:<br/>installScope, targets,<br/>exec hashes present,<br/>template vars resolvable]
    Static --> Pass{Pass?}
    Pass -->|No| RejectStatic[Reject manifest]
    Pass -->|Yes| Wiz[Run wizard]
    Wiz --> Pay[Download payload]
    Pay --> PayTrust{sha256 matches<br/>manifest.payload.sha256?}
    PayTrust -->|No| RejectPay[Reject payload]
    PayTrust -->|Yes| ExtractGuard[Zip-slip guard,<br/>symlink reject]
    ExtractGuard --> ExecCheck{Each exec binary's<br/>sha256 in allowedHashes?}
    ExecCheck -->|No| RejectExec[Reject manifest at runtime]
    ExecCheck -->|Yes| Run[Begin transactional install]
```

Every gate above must pass before the next; failure aborts cleanly with no system state changes.

---

## 13. Repos and their relationships

```mermaid
graph TB
    subgraph SamsungOrg[GitHub: samsung/]
        Inst[vdx-installer<br/>The Electron app]
        Pack[vdx-pack<br/>CLI + schemas npm pkg]
        Action[vdx-pack-action<br/>GitHub Action]
        Tmpl[vdx-app-template<br/>Template repo]
        Sign[vdx-signing-service<br/>Reusable workflow]
        Cat[vdx-catalog<br/>catalog.json + sig]
        Docs[vdx-docs<br/>GitHub Pages]
        AppA[Sample app: vdx-example-app]
        AppB[Real app: <team>-app-1]
        AppC[Real app: <team>-app-2]
    end

    Inst -.depends on.-> Pack
    Action -.depends on.-> Pack
    Action -.calls.-> Sign
    Tmpl -.uses.-> Action
    AppA -.from template.-> Tmpl
    AppB -.from template.-> Tmpl
    AppC -.from template.-> Tmpl
    Cat -.references.-> AppA
    Cat -.references.-> AppB
    Cat -.references.-> AppC
    Inst -.fetches.-> Cat
    Inst -.fetches via Cat.-> AppA
    Inst -.fetches via Cat.-> AppB
    Inst -.fetches via Cat.-> AppC
    Docs -.documents.-> Inst
    Docs -.documents.-> Pack
    Docs -.documents.-> Tmpl

    classDef host fill:#fef3c7,stroke:#f59e0b;
    classDef tools fill:#dbeafe,stroke:#3b82f6;
    classDef apps fill:#dcfce7,stroke:#16a34a;
    classDef docs fill:#f3e8ff,stroke:#a855f7;
    class Inst host
    class Pack,Action,Tmpl,Sign tools
    class Cat,AppA,AppB,AppC apps
    class Docs docs
```

---

## 14. Settings keys → effects

```mermaid
flowchart LR
    subgraph Setting
        Lang[language]
        Chan[updateChannel]
        AutoH[autoUpdateHost]
        AutoA[autoUpdateApps]
        Cache[cacheLimitGb]
        Proxy[proxy]
        Tel[telemetry]
        Tray[trayMode]
        Dev[developerMode]
    end

    subgraph Effect
        Render[Renderer rerender + manifest.name resolution]
        Visible[Which app channels visible]
        SelfUp[Host updater behavior]
        AppUp[App updater behavior]
        EvictLRU[Cache eviction trigger]
        AllNet[All HTTP traffic]
        OptIn[Counters dispatch]
        TrayIcon[Window close behavior]
        SigBypass[Sig requirement on install]
    end

    Lang --> Render
    Chan --> Visible
    AutoH --> SelfUp
    AutoA --> AppUp
    Cache --> EvictLRU
    Proxy --> AllNet
    Tel --> OptIn
    Tray --> TrayIcon
    Dev --> SigBypass
```

---

## Appendix — Schema source of truth

| Schema | Authoritative location |
|---|---|
| Manifest v1 | `samsung/vdx-pack/schemas/manifest-v1.json` (also published at `https://vdx.samsung.com/schema/manifest-v1.json`) |
| Catalog v1 | `samsung/vdx-pack/schemas/catalog-v1.json` |
| installed.json v1 | `samsung/vdx-installer/src/shared/state-schema.ts` (zod) |
| IPC contracts | `samsung/vdx-installer/src/shared/ipc.ts` (zod) |
| Journal step | `samsung/vdx-installer/src/main/engine/transaction.ts` (zod) |

All zod-defined schemas are exported as JSON Schema for editor completion via `pnpm export-schemas`.
