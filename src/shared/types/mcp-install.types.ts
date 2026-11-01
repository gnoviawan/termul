import type { IpcResult } from './ipc.types'
import type { McpCatalogReason } from './mcp-catalog.types'

export type McpInstallSource =
  | { kind: 'catalog'; name: string; version: string }
  /** An `mcpServers` JSON blob (or one bare server object). `server` picks the
   * entry by its key when the blob holds more than one. */
  | { kind: 'import'; json: string; server?: string }
  | { kind: 'reapprove'; entryId: string }
  | { kind: 'upgrade'; entryId: string; version: string }

/** Which option of a catalog item to install. Omitted: the item's default option. */
export interface McpInstallChoice {
  kind: 'remote' | 'package'
  index: number
}

export type McpInstallFieldFormat = 'string' | 'number' | 'boolean' | 'filepath'

export type McpInstallFieldTarget =
  | { kind: 'env'; name: string }
  | { kind: 'header'; name: string }
  /** A `packageArguments` entry: `name` for a named argument, `null` for positional. */
  | { kind: 'argument'; index: number; name: string | null }
  | { kind: 'url' }

/**
 * One generated form field (install-form.md). Secret fields are collected by
 * the form but sent only at commit, in `secretValues`; every other field is
 * sent at plan time, in `inputs`. Both maps are keyed by `id`.
 */
export interface McpInstallField {
  id: string
  label: string
  target: McpInstallFieldTarget
  /** The template variable this field fills, or `null` when it is the whole value. */
  variable: string | null
  isRequired: boolean
  isSecret: boolean
  format: McpInstallFieldFormat
  choices: string[] | null
  default: string | null
  placeholder: string | null
  description: string | null
}

export interface McpInstallForm {
  source: McpInstallSource
  choice: McpInstallChoice | null
  /** Display title: the registry title or name, or the import entry's key. */
  title: string
  fields: McpInstallField[]
}

export interface McpInstallUnsupported {
  outcome: 'unsupported'
  reason: McpCatalogReason
}

export type McpInstallFormReply = { outcome: 'form'; form: McpInstallForm } | McpInstallUnsupported

export interface McpInstallFormRequest {
  source: McpInstallSource
  choice?: McpInstallChoice
}

export interface McpInstallPlanRequest {
  source: McpInstallSource
  choice?: McpInstallChoice
  /** Non-secret field values by field id. A secret field id here is a `VALIDATION_ERROR`. */
  inputs: Record<string, string>
}

export interface McpResolvedValueSlot {
  name: string
  isSecret: boolean
}

export type McpResolvedConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: McpResolvedValueSlot[] }
  | { transport: 'http' | 'sse'; url: string; headers: McpResolvedValueSlot[] }

export interface McpInstallProvenance {
  name: string
  version: string
  kind: 'remote' | 'package'
  index: number
  repositoryId: string | null
}

export interface McpEntryCatalogProvenance extends McpInstallProvenance {
  source: 'mcp-registry'
  launchDigest: string
}

export type McpConsentValueOrigin = 'registry' | 'user' | 'file'

export interface McpConsentValue {
  name: string
  /**
   * What will be stored, or `null` when the whole value is one the user types
   * into a secret field. A registry template keeps each secret variable as its
   * `{name}` placeholder, so the registry text around it is still shown.
   */
  value: string | null
  /** Part or all of the value is a secret the user types; it is not shown. */
  isSecret: boolean
  origin: McpConsentValueOrigin
}

export type McpConsentWarning =
  | 'runs-local-code'
  | 'runs-inline-code'
  | 'mounts-host-path'
  | 'mounts-sensitive-path'
  | 'sends-data-remote'
  | 'mutable-tag'
  | 'deprecated'
  | 'from-file'

export type McpConsentNamespace =
  /** `io.github.<account>/…`: bound to a GitHub account. */
  | { kind: 'github'; account: string }
  /** Reverse-DNS: domain-verified. */
  | { kind: 'domain'; domain: string }

export interface McpConsentProvenance {
  namespace: McpConsentNamespace
  /** Passed the AD-15 safe-URL guard, or `null`. */
  repositoryUrl: string | null
  version: string
  /** An OCI image pinned by tag, not digest. */
  mutableTag: boolean
  snapshotFetchedAt: string | null
}

/** A host path a docker launch mounts into its container. */
export interface McpHostMount {
  /** Escaped like `argv`. */
  hostPath: string
  /** The filesystem root, a home directory, or the docker socket. */
  sensitive: boolean
}

/**
 * The SEP-1024 consent view. `command`, `argv` and `url` are the exact launch
 * spec, untruncated, with control and bidi characters escaped as `\u{XXXX}`
 * (and `\` as `\\`), so what is shown is what runs.
 */
export interface McpConsentView {
  transport: 'stdio' | 'http' | 'sse'
  command: string | null
  /** Full argv, `argv[0]` included. */
  argv: string[]
  url: string | null
  env: McpConsentValue[]
  headers: McpConsentValue[]
  hostMounts: McpHostMount[]
  warnings: McpConsentWarning[]
  provenance: McpConsentProvenance | null
}

/** Immutable, single-use, TTL-bound and bound to the caller that created it (AD-5). */
export interface McpInstallPlan {
  planId: string
  /** Proposed wire name, from the registry title slug or the import key. */
  name: string
  source: McpInstallSource
  choice: McpInstallChoice | null
  expiresAt: string
  config: McpResolvedConfig
  form: McpInstallField[]
  consentView: McpConsentView
  launchDigest: string
}

export type McpInstallPlanReply = { outcome: 'plan'; plan: McpInstallPlan } | McpInstallUnsupported

export interface McpInstallCommitRequest {
  planId: string
  /** The digest the consent view showed; a mismatch is `MCP_PLAN_MISMATCH`. */
  launchDigest: string
  /** Secret field values by field id. A non-secret id here is a `VALIDATION_ERROR`. */
  secretValues: Record<string, string>
}

export interface McpResolvedSecret {
  slot: 'env' | 'header'
  name: string
  value: string
}

export interface McpInstallCommitResult {
  name: string
  config: McpResolvedConfig
  /** Every env and header value (AD-6 stores all of them as secrets). */
  secrets: McpResolvedSecret[]
  provenance: McpInstallProvenance | null
  launchDigest: string
}

export interface McpInstallCancelRequest {
  planId: string
}

/** Plan and commit failure codes, beyond `VALIDATION_ERROR` and the transport's write refusal. */
export const MCP_INSTALL_ERROR_CODES = [
  'MCP_CATALOG_NOT_FOUND',
  'MCP_IMPORT_INVALID',
  'MCP_PLAN_NOT_AVAILABLE',
  'MCP_PLAN_NOT_FOUND',
  'MCP_PLAN_CONSUMED',
  'MCP_PLAN_EXPIRED',
  'MCP_PLAN_MISMATCH',
  'MCP_PLAN_WRONG_CALLER',
  'MCP_PLAN_LIMIT'
] as const

export type McpInstallErrorCode = (typeof MCP_INSTALL_ERROR_CODES)[number]

export interface McpInstallApi {
  describeInstall(request: McpInstallFormRequest): Promise<IpcResult<McpInstallFormReply>>
  planInstall(request: McpInstallPlanRequest): Promise<IpcResult<McpInstallPlanReply>>
  commitInstall(request: McpInstallCommitRequest): Promise<IpcResult<McpInstallCommitResult>>
  cancelInstall(request: McpInstallCancelRequest): Promise<IpcResult<Record<string, never>>>
}
