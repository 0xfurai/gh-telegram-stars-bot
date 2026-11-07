import { loadConfig } from "./config";
import { handleFetch, misconfigured } from "./http";
import { handleScheduled } from "./star-check";

// Only the default export: every named export of the main module becomes a
// Worker entrypoint.
export default {
  fetch(request, env) {
    const settings = loadConfig(env);
    if (!settings.ok) {
      return misconfigured();
    }
    return handleFetch(request, { config: settings.value });
  },

  scheduled(controller, env) {
    const settings = loadConfig(env);
    if (!settings.ok) {
      // Fail the run visibly instead of skipping it quietly.
      throw new Error(`Invalid Worker settings: ${settings.error.join("; ")}`);
    }
    handleScheduled(controller, settings.value);
  },
} satisfies ExportedHandler<Env>;
