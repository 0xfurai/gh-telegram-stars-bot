type Route = () => Response;

const ROUTES: Partial<Record<string, Route>> = {
  "/health": () => Response.json({ status: "ok" }),
};

const ALLOWED_METHODS = "GET, HEAD";

export function handleFetch(request: Request): Response {
  const route = ROUTES[new URL(request.url).pathname];

  if (!route) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (request.method === "GET") {
    return route();
  }

  if (request.method === "HEAD") {
    const { status, headers } = route();
    return new Response(null, { status, headers });
  }

  return Response.json(
    { error: "Method not allowed" },
    { status: 405, headers: { Allow: ALLOWED_METHODS } },
  );
}
