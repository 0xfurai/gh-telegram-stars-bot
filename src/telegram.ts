// Sending to Telegram, with refusals as Results.
//
// Telegram refusing a message is an expected outcome, not a bug: the user
// blocked the bot (403), the chat is gone, or we're sending too fast (429).
// send() turns those into a SendError the caller can act on (deactivate the
// chat, stop the run). Anything else is rethrown.
import { GrammyError, HttpError } from "grammy";
import { err, ok, type Result } from "./result";

export type SendError =
  /** 403: the user blocked the bot, it was removed from the group, or the user is deactivated. */
  | { kind: "blocked"; description: string }
  /** 400 "chat not found": the chat no longer exists. */
  | { kind: "chat-not-found" }
  /** 429: wait `retryAfter` seconds before sending again. */
  | { kind: "rate-limited"; retryAfter: number }
  /** Another 4xx: Telegram rejected the request itself, so it's likely our bug. */
  | { kind: "rejected"; code: number; description: string }
  /** 5xx or a network failure: try again later. */
  | { kind: "unavailable"; message: string };

function fromApiError(error: GrammyError): SendError {
  if (error.error_code === 403) {
    return { kind: "blocked", description: error.description };
  }
  if (error.error_code === 429) {
    return { kind: "rate-limited", retryAfter: error.parameters.retry_after ?? 1 };
  }
  if (error.error_code === 400 && /chat not found/i.test(error.description)) {
    return { kind: "chat-not-found" };
  }
  if (error.error_code >= 500) {
    return { kind: "unavailable", message: error.description };
  }
  return { kind: "rejected", code: error.error_code, description: error.description };
}

/** The SendError for a Telegram failure, or null if `error` isn't one. */
export function classifySendError(error: unknown): SendError | null {
  if (error instanceof GrammyError) {
    return fromApiError(error);
  }
  if (error instanceof HttpError) {
    return { kind: "unavailable", message: error.message };
  }
  return null;
}

/** Runs a Telegram API call; Telegram refusals become an Err, other errors are rethrown. */
export async function send<T>(call: () => Promise<T>): Promise<Result<T, SendError>> {
  try {
    return ok(await call());
  } catch (error) {
    const sendError = classifySendError(error);
    if (sendError === null) {
      throw error;
    }
    return err(sendError);
  }
}
