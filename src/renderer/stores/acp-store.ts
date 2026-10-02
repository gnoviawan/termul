/**
 * ACP agent chat store — public facade.
 *
 * The implementation lives in the `acp-store/` module directory (spec-04):
 * `acp-store/index.ts` composes the domain slices in `acp-store/slices/`,
 * `acp-store/types.ts` holds the `AcpState` contract, `acp-store/helpers.ts`
 * the pure helpers, and `acp-store/shared-state.ts` the module singletons
 * shared across slices. This shim keeps every existing
 * `'@/stores/acp-store'` / `'./acp-store'` import site resolving unchanged.
 */

export * from './acp-store/index'
