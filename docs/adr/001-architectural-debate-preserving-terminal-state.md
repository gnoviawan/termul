# ADR-001: Architectural Debate - Preserving Terminal State Across Route Navigation

> **Status:** Architectural Analysis
> **Date:** 2026-01-14
> **Participants:** Principal Architect, Pragmatic Engineer, Security/Performance Expert
> **Technical Story:** Terminal sessions reset when navigating between routes

---

## Executive Summary

This document captures the architectural debate between three senior architect personas regarding the best approach to preserve terminal state across route navigation in Termul, an Electron-based terminal emulator.

**The Core Problem:** When users navigate from the terminal view (`/`) to Settings (`/settings`) and back, all terminal state is destroyed because React Router unmounts the `WorkspaceDashboard` component, triggering PTY process termination and xterm.js disposal.

**Proposed Solutions:**
- **Option A:** Nested routes with layout pattern (Selected in original ADR)
- **Option B:** Lift terminals above router with visibility control

This debate examines both options through three distinct architectural lenses.

---

## The Architects

### 1. Principal Architect
**Perspective:** Focuses on scalability, maintainability, and industry best practices. Advocates for Option A (nested routes).

**Philosophy:** "Build for the next 5 developers who will touch this code. Follow established patterns unless there's compelling reason to innovate."

### 2. Pragmatic Engineer
**Perspective:** Focuses on implementation simplicity, risk reduction, and immediate value delivery. Advocates for Option B (lift terminals).

**Philosophy:** "The best architecture is the one that ships. Solve today's problem with minimal collateral damage."

### 3. Security/Performance Expert
**Perspective:** Focuses on resource leaks, memory management, and attack surface reduction. Skeptical of both approaches.

**Philosophy:** "Every abstraction layer is a potential leak. Every persistent process is a potential exploit. Prove it won't break under pressure."

---

## Option A: Nested Routes with Layout Component

### Principal Architect's Advocacy

**Pros:**

1. **Industry Alignment**
   - React Router v6+ explicitly recommends layout routes for this use case
   - Follows the "Layout Route" pattern documented in React Router's official guides
   - Developers familiar with React Router will understand the architecture immediately
   - Aligns with Next.js App Router, Remix, and other framework conventions

2. **Architectural Scalability**
   - Adding new routes is declarative: just add another child route
   - Natural support for nested settings (e.g., `/settings/shells`, `/settings/shortcuts`)
   - Clear separation between "always-mounted" (layout) and "route-specific" (children)
   - Enables future features like route-based code splitting
   - Supports nested layouts if needed (e.g., settings-specific sub-layouts)

3. **Maintainability**
   - Clear ownership boundaries: layout owns terminals, children own their content
   - No custom logic to maintain - pure React Router patterns
   - Documentation is abundant (React Router docs, community tutorials)
   - Easier to reason about data flow: props down, events up

4. **Testing**
   - Routes can be tested in isolation using `MemoryRouter`
   - Layout component has clear inputs/outputs
   - Integration tests can verify terminal persistence without custom mocks
   - React Router's testing utilities work out of the box

5. **Type Safety**
   - Route definitions are type-safe with TypeScript
   - Outlet placement is explicit and compile-time checked
   - No runtime string-based route matching in application code

**Cons:**

1. **Implementation Complexity**
   - Requires refactoring existing route structure
   - `WorkspaceDashboard` needs to be split into `WorkspaceLayout` + `TerminalView`
   - Settings pages may need UI adjustments (currently full-page)
   - Sidebar duplication needs to be resolved

2. **Immediate Risk**
   - More files changed = higher regression risk
   - Settings UI might need redesign to work as nested content
   - Potential for layout thrashing during navigation if not optimized
   - Need to ensure animations/transitions don't feel jarring

3. **Learning Curve (Minor)**
   - Team needs to understand the Outlet component
   - Nested routing mental model (though this is minor for React Router users)

**Implementation Complexity:** Medium
- 1-2 days for a senior developer
- Changes to ~5 files
- Requires UI/UX review for settings panels

**Future Maintainability:** High
- Follows React Router best practices
- Easy to extend with new routes
- Clear architectural boundaries

**Risk Factors:** Low
- Well-documented pattern
- Stable in React Router since v6
- Can be rolled back if issues arise

---

### Security/Performance Expert's Concerns

**Resource Management Issues:**

1. **Memory Leaks via Outlet**
   - Child routes that unmount might leave event listeners
   - Need to audit all child route components for cleanup
   - React's reconciliation might not catch all subscriptions

2. **PTY Process Accumulation**
   - Terminals never unmount means PTYs stay alive indefinitely
   - What happens if user has 10 terminals across 5 projects?
   - Need explicit PTY lifecycle management
   - Risk of orphaned processes if Electron main process crashes

3. **Terminal State Accumulation**
   - Invisible terminals still consume memory
   - xterm.js scrollback buffer grows indefinitely
   - No natural garbage collection pressure
   - Potential for OOM with many long-running sessions

**Mitigation Required:**

```typescript
// Need to implement:
- PTY idle timeout (kill after X minutes invisible)
- Scrollback buffer limits (currently in place?)
- Terminal session limits (max N terminals per project)
- Memory pressure monitoring
```

**Attack Surface:**

1. **Persistent IPC Channels**
   - Long-lived PTY processes increase attack window
   - If renderer process is compromised, attacker has persistent shell access
   - Need to audit IPC message validation for all PTY operations

2. **State Persistence Risks**
   - Terminal state in memory might contain sensitive data
   - Need to ensure no secrets in scrollback when switching contexts
   - Consider clearing scrollback after N minutes of invisibility

**Recommendation:** Option A is acceptable IF:
- Implement PTY lifecycle management (idle timeouts)
- Add terminal resource limits
- Audit IPC security
- Monitor memory usage in production

---

## Option B: Lift Terminals Above Router

### Pragmatic Engineer's Advocacy

**Pros:**

1. **Implementation Simplicity**
   - Minimal changes to existing codebase
   - Create `TerminalLayer.tsx`, move terminal rendering logic there
   - Add `useLocation()` to check current route
   - Use CSS `visibility: hidden` when not on terminal route
   - Done. No routing refactoring.

2. **Lower Immediate Risk**
   - Changes are additive, not structural
   - Existing routes continue to work unchanged
   - Settings pages don't need UI redesign
   - Can ship incrementally (first lift terminals, then optimize)

3. **Clear Separation**
   - Terminals are "global infrastructure" not "route content"
   - Router handles only settings/preferences UI
   - Mental model: Terminals are always there, router is an overlay
   - Aligns with Electron's multi-window architecture

4. **Performance**
   - No React reconciliation overhead for terminals
   - CSS visibility is cheaper than React mounting/unmounting
   - Terminals won't re-render on route changes
   - Better CPU utilization for terminal-heavy workloads

5. **Backward Compatibility**
   - URLs don't change (`/settings` stays `/settings`)
   - Existing navigation patterns work
   - No migration needed for existing users

**Cons:**

1. **Architectural Debt**
   - Non-standard pattern that requires documentation
   - New developers need to learn the "TerminalLayer" concept
   - Deviates from React Router conventions
   - Creates architectural decision record debt

2. **Scalability Issues**
   - Adding new routes requires updating TerminalLayer visibility logic
   - Risk of accumulating route-specific conditionals
   - Harder to implement nested settings (e.g., `/settings/shells`)
   - Future features might fight with terminal layer (e.g., global overlays)

3. **Testing Complexity**
   - Need to mock `useLocation()` in terminal tests
   - Integration tests need full router setup
   - Harder to test routes in isolation
   - Terminal layer becomes a global dependency

4. **Focus Management**
   - Need explicit logic to handle keyboard focus
   - Which layer gets focus: Terminal or Router content?
   - Tab order might be confusing
   - Screen reader accessibility requires careful handling

5. **Z-Index Wars**
   - Risk of z-index conflicts between terminal and settings
   - Modal dialogs need special handling
   - Global overlays (toasts, tooltips) need layer management
   - CSS cascade order becomes critical

**Implementation Complexity:** Low
- 0.5-1 day for any developer
- Changes to 2-3 files
- No UI redesign needed

**Future Maintainability:** Medium
- Non-standard pattern requires documentation
- Adding routes requires updating visibility logic
- Risk of accumulating technical debt

**Risk Factors:** Medium
- Simple implementation reduces immediate risk
- Long-term risk from non-standard architecture
- Potential for focus/z-index bugs

---

### Principal Architect's Counterarguments

**Architectural Concerns:**

1. **Breaking React Router's Mental Model**
   - Router is supposed to control "what renders where"
   - By lifting terminals above router, we're breaking that contract
   - Creates two "source of truth" for what's on screen
   - Harder to reason about application state

2. **Future Feature Friction**
   - What if we want route-based terminal configurations?
   - What if we want `/debug` to show terminal logs overlay?
   - What if we want multi-terminal layouts (split view)?
   - Each new feature fights the TerminalLayer abstraction

3. **Team Onboarding**
   - Every new hire asks: "Why is TerminalLayer above RouterProvider?"
   - Requires explanation and justification
   - Creates "special knowledge" in the codebase
   - Violates principle of least surprise

4. **Deep Linking Complexity**
   - How do we link to a specific setting with a terminal visible?
   - Current approach: `#/settings` (terminals hidden)
   - What if we want `#/settings?terminal=visible`?
   - Requires custom URL state parsing

**Recommendation:** Option B is only acceptable if:
- We accept technical debt
- We document the pattern thoroughly
- We commit to refactoring to Option A within 6 months
- We have < 3 developers on the team (small team advantage)

---

### Security/Performance Expert's Concerns

**Resource Management Issues:**

1. **Uncontrolled DOM Growth**
   - Terminals stay in DOM forever
   - xterm.js instances accumulate
   - No natural garbage collection
   - Memory leaks harder to detect (everything looks "intentional")

2. **CSS Performance**
   - `visibility: hidden` still renders to DOM
   - Terminals still consume GPU memory
   - Layout recalculations happen even when invisible
   - Might be slower than React unmounting for many terminals

3. **Focus Trap Risks**
   - Invisible terminals can still capture keyboard events
   - Need explicit `tabIndex` management
   - Risk of keyboard events going to invisible terminal
   - Accessibility becomes more complex

**Attack Surface:**

1. **Global Terminal State**
   - Terminals become application-global state
   - Any component can accidentally interact with terminals
   - Harder to enforce security boundaries
   - IPC channels are always open

2. **Route Confusion**
   - User might be in settings but terminal still processes input
   - Confusing UX: "Why is my terminal typing?"
   - Risk of unintended command execution
   - Need explicit input routing

**Performance Monitoring Needed:**

```typescript
// Must implement:
- Terminal count limits (hard cap)
- Memory usage monitoring
- DOM node count tracking
- Performance regression tests
```

**Recommendation:** Option B requires:
- Strict resource limits
- Comprehensive performance monitoring
- Explicit input routing
- Accessibility audit
- Only if team size is small (< 5 devs)

---

## Comparative Analysis

### Complexity Matrix

| Aspect | Option A: Nested Routes | Option B: Lift Terminals |
|--------|------------------------|--------------------------|
| **Initial Implementation** | Medium (1-2 days) | Low (0.5-1 day) |
| **Learning Curve** | Low (standard pattern) | Medium (custom pattern) |
| **Testing Complexity** | Low (isolated routes) | High (global dependencies) |
| **Documentation Burden** | Low (well-documented) | High (custom docs needed) |
| **Future Route Addition** | Trivial (add child) | Moderate (update visibility) |

### Scalability Matrix

| Scenario | Option A: Nested Routes | Option B: Lift Terminals |
|----------|------------------------|--------------------------|
| **Add `/settings/shells`** | Natural nested route | Need visibility logic |
| **Add `/debug` overlay** | Child route with z-index | Fights with TerminalLayer |
| **Add split-terminal view** | Child route variation | Requires TerminalLayer refactor |
| **Add route-specific terminals** | Natural (per-route state) | Requires global state coordination |

### Risk Assessment

| Risk Category | Option A: Nested Routes | Option B: Lift Terminals |
|---------------|------------------------|--------------------------|
| **Implementation Risk** | Medium (more changes) | Low (simple changes) |
| **Maintenance Risk** | Low (standard pattern) | Medium (custom pattern) |
| **Performance Risk** | Low (React optimized) | Medium (uncontrolled growth) |
| **Security Risk** | Low (isolated routes) | Medium (global terminals) |
| **UX Risk** | Medium (UI redesign) | Low (no UI changes) |

---

## The Debate

### Round 1: Opening Statements

**Principal Architect:** "We should use nested routes because it's the React Router way. It's scalable, maintainable, and follows best practices. Yes, it requires more initial work, but we'll reap dividends for years. Every new feature will be easier to implement."

**Pragmatic Engineer:** "That's ivory tower thinking. We have a problem today, and nested routes are a 2-day refactoring. I can lift terminals above the router in 4 hours and ship it today. The 'technical debt' you worry about is theoretical. The value of shipping now is real."

**Security/Performance Expert:** "You're both missing the point. The real question is: which option is less likely to leak memory or compromise security? Option A has better encapsulation. Option B has simpler implementation. But neither addresses PTY lifecycle management. We need resource limits regardless of approach."

### Round 2: Cross-Examination

**Principal Architect to Pragmatic Engineer:** "What happens when we want to add a `/debug` route that shows terminal logs alongside the running terminal? With Option B, TerminalLayer is in the way. We'd need to refactor anyway. Why not do it right the first time?"

**Pragmatic Engineer to Principal Architect:** "You're optimizing for a hypothetical future. Our users are losing terminal sessions today. How many complaints about terminals resetting have we gotten? That's the real metric. Shipping a partial solution now is better than a perfect solution in two weeks."

**Security/Performance Expert to Both:** "Have either of you measured the memory usage of 10 invisible terminals? Have you tested PTY cleanup when the renderer crashes? I'm worried about resource leaks. We need to add monitoring regardless of which option we choose."

### Round 3: Convergence

**Principal Architect:** "I acknowledge that Option A requires more upfront work. But I'm concerned about Option B's long-term costs. However, I could accept Option B if we treat it as a 'bridge solution' and commit to refactoring to Option A within 6 months."

**Pragmatic Engineer:** "I can live with that. Ship Option B now, solve the immediate problem, then refactor to Option A when we have time. But let's be realistic: will we actually refactor in 6 months? Technical debt has a way of becoming permanent."

**Security/Performance Expert:** "Both options need the same security and performance mitigations: PTY lifecycle management, resource limits, memory monitoring. The choice of routing architecture doesn't change those requirements. I'm neutral on the architecture, but I insist we implement the safeguards."

---

## Final Recommendations

### Recommended Approach: Option A (Nested Routes)

**Primary Rationale:**

1. **Long-term Value:** Termul is a product that will grow. The investment in proper architecture pays off quickly.
2. **Team Scalability:** As the team grows, standard patterns reduce onboarding time.
3. **Feature Velocity:** New features will be faster to implement with nested routes.
4. **Lower Total Cost:** More upfront work, but less maintenance burden.

**Implementation Timeline:**

- **Week 1:** Create `WorkspaceLayout`, refactor routing structure
- **Week 2:** Adjust settings UI to work as nested content
- **Week 3:** Testing, refinement, documentation

**Risk Mitigation:**

- Feature flag the new routing to enable quick rollback
- Incremental rollout (start with `/preferences`, then `/settings`)
- Comprehensive testing before merge

---

### Alternative Approach: Option B (Lift Terminals)

**Use Only If:**

1. Team size is small (< 3 developers)
2. Urgent user demand for the feature (can't wait 3 weeks)
3. Commit to refactoring to Option A within 6 months
4. Document the pattern and rationale in ADR

**Implementation Requirements:**

```typescript
// Must implement alongside Option B:
interface TerminalLayerConfig {
  maxTerminals: number           // Hard limit
  maxInactiveTime: number        // Kill PTY after X ms
  maxScrollbackLines: number     // Limit buffer size
  memoryPressureThreshold: number // Trigger cleanup
}

// Must add monitoring:
- Terminal count per project
- Memory usage per terminal
- PTY lifecycle events
- Navigation performance metrics
```

**Timeline:**

- **Day 1:** Implement `TerminalLayer` with visibility control
- **Day 2:** Testing, edge cases, documentation
- **Day 3:** Ship to production

**Post-Ship:**

- Monitor memory usage
- Gather user feedback
- Schedule Option A refactoring

---

### Security/Performance Requirements (Both Options)

**Must Implement:**

1. **PTY Lifecycle Management**
   ```typescript
   // Kill PTYs after X minutes of invisibility
   const INACTIVE_TERMINAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

   // Implement in ConnectedTerminal or TerminalLayer
   useEffect(() => {
     if (!isVisible) {
       const timeout = setTimeout(() => {
         // Kill PTY, keep state for restoration
       }, INACTIVE_TERMINAL_TIMEOUT_MS);
       return () => clearTimeout(timeout);
     }
   }, [isVisible]);
   ```

2. **Resource Limits**
   ```typescript
   const MAX_TERMINALS_PER_PROJECT = 10;
   const MAX_SCROLLBACK_LINES = 10000;
   const MAX_TOTAL_TERMINALS = 50;
   ```

3. **Memory Monitoring**
   ```typescript
   // Track terminal memory usage
   // Trigger warnings when approaching limits
   // Implement cleanup strategies
   ```

4. **Security Audits**
   - Validate all IPC messages to/from PTY
   - Sanitize terminal state before persistence
   - Implement rate limiting for PTY operations
   - Add CSRF protection for IPC calls

---

## Decision Matrix

| Criterion | Option A | Option B | Winner |
|-----------|----------|----------|--------|
| **Time to Ship** | 3 weeks | 3 days | Option B |
| **Long-term Maintainability** | High | Medium | Option A |
| **Scalability** | High | Low | Option A |
| **Implementation Simplicity** | Medium | High | Option B |
| **Testing Ease** | High | Low | Option A |
| **Standard Practices** | High | Low | Option A |
| **Team Onboarding** | Easy | Moderate | Option A |
| **Future Feature Flexibility** | High | Medium | Option A |

**Weighted Score:**
- If prioritizing **speed**: Option B wins
- If prioritizing **quality**: Option A wins
- If prioritizing **long-term value**: Option A wins

---

## Final Recommendation

**Adopt Option A (Nested Routes) as the primary solution.**

**Rationale:**

1. Termul is a growing product with active development
2. The 3-week investment is reasonable given the long-term benefits
3. Standard patterns reduce technical debt
4. Future features will be easier to implement
5. Team scalability is important

**However, if immediate user demand is critical:**

1. Implement Option B as a **temporary bridge solution**
2. Ship within 1 week
3. Immediately schedule Option A refactoring for next sprint
4. Treat Option B as technical debt with explicit timeline

**Regardless of option chosen:**

1. Implement PTY lifecycle management (idle timeouts)
2. Add resource limits (terminal count, memory usage)
3. Set up monitoring and alerting
4. Conduct security audit of IPC channels
5. Document the decision and trade-offs

---

## Post-Decision Action Items

### If Option A is Chosen:

1. **Week 1:**
   - Create `WorkspaceLayout.tsx`
   - Refactor `WorkspaceDashboard.tsx` to `TerminalView.tsx`
   - Update routing in `App.tsx`
   - Write unit tests for layout

2. **Week 2:**
   - Adjust `ProjectSettings.tsx` to work as nested route
   - Adjust `AppPreferences.tsx` to work as nested route
   - Remove duplicate sidebars
   - Implement PTY idle timeout

3. **Week 3:**
   - Integration testing
   - Performance testing
   - Security audit
   - Documentation
   - Feature flag rollout

### If Option B is Chosen:

1. **Day 1:**
   - Create `TerminalLayer.tsx`
   - Implement visibility logic
   - Update `App.tsx`

2. **Day 2:**
   - Implement PTY idle timeout
   - Add resource limits
   - Testing

3. **Day 3:**
   - Ship to production
   - Set up monitoring
   - Document technical debt

4. **Next Sprint:**
   - Schedule Option A refactoring
   - Create migration plan

---

## Conclusion

Both options solve the core problem of preserving terminal state across navigation. The choice depends on team context, urgency, and long-term product vision.

**For a healthy, growing product with a team of 3+ developers:** Option A is the better long-term choice.

**For a small team (< 3 developers) with urgent user demand:** Option B is acceptable as a bridge solution with explicit commitment to refactoring.

**Regardless of choice:** Both options require implementing security and performance safeguards to prevent resource leaks and ensure production readiness.

---

## References

- Original ADR: `docs/adr/001-preserve-terminal-state-across-route-navigation.md`
- React Router Layout Routes: https://reactrouter.com/en/main/route/route#layout-routes
- React Router Outlet: https://reactrouter.com/en/main/components/outlet
- Current architecture: `E:\open-source\PecutAPP\termul\src\renderer\App.tsx`
- Terminal cleanup: `E:\open-source\PecutAPP\termul\src\renderer\components\terminal\ConnectedTerminal.tsx:331-367`
- Terminal rendering: `E:\open-source\PecutAPP\termul\src\renderer\pages\WorkspaceDashboard.tsx:426-454`

---

*Document Version: 1.0*
*Last Updated: 2026-01-14*
*Next Review: After implementation is complete*
