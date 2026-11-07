export const RULE_CATEGORIES = ['display', 'prose', 'url', 'repo'] as const

export type RuleCategory = (typeof RULE_CATEGORIES)[number]

export type RuleFlag = 'repoRenamed'

export interface Rule {
  id: string
  category: RuleCategory
  description: string
  pattern: RegExp
  replacement: string
  include: readonly string[]
  exclude: readonly string[]
  skipCode: boolean
  requires?: RuleFlag
}

export interface KeepPattern {
  id: string
  reason: string
  owner: string
  pattern: RegExp
  include?: readonly string[]
}

export interface KeepPath {
  id: string
  reason: string
  owner: string
  globs: readonly string[]
}

export const PROSE_GLOBS: readonly string[] = ['**/*.md', '**/*.mdx']

// Order matters: "Termul Manager" must collapse before the bare word rule, and the
// docs host rules must run before the site rule would see "termul.dev" inside them.
export const RULES: readonly Rule[] = [
  {
    id: 'display-termul-manager',
    category: 'display',
    description: 'The long product name becomes the short one.',
    pattern: /\bTermul Manager\b/g,
    replacement: 'Troupe',
    include: ['**'],
    exclude: [],
    skipCode: false
  },
  {
    id: 'display-termul',
    category: 'display',
    description: 'The capitalised word. Compound identifiers (TermulIcon) do not match.',
    pattern: /\bTermul\b/g,
    replacement: 'Troupe',
    include: ['**'],
    exclude: [],
    skipCode: false
  },
  {
    id: 'docs-url-docs-path',
    category: 'url',
    description: 'docs.termul.dev/docs/... moves under usetroupe.dev/docs.',
    pattern: /(?<![\w.-])docs\.termul\.dev\/docs(?![\w-]|\.\w)/g,
    replacement: 'usetroupe.dev/docs',
    include: ['**'],
    exclude: [],
    skipCode: false
  },
  {
    id: 'docs-url-host',
    category: 'url',
    description: 'Any other docs.termul.dev link lands on the docs root.',
    pattern: /(?<![\w.-])docs\.termul\.dev(?![\w-]|\.\w)/g,
    replacement: 'usetroupe.dev/docs',
    include: ['**'],
    exclude: [],
    skipCode: false
  },
  {
    id: 'site-url',
    category: 'url',
    description: 'The marketing site host. Must not touch the storage key termul.deviceId.',
    pattern: /(?<![\w.-])(?:www\.)?termul\.dev(?![\w-]|\.\w)/g,
    replacement: 'usetroupe.dev',
    include: ['**'],
    exclude: [],
    skipCode: false
  },
  {
    id: 'repo-url',
    category: 'repo',
    description: 'GitHub repo links, only once the repository itself is renamed.',
    pattern: /(?<![\w.-]|[^/]\/)github\.com\/gnoviawan\/termul(?![\w-]|\.(?!git\b)\w)/g,
    replacement: 'github.com/gnoviawan/troupe',
    include: ['**'],
    exclude: [],
    skipCode: false,
    requires: 'repoRenamed'
  },
  {
    id: 'prose-termul',
    category: 'prose',
    description: 'Lowercase product word in running Markdown text, never a path or identifier.',
    pattern: /(?<![\w./\\@$:#~`-])termul(?![\w/\\@:-]|\.\w)/g,
    replacement: 'troupe',
    include: PROSE_GLOBS,
    exclude: [],
    skipCode: true
  }
]

export const KEEP_PATTERNS: readonly KeepPattern[] = [
  {
    id: 'tauri-identifier',
    reason:
      'The bundle identifier keys app data dirs and OS registrations; changing it orphans installs.',
    owner: 'keep forever',
    pattern: /com\.termul-manager\.app(?:\.dev)?/g
  },
  {
    id: 'keychain-manager',
    reason: 'Keychain service name; renaming loses stored credentials.',
    owner: 'keep forever',
    pattern: /com\.termul\.manager/g
  },
  {
    id: 'keychain-ssh',
    reason: 'Keychain service name for SSH secrets; renaming loses stored credentials.',
    owner: 'keep forever',
    pattern: /\btermul-ssh\b/g
  },
  {
    id: 'env-vars',
    reason:
      'Environment variable names are a deployment contract; renamed with aliases separately.',
    owner: 'r2',
    pattern: /\bTERMUL_[A-Z0-9_]*/g
  },
  {
    id: 'binary-names',
    reason: 'Binary and crate names feed packaging, systemd units and install scripts.',
    owner: 'r3/r4',
    pattern: /\btermul[-_](?:server|manager)(?:_lib)?\b/g
  },
  {
    id: 'mcp-name',
    reason: 'The MCP server name is part of every tool id agents already call.',
    owner: 'r7',
    pattern: /mcp__termul__\w*|\btermul(?=\s+MCP\b)/g
  },
  {
    id: 'project-dir',
    reason: 'The per-project .termul directory holds existing state on disk.',
    owner: 'keep until a migration exists',
    pattern: /(?<![\w-])\.termul\b(?:\/[\w./-]*)?/g
  },
  {
    id: 'storage-and-log-prefixes',
    reason:
      'Storage keys (termul.webAuthToken, termul.deviceId) and log targets (termul::web) carry user state and log filters.',
    owner: 'keep until a migration exists',
    pattern: /(?<![\w/.-])termul(?:::|\.(?!dev\b))[A-Za-z_][\w.:-]*/g
  },
  {
    id: 'legacy-artifact-names',
    reason:
      'Releases up to 0.4.60 shipped "Termul Manager.app" and Termul.Manager_* assets; install docs and upgrade code still name them.',
    owner: 'keep forever',
    pattern:
      /\bTermul\.Manager(?![A-Za-z])|\bTermul Manager(?=\.(?:app|AppImage|exe|dmg|msi|deb|rpm)\b|_\d)/g
  },
  {
    id: 'font-family',
    reason:
      'The bundled symbols font is named "Termul Symbols" inside the font binary and in persisted terminal font settings; it is an internal id.',
    owner: 'keep until the font is rebuilt',
    pattern: /\bTermul Symbols\b/g
  },
  {
    id: 'rename-notice',
    reason:
      'The one-time notice tells people who update that the app was renamed; it has to name the old product.',
    owner: 'keep forever',
    pattern: /\bTermul is now Troupe\b/g,
    include: ['src/renderer/lib/rename-notice.ts', 'src/renderer/hooks/use-rename-notice.test.tsx']
  },
  {
    id: 'commit-trailer',
    reason:
      'Commits carry a "Termul-Command-Id:" trailer in users\' git history, and resend lookups read it back; renaming it breaks resends of commits made before 0.5.0.',
    owner: 'keep forever',
    pattern: /\bTermul-Command-Id\b/g
  },
  {
    id: 'windows-state-dir',
    reason:
      'src-tauri/src/web/config.rs stores termul-server state at %LOCALAPPDATA%/Termul via base.join("Termul"); renaming loses Windows server state (Tier B).',
    owner: 'keep until a migration exists',
    pattern:
      /%LOCALAPPDATA%[\\/]Termul\b|\.join\(\s*"Termul"\s*\)|AppData[\\/]+(?:Local|Roaming)[\\/]+Termul(?: Manager)?/g
  },
  {
    id: 'server-binary-url-allowlist',
    reason:
      '0.4.x servers download only from https://github.com/gnoviawan/termul/, so release manifests keep that path after the repo rename. 0.5+ servers must keep accepting it, and the tests that prove it must keep naming it.',
    owner: 'keep while 0.4.x servers update',
    pattern:
      /https:\/\/github\.com\/gnoviawan\/termul\/(?="|releases\/download\/[\w.-]+\/(?:troupe|termul)-server)/g,
    include: ['src-tauri/src/server_update.rs', 'src-tauri/src/server_update/tests.rs']
  }
]

const BINARY_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'icns',
  'svgz',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'pdf',
  'zip',
  'gz',
  'tgz',
  'mp4',
  'webm',
  'mov',
  'wasm',
  'node',
  'exe',
  'dll',
  'so',
  'dylib'
]

export const KEEP_PATHS: readonly KeepPath[] = [
  {
    id: 'changelog',
    reason: 'History records what shipped under the old name.',
    owner: 'keep forever',
    globs: ['**/CHANGELOG.md']
  },
  {
    id: 'bmad',
    reason: 'Planning artifacts are historical records.',
    owner: 'keep forever',
    globs: ['_bmad-output/**', '_bmad/**']
  },
  {
    id: 'lockfiles',
    reason: 'Generated by package managers.',
    owner: 'tooling',
    globs: [
      '**/bun.lock',
      '**/bun.lockb',
      '**/Cargo.lock',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml'
    ]
  },
  {
    id: 'tauri-gen',
    reason: 'Generated by the Tauri CLI.',
    owner: 'tooling',
    globs: ['src-tauri/gen/**']
  },
  {
    id: 'codemod-self',
    reason: 'The codemod names what it replaces.',
    owner: 'r1',
    globs: ['scripts/rebrand/**']
  },
  {
    id: 'design-files',
    reason: 'Design documents are edited in their own tools.',
    owner: 'design',
    globs: ['**/*.pen', '**/*.figcraft']
  },
  {
    id: 'binary-extensions',
    reason: 'Binary assets are not text.',
    owner: 'tooling',
    globs: [`**/*.{${BINARY_EXTENSIONS.join(',')}}`]
  },
  {
    id: 'release-url-pins',
    reason:
      'Release manifests pin https://github.com/gnoviawan/termul/releases/download/<tag>/ because 0.4.x servers reject any other binary URL, and merge-updater-manifests.mjs enforces the pin. GitHub redirects the old path after the repo rename.',
    owner: 'keep while 0.4.x servers update',
    globs: [
      'scripts/release/prepare-platform-artifacts.*',
      'scripts/release/prepare-server-artifacts.*',
      'scripts/release/merge-updater-manifests.*'
    ]
  },
  {
    id: 'packaging',
    reason:
      'Install and release scripts and their tests resolve both 0.4.x and 0.5 asset and app names; r6 renames their display text by hand.',
    owner: 'r6',
    globs: [
      'scripts/install.sh',
      'scripts/release/**',
      'scripts/tests/**',
      'scripts/proc-probe.ps1'
    ]
  },
  {
    id: 'legacy-upgrade-hooks',
    reason:
      'The NSIS hooks and the deb/rpm scripts find and replace the "Termul Manager" install that 0.4.x left behind; they name the old product on purpose.',
    owner: 'keep forever',
    globs: ['src-tauri/windows/installer-hooks.nsh', 'src-tauri/linux/**']
  }
]

export const AREAS: readonly string[] = [
  'src/renderer',
  'src-tauri/src',
  'website-docs',
  'landing',
  'tests',
  'docs',
  '.github',
  'scripts',
  'design-system'
]
