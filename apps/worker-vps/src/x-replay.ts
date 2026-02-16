type ReplayWindow = {
  fromDateUtcMinute: string;
  toDateUtcMinute: string;
};

export function formatReplayUtcMinute(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  const hour = date.getUTCHours().toString().padStart(2, "0");
  const minute = date.getUTCMinutes().toString().padStart(2, "0");
  return `${year}${month}${day}${hour}${minute}`;
}

export function computeReplayWindow(now: Date, windowMinutes: number): ReplayWindow {
  const oneMinuteMs = 60_000;
  const fiveDaysMs = 5 * 24 * 60 * oneMinuteMs;
  const toDate = new Date(now.getTime() - 10 * oneMinuteMs);
  const desiredFromDate = new Date(toDate.getTime() - windowMinutes * oneMinuteMs);
  const oldestAllowed = new Date(now.getTime() - fiveDaysMs + oneMinuteMs);
  const fromDate = desiredFromDate < oldestAllowed ? oldestAllowed : desiredFromDate;

  return {
    fromDateUtcMinute: formatReplayUtcMinute(fromDate),
    toDateUtcMinute: formatReplayUtcMinute(toDate)
  };
}

async function getAppBearerToken(params: {
  appKey: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const basic = Buffer.from(`${params.appKey}:${params.appSecret}`, "utf8").toString("base64");
  const response = await fetchImpl("https://api.x.com/oauth2/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8"
    },
    body: "grant_type=client_credentials"
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`X replay token request failed: ${response.status} ${responseText}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("X replay token request returned non-JSON response.");
  }

  const accessToken =
    typeof parsed === "object" && parsed !== null && "access_token" in parsed
      ? (parsed as { access_token?: unknown }).access_token
      : undefined;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error("X replay token request response missing access_token.");
  }
  return accessToken.trim();
}

export async function requestXReplayBackfill(params: {
  appKey: string;
  appSecret: string;
  webhookId: string;
  fromDateUtcMinute: string;
  toDateUtcMinute: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const bearerToken = await getAppBearerToken({
    appKey: params.appKey,
    appSecret: params.appSecret,
    fetchImpl
  });

  const replayUrl =
    `https://api.x.com/1.1/account_activity/replay/webhooks/${encodeURIComponent(params.webhookId)}` +
    `/subscriptions/all.json?from_date=${encodeURIComponent(params.fromDateUtcMinute)}` +
    `&to_date=${encodeURIComponent(params.toDateUtcMinute)}`;

  const replayResponse = await fetchImpl(replayUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerToken}`
    }
  });

  if (replayResponse.status === 200 || replayResponse.status === 202) {
    return;
  }

  const replayText = await replayResponse.text();
  throw new Error(`X replay request failed: ${replayResponse.status} ${replayText}`);
}
