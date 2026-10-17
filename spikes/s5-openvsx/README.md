# Spike S5 — Open VSX availability

Throwaway code for Phase 00 spike S5 (`02_PHASES/PHASE_00_ENVIRONMENT_DECISIONS_SPIKES.md` step 0.8).
Results: [`docs/spikes/S5_OPEN_VSX.md`](../../docs/spikes/S5_OPEN_VSX.md).

`check.mjs` (no dependencies) looks up every extension in `extensions.json` on Open VSX and reports whether
it exists, its latest version, license, verified publisher, platforms, and whether its `engines.vscode`
range is satisfied by the pinned Theia's VS Code API version. If the latest is too new, it finds the newest
compatible version (the one Theia's registry client would install).

```bash
node spikes/s5-openvsx/check.mjs --theia-api 1.139.0                 # needs access to open-vsx.org
OPENVSX_URL=https://openvsx.internal.example node spikes/s5-openvsx/check.mjs   # an internal mirror
```

The development sandbox cannot reach open-vsx.org, so `.github/workflows/spike-s5-openvsx.yml` runs the
check on GitHub's runners whenever this folder changes, and writes the table to the job summary.
