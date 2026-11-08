# Working in Effectory

This repository is being rebuilt from scratch. Earlier design notes live in `docs/`.

## Third-party integrations

Use Alchemy's Distilled SDKs for third-party services wherever they provide the required capabilities. Prefer their Effect-native operations and ordinary services/Layers over Promise SDK wrappers or custom HTTP clients. Check compatibility with the pinned Effect version and document any concrete coverage gap before choosing another client. Preserve existing public contracts when migrating integrations; discuss public API or authentication changes with the user.

## Checking your work

```sh
bun run typecheck && bun run check && bun test
```
