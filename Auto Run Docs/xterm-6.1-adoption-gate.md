# xterm 6.1 Adoption Gate Recommendation

## Final Recommendation

**Recommendation: Do not replace the xterm 5.5 production baseline yet.**

Story 3.1 through Story 3.3 created a defensible evaluation path, but the final adoption gate still requires explicit approval and fully accepted manual workflow outcomes before the default path can move away from xterm 5.5.

## Gate Criteria

The migration may be approved only if all of the following are true:

1. continuity behavior is approved as equal to or better than 5.5
2. renderer/performance posture is approved within the documented Story 3.2 threshold bands
3. lifecycle-sensitive workflow validation is approved, including IME and representative TUI flows
4. rollback readiness is approved
5. explicit approval for baseline replacement is recorded

If any of the above is false, the recommendation remains **no-go**.

## Evidence Sources

- Story 3.1 migration-track and compatibility artifacts
- Story 3.2 renderer/performance assessment and threshold bands
- Story 3.3 workflow validation matrix and manual protocol
- current production guardrail comments in `src/renderer/App.tsx`
- CI guardrail step in `.github/workflows/pr-validation.yml`

## Current Story 3.4 Outcome

- The project now has a durable adoption-gate evaluator.
- CI now verifies the adoption gate step is present.
- The default path remains guarded on xterm 5.5.
- Aliased or opt-in xterm 6.1 validation packages remain allowed for evaluation only.

## What must change before approval

- manual IME/TUI workflow results must be captured and accepted
- explicit approval for baseline replacement must be recorded
- any blocked continuity or workflow scenario must be resolved
- any blocked renderer/performance regression must be resolved
