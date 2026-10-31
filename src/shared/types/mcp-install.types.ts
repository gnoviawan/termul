/**
 * Wire shapes of the MCP install flow (spine AD-5, AD-7; install-form.md).
 *
 * Installing is plan, consent, commit. The host generates the form
 * (`describe_mcp_install`), builds an immutable plan from the filled
 * non-secret inputs (`plan_mcp_install`), and commits it once the user
 * approves the consent view (`commit_mcp_install`). The HTTP routes are
 * `POST /mcp-catalog/install/{form,plan,commit,cancel}` with the same bodies,
 * and every transport returns the same `IpcResult`.
 */

import type { IpcResult } from './ipc.types'
import type { McpCatalogReason } from './mcp-catalog.types'

/** Where a plan's launch spec comes from. */
export type McpInstallSource =
  | { kind: 'catalog'; name: string; version: string }
  /** An `mcpServers` JSON blob (or one bare server object). `server` picks the
   * entry by its key when the blob holds more than one. */
  | { kind: 'import'; json: string; server?: string }
  /** Not available until the host entry list ships: `MCP_PLAN_NOT_AVAILABLE`. */
  | { kind: 'reapprove'; entryId: string }
  | { kind: 'upgrade'; entryId: string; version: string }

/** Which option of a catalog item to install. Omitted: the item's default option. */
export interface McpInstallChoice {
  kind: 'remote' | 'package'
  index: number
}

export type McpInstallFieldFormat = 'string' | 'number' | 'boolean' | 'filepath'

/** Where a field's value ends up in the launch spec. */
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

/** A chosen option that cannot install, with the AD-4 typed reason. */
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

/** An env or header slot of the resolved config. Values travel separately (AD-6). */
export interface McpResolvedValueSlot {
  name: string
  isSecret: boolean
}

export type McpResolvedConfig =
  | { transport: 'stdio'; command: string; args: string[]; env: McpResolvedValueSlot[] }
  | { transport: 'http' | 'sse'; url: string; headers: McpResolvedValueSlot[] }

/** Catalog provenance of an entry (AD-7 digest input, CAP-8 drift). `null` for imports. */
export interface McpInstallProvenance {
  name: string
  version: string
  kind: 'remote' | 'package'
  index: number
  repositoryId: string | null
}

/** Who supplied a consent-view value. `file` values are shown verbatim (AD-5). */
export type McpConsentValueOrigin = 'registry' | 'user' | 'file'

export interface McpConsentValue {
  name: string
  /** Escaped for display; `null` for a secret, which never leaves the host. */
  value: string | null
  isSecret: boolean
  origin: McpConsentValueOrigin
}

export type McpConsentWarning =
  | 'runs-local-code'
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

/** One env or header value, by slot. Never logged. */
export interface McpResolvedSecret {
  slot: 'env' | 'header'
  name: string
  value: string
}

/**
 * The committed entry, returned to the caller until the trust store ships.
 * The host cannot write the entry list yet, so the renderer persists this
 * (sanctioned interim deviation, stories.yaml story 5). Story 11 replaces
 * this shape with the host-held entry (`entryId` and secret refs) and nothing
 * else about the flow changes.
 */
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
  'MCP_PLAN_WRONG_CALLER'
] as const

export type McpInstallErrorCode = (typeof MCP_INSTALL_ERROR_CODES)[number]

/** The install half of the renderer facade (`McpCatalogApi` extends it). */
export interface McpInstallApi {
  describeInstall(request: McpInstallFormRequest): Promise<IpcResult<McpInstallFormReply>>
  planInstall(request: McpInstallPlanRequest): Promise<IpcResult<McpInstallPlanReply>>
  commitInstall(request: McpInstallCommitRequest): Promise<IpcResult<McpInstallCommitResult>>
  cancelInstall(request: McpInstallCancelRequest): Promise<IpcResult<Record<string, never>>>
}
