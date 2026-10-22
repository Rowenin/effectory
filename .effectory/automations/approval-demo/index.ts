import { Automation } from "@effectory/sdk";
import { Effect, Schema } from "effect";

const Message = Schema.Struct({ message: Schema.String });

export default Automation.define({
  description:
    "Prepare a message, pause for approval, and publish it only after explicit resume. No external services required.",
  error: Schema.Never,
  execute: (input) =>
    Effect.gen(function* approvalDemo() {
      const plan = { message: input.message };
      yield* Automation.publish("prepared-message", {
        schema: Message,
        value: plan,
      });
      yield* Automation.approve({
        key: "publish-message",
        review: plan,
        title: "Publish this message as a completed artifact?",
      });
      yield* Automation.publish("completed-message", {
        schema: Message,
        value: plan,
      });
      return plan;
    }),
  idempotencyKey: (input) => input.requestId,
  input: Schema.Struct({ message: Schema.String, requestId: Schema.String }),
  name: "approval-demo",
  success: Message,
});
