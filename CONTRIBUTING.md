# Contributing

## Development rules

- Keep product semantics here and host-wide trust, storage and mode primitives in DSH.
- Do not import a private DSH source path to bypass a missing public seam; document the gap in `docs/EXTRACTION.md`.
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
