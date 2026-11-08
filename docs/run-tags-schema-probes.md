# Run-tag schema feasibility probes

Observed against the checkout's Effect 4.0.5 and Bun 1.4.3 on 2026-11-05. These are scratch probes, not implementation or approval of the proposed API. No production files changed. Local logs: `/tmp/effectory-run-tags-schema-probe.log` and `/tmp/effectory-run-tags-schema-probe2.log`.

## Invalid patterned keys disappear under default decoding

For a schema shaped as:

```ts
const Tags = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,63}$/u)),
  Schema.String.check(Schema.isMaxLength(256))
);
```

`Schema.decodeUnknownSync(Tags)({ "bad:key": "prod" })` returns `{}`. An empty-string key is also silently dropped. Passing `{ onExcessProperty: "error" }` rejects each invalid key and names its path. Wrong-type values on valid keys are rejected in both modes.

`node_modules/effect/src/rpc/RpcServer.ts:517` builds its request decoder with `Schema.decodeUnknownEffect(codecFor(rpc.payloadSchema))`, without an explicit excess-property error option. Therefore a schema whose only key validation is the Record's key pattern is insufficient for the draft's requirement that malformed tags fail at every boundary. Validation after that decoder cannot recover keys it has already removed.

A scratch alternative, `Schema.Record(Schema.String, Schema.String).check(...)`, retains all string keys until a predicate can reject them. This rejected `bad:key` with default decoding. That is feasibility evidence, not a selected implementation; field-specific diagnostics and JSON Schema export still need deliberate handling.

## JSON Schema requires explicit attention

Default `Schema.toJsonSchemaDocument(Tags)` emits the regex under `patternProperties`, but also emits `additionalProperties: true`. Passing `{ onExcessProperty: "error" }` emits `additionalProperties: false` for this schema. Merely asserting that the regex appears would not establish that malformed keys are disallowed by the generated document.

Effect's own documentation at `node_modules/effect/src/Schema.ts:16995` also states that JSON Schema string lengths count Unicode code points while Effect counts UTF-16 code units. The probe rejected 129 grinning-face emoji under a 256-unit value limit, as the proposed Effect-side contract specifies. The generated `maxLength: 256` is a looser approximation for supplementary characters. A decoder remains authoritative; a JSON Schema document must not be described as an exact equivalent.

## Non-JSON objects are another normalization boundary

Both default and strict patterned-record decoding accept a Date or Map and return a newly allocated empty ordinary object. Inherited properties are omitted. Arrays and explicit undefined are rejected.

A post-decode check on an unrestricted string record sees the normalized ordinary object, so it cannot distinguish an original Date or Map from `{}`. If authoring/test boundaries promise to reject these non-JSON objects, that validation must inspect the original value before record decoding. RPC JSON payloads cannot carry those prototypes.

A separate unrestricted-record probe preserved own data properties named `__proto__` and `constructor`; it did not change the result's prototype. The proposed run-key grammar rejects `__proto__` because it does not start with an alphanumeric character. Ordinary publication tags have a separate existing key contract and must not accidentally acquire run-key restrictions.

## Consequences for the next draft revision

- Keep the explicit requirement that invalid run keys fail under the default decoder used by RPC, not just in a strict constructor probe.
- Require generated JSON Schema assertions that test whether unknown keys are permitted, rather than only checking for a regex.
- Document the UTF-16/code-point distinction as a JSON Schema approximation.
- Decide explicitly whether non-JSON authoring/fixture objects are rejected; do not assume Schema.Record or the existing JSON budget preflight proves that.
- Test these alongside the current public boundary consumers before declaring implementation complete. These findings do not authorize public API implementation.

## Missing-output-key compatibility

A later scratch probe checked `Schema.Struct({ tags: Tags.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => ({})))) })` with an unrestricted string-record Tags schema. An absent key decodes to `{ tags: {} }`; explicit undefined, null and non-string values fail. Both `{ tags: {} }` and a nonempty tag map encode with the field present, using the default `encodingStrategy: "passthrough"`. This supplies a required decoded map without rejecting older untagged server replies. It does not validate the proposed full RunTags constraints or prove end-to-end RPC compatibility; those remain acceptance tests.

## JSON wire codec and indexed lookup probes

A scratch probe applied `Schema.toCodecJson` to a small Run-shaped schema whose tags use the revision-2 Record/propertyNames/count/4096-byte construction and key-only decoding default. The JSON codec decoded an old reply with no tags to `{ tags: {} }`, rejected a present null map and a bad key with the tags/key path, and encoded an empty map with the field present. This covers the JSON codec step used by RPC, not an end-to-end HTTP compatibility test.

A separate in-memory Bun SQLite probe inserted 10,002 run rows and tag rows for one older run. A parameterized two-tag conjunction returned exactly that run. `EXPLAIN QUERY PLAN` showed a covering lookup on `(principal, key, value, runId)`, a primary-key run lookup, and a primary-key lookup for the second tag, with ordering applied to the matched candidates. This establishes that a sparse correlation lookup need not scan/decode all host runs. It is not a migration implementation or proof of production pagination, cursor, byte-limit or transaction behavior. Those remain required tests of the actual implementation after API approval.

The combined scratch output is `/tmp/effectory-run-tags-wire-index-probe.log`. No production files changed.
