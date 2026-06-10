# Termul fork of pi-acp 0.0.27

Version: `0.0.27-termul.1`

Patches on upstream `pi-acp@0.0.27`:

1. `**getThinkingState**` — filters thinking levels from the active pi model (`reasoning`, `thinkingLevelMap`) instead of always advertising all six levels.
2. `**getModelState**` — forwards `reasoning` and `thinkingLevelMap` on each `ModelInfo`.
3. `**unstable_setSessionModel**` — after `setModel`, re-reads thinking state and emits `current_mode_update` so clients stay in sync.

Revert to upstream when pi-acp merges equivalent behavior.