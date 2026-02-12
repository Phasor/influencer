import { createSupabaseServiceClient, loadRuntimeConfig } from "@ai-influencer/shared";

type JobStatusCount = {
  status: string;
  count: number;
};

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const client = createSupabaseServiceClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);

  const { data: statusRows, error: statusError } = await client
    .from("jobs")
    .select("status")
    .order("created_at", { ascending: false })
    .limit(500);

  if (statusError) {
    throw new Error(`Failed to fetch jobs for status counts: ${statusError.message}`);
  }

  const countsByStatus = new Map<string, number>();
  for (const row of statusRows ?? []) {
    const status = (row as { status: string }).status;
    countsByStatus.set(status, (countsByStatus.get(status) ?? 0) + 1);
  }

  const statusSummary: JobStatusCount[] = Array.from(countsByStatus.entries())
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => a.status.localeCompare(b.status));

  const { data: oldestQueued, error: queuedError } = await client
    .from("jobs")
    .select("id, run_after, created_at, attempt_count")
    .eq("status", "queued")
    .order("run_after", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (queuedError) {
    throw new Error(`Failed to fetch oldest queued job: ${queuedError.message}`);
  }

  const output = {
    generated_at: new Date().toISOString(),
    sample_size: statusRows?.length ?? 0,
    status_summary: statusSummary,
    oldest_queued_job: oldestQueued ?? null
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});
