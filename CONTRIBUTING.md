# Contributing

## Development rules

- Keep product semantics here and host-wide trust, storage and mode primitives in DSH.
- Do not import a private DSH source path to bypass a missing public seam; document the gap in `docs/EXTRACTION.md`.
- Keep every `@deepseek-ai/*` import inside the named DSH adapter entries; domain, storage and capability-contract modules stay host-independent.
- Keep the workspace sidecar directory relative to the session workspace; do not add another persistence path outside `src/sidecar.ts`.
- Namespace every plugin-owned event, setting and record type under `discussion-intent`.
- Preserve the distinction between an attested user source and a model interpretation.
- Add a migration before changing a persisted schema or canonical key.

## Local checks

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .artifacts
```

Until `1.0`, incompatible public changes require a minor version bump; fixes use a patch bump.
