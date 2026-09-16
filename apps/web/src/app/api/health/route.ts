/** Liveness probe. Deliberately touches no database, queue or external API. */
export function GET(): Response {
  return Response.json({ status: "ok", service: "web" }, { headers: { "Cache-Control": "no-store" } });
}
