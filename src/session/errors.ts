import { ClassifiedActionError, type ActionErrorCategory } from "../errors.js";

export class SessionCheckpointError extends ClassifiedActionError<"SESSION_CHECKPOINT"> {
  public constructor(
    message: string,
    category: ActionErrorCategory = "runtime",
    options?: ErrorOptions,
  ) {
    super(message, { code: "SESSION_CHECKPOINT", category, retryable: false }, options);
  }
}
