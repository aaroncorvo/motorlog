// ingest-telemetry: HTTPS ingest endpoint for vehicle telematics devices
// (Freematics ONE+ first). Deploy with JWT verification OFF — devices are not
// Supabase users; they authenticate with a per-device API key sent in the
// x-device-key header, checked against a sha256 hash in the devices table.
//
// POST body (JSON):
//   { "batch": [ { "ts": "2026-08-03T20:11:00Z" | 1784924690 (epoch s),
//                  "lat": 30.5, "lon": -97.7, "speed_kph": 88.5, "heading": 210,
//                  "hdop": 0.8, "rpm": 1720, "coolant_c": 88, "fuel_pct": 62.5,
//                  "batt_v": 14.1, "engine_on": true, "pids": {"0F": 41} } ],
//     "fw_version": "ml-0.1" }
// Response: { ok: true, accepted: <n> }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-device-key",
};

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toIso(ts: unknown): string | null {
  if (typeof ts === "number") {
    const ms = ts > 10_000_000_000 ? ts : ts * 1000;   // epoch s or ms
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  try {
    const key = req.headers.get("x-device-key");
    if (!key) return json({ error: "x-device-key required" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const H = { apikey: svc, authorization: `Bearer ${svc}`, "content-type": "application/json" };

    const hash = await sha256hex(key);
    const devRes = await fetch(
      `${url}/rest/v1/devices?api_key_hash=eq.${hash}&select=id,user_id,vehicle_id&limit=1`,
      { headers: H },
    );
    const devices = devRes.ok ? await devRes.json() : [];
    if (!devices.length) return json({ error: "unknown device" }, 403);
    const dev = devices[0];

    // GET = config pull: the device fetches its app-managed configuration
    // (WiFi, reporting interval, ...) on every check-in and applies changes.
    if (req.method === "GET") {
      const cfgRes = await fetch(
        `${url}/rest/v1/device_config?device_id=eq.${dev.id}&select=config,updated_at&limit=1`,
        { headers: H },
      );
      const cfgs = cfgRes.ok ? await cfgRes.json() : [];
      return json({
        config: cfgs[0]?.config ?? {},
        updated_at: cfgs[0]?.updated_at ?? null,
      });
    }

    const body = await req.json();
    const batch: unknown[] = Array.isArray(body?.batch) ? body.batch : [];
    if (!batch.length) return json({ error: "batch[] required" }, 400);
    if (batch.length > 500) return json({ error: "batch too large (max 500)" }, 400);

    const rows = [];
    for (const r of batch as Record<string, unknown>[]) {
      const ts = toIso(r.ts);
      if (!ts) continue;
      rows.push({
        device_id: dev.id, user_id: dev.user_id, vehicle_id: dev.vehicle_id,
        ts,
        lat: num(r.lat), lon: num(r.lon),
        speed_kph: num(r.speed_kph), heading: num(r.heading), hdop: num(r.hdop),
        rpm: num(r.rpm), coolant_c: num(r.coolant_c), fuel_pct: num(r.fuel_pct),
        batt_v: num(r.batt_v),
        engine_on: typeof r.engine_on === "boolean" ? r.engine_on : null,
        pids: r.pids && typeof r.pids === "object" ? r.pids : null,
      });
    }
    if (!rows.length) return json({ error: "no valid rows (each needs a ts)" }, 400);

    const ins = await fetch(`${url}/rest/v1/telemetry`, {
      method: "POST",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!ins.ok) return json({ error: `insert failed: ${await ins.text()}` }, 500);

    // touch the device (fire-and-forget semantics; errors ignored)
    await fetch(`${url}/rest/v1/devices?id=eq.${dev.id}`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({
        last_seen_at: new Date().toISOString(),
        ...(typeof body.fw_version === "string" ? { fw_version: body.fw_version.slice(0, 40) } : {}),
      }),
    }).catch(() => {});

    return json({ ok: true, accepted: rows.length });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
