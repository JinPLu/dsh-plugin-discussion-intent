# Extraction contract

This is the migration boundary between DeepSeek Harness and the plugin. It prevents a private core dependency from being disguised as a reusable package.

## Required DSH public seams

| Capability | Core responsibility | Plugin use |
| --- | --- | --- |
| `cas.v1` | Canonical IDs, optimistic revision writes and deterministic conflict handling | Read and write the plugin-owned intent aggregate against an expected revision. |
| `source-attestation.v1` | Verify a direct user source and bind exact text to a core event | Accept an attestation object; never verify or mint one. |
| `records.v1` | Register kinds, serialize payloads and dispatch migrations | Register namespaced Discussion Intent records. |
| `brief-run-provenance.v1` | Freeze/return lifecycle and freshness envelope | Contribute structured, non-authoritative material to a frozen focus. |
| `ui.slots.v1` | Browser entry loading, read-only rail and trajectory-node slots | Render a four-row rail and history nodes without owning browser state. |

Global Work Mode is not requested by `0.1.x`. An external package must never define or overwrite the global enum.

## Namespace

- Record type: `urn:dsh-plugin:discussion-intent:<kind>:v1`
- Event root: `dsh.plugin.discussion-intent.*`
- Settings namespace: `dsh-plugin-discussion-intent/`
- Core-owned `dsh.core.*` events are reserved and must not be emitted here.

## Migration and activation

The source implementation remains a reference until a supported import path exists. Before consuming persisted data, DSH must provide type aliases for earlier records or an explicit one-way import command. A silent key or canonical-ID rewrite is forbidden.

The host adapter will negotiate every configured capability at activation. Missing seams must leave the plugin clearly disabled with exact missing names; they must never trigger a private fallback for attestation, storage or UI behavior.
