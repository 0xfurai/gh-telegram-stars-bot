import { handleFetch } from "./http";
import { handleScheduled } from "./star-check";

// Only the default export: every named export of the main module becomes a
// Worker entrypoint.
export default {
  fetch: handleFetch,
  scheduled: handleScheduled,
} satisfies ExportedHandler<Env>;
