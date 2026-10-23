/** `effectory approval list | approve | reject`. */
import { Approve, State } from "@effectory/core";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { printJson, renderApprovals } from "../output.ts";
import { CliFailure, Runtime, findRun, withRuntime } from "../runtime.ts";

const json = Flag.Boolean("json").pipe(
  Flag.withDescription("Print machine-readable JSON"),
  Flag.withDefault(false)
);

/** Approvals of this collection's runs (approvals are keyed by run, not collection). */
const collectionApprovals = Effect.fn("collectionApprovals")(
  function* collectionApprovals(query: {
    readonly runId?: string;
    readonly status?: State.ApprovalStatus;
  }) {
    const { collection } = yield* Runtime;
    const state = yield* State.State;
    const approvals = yield* state.listApprovals(query);
    const owners = new Map<string, boolean>();
    const mine: State.ApprovalRow[] = [];
    for (const approval of approvals) {
      let owned = owners.get(approval.runId);
      if (owned === undefined) {
        const run = yield* state.getRun(approval.runId);
        owned = run?.collection === collection.name;
        owners.set(approval.runId, owned);
      }
      if (owned) {
        mine.push(approval);
      }
    }
    return mine;
  }
);

/** An approval by id or unique id prefix. */
const findApproval = Effect.fn("findApproval")(function* findApproval(
  id: string
) {
  const state = yield* State.State;
  const exact = yield* state.getApproval(id);
  if (exact !== undefined) {
    return exact;
  }
  const matches = (yield* collectionApprovals({})).filter((approval) =>
    approval.id.startsWith(id)
  );
  if (matches.length === 1) {
    return matches[0] as State.ApprovalRow;
  }
  return yield* new CliFailure({
    message:
      matches.length === 0
        ? `No approval ${id}`
        : `Approval id ${id} is ambiguous: ${matches.map((approval) => approval.id).join(", ")}`,
  });
});

const list = Command.make(
  "list",
  {
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Include decided approvals"),
      Flag.withDefault(false)
    ),
    json,
    run: Flag.String("run").pipe(
      Flag.withDescription("Only this run's approvals"),
      Flag.optional
    ),
  },
  (flags) =>
    withRuntime(
      Effect.gen(function* listApprovals() {
        const runId = Option.isSome(flags.run)
          ? (yield* findRun(flags.run.value)).id
          : undefined;
        const approvals = yield* collectionApprovals({
          ...(runId === undefined ? {} : { runId }),
          ...(flags.all ? {} : { status: "pending" as const }),
        });
        return yield* flags.json
          ? printJson(approvals)
          : Console.log(renderApprovals(approvals));
      })
    )
).pipe(
  Command.withDescription(
    "List pending approvals (Approve nodes and retry approvals of interrupted retry: never Actions)"
  )
);

const decide = (approved: boolean) =>
  Command.make(
    approved ? "approve" : "reject",
    {
      by: Flag.String("by").pipe(
        Flag.withDescription("Who decided (default: $USER)"),
        Flag.optional
      ),
      id: Argument.String("approval-id"),
      json,
      note: Flag.String("note").pipe(
        Flag.withDescription("A note recorded with the decision"),
        Flag.optional
      ),
    },
    (flags) =>
      withRuntime(
        Effect.gen(function* decideApproval() {
          const approval = yield* findApproval(flags.id);
          const by = Option.getOrUndefined(flags.by) ?? process.env.USER;
          const note = Option.getOrUndefined(flags.note);
          const decided = yield* Approve.decide(approval.id, {
            approved,
            ...(by === undefined || by === "" ? {} : { by }),
            ...(note === undefined ? {} : { note }),
          });
          if (flags.json) {
            return yield* printJson(decided);
          }
          return yield* Console.log(
            `${approved ? "Approved" : "Rejected"} ${decided.id}: ${decided.title}\nContinue the run with: effectory run resume ${decided.runId}`
          );
        })
      )
  ).pipe(
    Command.withDescription(
      approved
        ? "Approve a pending approval; then resume its run"
        : "Reject a pending approval (fails the run on resume)"
    )
  );

export const approval = Command.make("approval").pipe(
  Command.withDescription("List and decide approvals"),
  Command.withSubcommands([list, decide(true), decide(false)])
);
