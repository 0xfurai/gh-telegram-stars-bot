const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function handleFetch(request: Request): Response {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({ status: "ok" });
  }

  return json({ error: "Not found" }, 404);
}

// Placeholder until the star check is ported (GSB-9).
export function handleScheduled(controller: ScheduledController): void {
  console.log(
    JSON.stringify({
      message: "Star check placeholder ran",
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
    }),
  );
}

export default {
  fetch: (request) => handleFetch(request),
  scheduled: (controller) => handleScheduled(controller),
} satisfies ExportedHandler<Env>;
