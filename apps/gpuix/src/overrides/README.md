Native overrides of shared renderer files. `src/overrides/<path>` replaces
`src/renderer/<path>` in the GPUIX bundle (see `overridesPlugin` in
`build.ts`) and must export the same names. `tools/compat/lint.ts` treats
an overridden file as allowlisted.
