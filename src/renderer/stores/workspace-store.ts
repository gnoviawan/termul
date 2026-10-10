/**
 * Workspace store — public facade.
 *
 * The implementation lives in the `workspace-store/` module directory (the
 * `acp-store/` pattern): `workspace-store/index.ts` composes the action slices
 * in `workspace-store/slices/`, `workspace-store/types.ts` holds the
 * `WorkspaceState` contract, `workspace-store/tree.ts` the pure tree/id
 * helpers, and `workspace-store/selectors.ts` the selector hooks. This shim
 * keeps every existing `'@/stores/workspace-store'` / `'./workspace-store'`
 * import site resolving unchanged.
 */

export * from './workspace-store/index'
