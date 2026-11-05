# Upstream source references

These are local, full source checkouts with shallow Git history. They are
ignored by the parent repository and excluded from its formatter, linter and test discovery.
The test exclusion uses Bun's documented
[`pathIgnorePatterns`](https://bun.com/docs/test/configuration) setting.
No upstream code is imported into Effectory. The manifest and restore script
are tracked so another checkout can reproduce the research without committing
thousands of third-party files or depending on a moving branch.

```sh
bash scripts/vendor-sources.sh
```

The script leaves matching clean checkouts alone and refuses differing or
modified destinations. A failed initial fetch can leave a partial checkout;
move it aside before retrying. To update a reference deliberately, update both
the manifest and script, then recheck the source citations in the docs.

| Repository | Revision | Reason |
| --- | --- | --- |
| [Swamp](https://github.com/swamp-club/swamp/tree/b42dd1ac63c899e1cba75efae9d7d3dd1ce96c11) | `b42dd1ac63c899e1cba75efae9d7d3dd1ce96c11` | Current default branch at inspection |
| [Effect](https://github.com/Effect-TS/effect/tree/7f524e25cfb49a71ac39b0f44278d08d40dda5de) | `7f524e25cfb49a71ac39b0f44278d08d40dda5de` | `effect@4.0.5`, matching this repository's dependency pin |

Effect main initially resolved to `5cd5d290966e631da907e52f3da3de957ee55115`
(version 4.1.2). Research and API citations use the 4.0.5 checkout instead.

Upstream notices remain in each checkout: Swamp's `LICENSE`, `COPYING`, and
`COPYING-EXCEPTION`; Effect's `LICENSE`. This pass describes behavior and
proposes a new implementation; it does not copy Swamp implementation code.
