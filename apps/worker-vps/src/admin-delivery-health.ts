import { createSupabaseServiceClient, loadRuntimeConfig } from "@ai-influencer/shared";

type MessageSnapshot = {
  id: string;
  platform_message_id: string;
  created_at: string;
  occurred_at: string;
};

type JobSnapshot = {
  id: string;
  created_at: string;
};

function minutesSince(iso: string, nowMs: number): number {
  const valueMs = Date.parse(iso);
  if (!Number.isFinite(valueMs)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor((nowMs - valueMs) / 60_000));
}

async function run(): Promise<void> {
  const config = loadRuntimeConfig();
  const supabase = createSupabaseServiceClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  const nowMs = Date.now();
  const lagAlertMinutes = Number.parseInt(process.env.DELIVERY_LAG_ALERT_MINUTES ?? "20", 10);
  if (!Number.isFinite(lagAlertMinutes) || lagAlertMinutes <= 0) {
    throw new Error("DELIVERY_LAG_ALERT_MINUTES must be a positive integer.");
  }

  const [{ data: inboundRows, error: inboundError }, { data: queuedRows, error: queuedError }, queuedCountResult] =
    await Promise.all([
      supabase
        .from("messages")
        .select("id, platform_message_id, created_at, occurred_at")
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("jobs")
        .select("id, created_at")
        .eq("status", "queued")
        .order("created_at", { ascending: true })
        .limit(1),
      supabase.from("jobs").select("id", { count: "exact", head: true }).eq("status", "queued")
    ]);

  if (inboundError) {
    throw new Error(`Failed to query latest inbound message: ${inboundError.message}`);
  }
  if (queuedError) {
    throw new Error(`Failed to query queued jobs: ${queuedError.message}`);
  }
  if (queuedCountResult.error) {
    throw new Error(`Failed to count queued jobs: ${queuedCountResult.error.message}`);
  }

  const latestInbound = (inboundRows?.[0] as MessageSnapshot | undefined) ?? null;
  const oldestQueued = (queuedRows?.[0] as JobSnapshot | undefined) ?? null;
  const queuedCount = queuedCountResult.count ?? 0;

  const inboundLagMinutes = latestInbound ? minutesSince(latestInbound.created_at, nowMs) : null;
  const queuedOldestMinutes = oldestQueued ? minutesSince(oldestQueued.created_at, nowMs) : 0;

  const isLagging =
    (inboundLagMinutes !== null && inboundLagMinutes > lagAlertMinutes) ||
    (queuedCount > 0 && queuedOldestMinutes > lagAlertMinutes);

  const payload = {
    event: "delivery_health_snapshot",
    status: isLagging ? "degraded" : "ok",
    lag_alert_minutes: lagAlertMinutes,
    latest_inbound: latestInbound
      ? {
          id: latestInbound.id,
          platform_message_id: latestInbound.platform_message_id,
          created_at: latestInbound.created_at,
          occurred_at: latestInbound.occurred_at,
          age_minutes: inboundLagMinutes
        }
      : null,
    queue: {
      queued_count: queuedCount,
      oldest_queued_job_id: oldestQueued?.id ?? null,
      oldest_queued_age_minutes: oldestQueued ? queuedOldestMinutes : 0
    }
  };

  console.log(JSON.stringify(payload));
  if (isLagging) {
    process.exitCode = 2;
  }
}

run().catch((error) => {
  console.error(
    JSON.stringify({
      event: "delivery_health_snapshot_failed",
      error_message: error instanceof Error ? error.message : "unknown error"
    })
  );
  process.exitCode = 1;
});
