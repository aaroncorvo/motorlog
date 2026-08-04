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
    // Key arrives in the x-device-key header (WiFi transport) or in the JSON
    // body as device_key (cellular — the SIMCOM HTTP stack can't add custom
    // headers). Body is parsed once here and reused below.
    let body: Record<string, unknown> = {};
    if (req.method !== "GET") {
      try { body = await req.json(); } catch { /* handled by validators below */ }
    }
    const url = Deno.env.get("SUPABASE_URL")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const H = { apikey: svc, authorization: `Bearer ${svc}`, "content-type": "application/json" };

    const key = req.headers.get("x-device-key") ??
      (typeof body.device_key === "string" ? body.device_key : null);

    // Two authentication paths:
    //  - hardware device: per-device API key (header or body)
    //  - phone app: the user's own JWT + an explicit vehicle_id, for batches
    //    assembled from a BLE dongle plus phone GPS (no device row exists)
    let dev: { id: string | null; user_id: string; vehicle_id: string | null };
    let source = "device";

    if (key) {
      const hash = await sha256hex(key);
      const devRes = await fetch(
        `${url}/rest/v1/devices?api_key_hash=eq.${hash}&select=id,user_id,vehicle_id&limit=1`,
        { headers: H },
      );
      const devices = devRes.ok ? await devRes.json() : [];
      if (!devices.length) return json({ error: "unknown device" }, 403);
      dev = devices[0];
    } else {
      const jwt = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      const vehicleId = typeof body.vehicle_id === "string" ? body.vehicle_id : null;
      if (!jwt || !vehicleId) {
        return json({ error: "device key, or user JWT + vehicle_id, required" }, 401);
      }
      const uRes = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: svc, authorization: `Bearer ${jwt}` },
      });
      if (!uRes.ok) return json({ error: "invalid session" }, 401);
      const user = await uRes.json();
      // the vehicle must belong to a fleet this user can write to
      const vRes = await fetch(
        `${url}/rest/v1/vehicles?id=eq.${vehicleId}&select=id,user_id&limit=1`,
        { headers: H },
      );
      const vs = vRes.ok ? await vRes.json() : [];
      if (!vs.length) return json({ error: "unknown vehicle" }, 403);
      const owner = vs[0].user_id;
      if (owner !== user.id) {
        const mRes = await fetch(
          `${url}/rest/v1/fleet_members?owner_user_id=eq.${owner}&member_email=ilike.${encodeURIComponent(user.email)}&select=id&limit=1`,
          { headers: H },
        );
        const ms = mRes.ok ? await mRes.json() : [];
        if (!ms.length) return json({ error: "not a member of this fleet" }, 403);
      }
      dev = { id: null, user_id: owner, vehicle_id: vehicleId };
      source = "phone";
    }

    // Config pull: GET (WiFi) or POST {action:'config'} (cellular).
    if (req.method === "GET" || body.action === "config") {
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

    const batch: unknown[] = Array.isArray(body?.batch) ? body.batch : [];
    if (!batch.length) return json({ error: "batch[] required" }, 400);
    if (batch.length > 500) return json({ error: "batch too large (max 500)" }, 400);

    const rows = [];
    for (const r of batch as Record<string, unknown>[]) {
      const ts = toIso(r.ts);
      if (!ts) continue;
      rows.push({
        device_id: dev.id, user_id: dev.user_id, vehicle_id: dev.vehicle_id,
        source,
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
    if (dev.id) await fetch(`${url}/rest/v1/devices?id=eq.${dev.id}`, {
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
