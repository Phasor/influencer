import type { SupabaseClient } from "@supabase/supabase-js";

import {
  dedupeKeyForInboundMessage,
  enqueueJob,
  getOrCreateConversation,
  insertMessage
} from "./db";
import type { InboundDmEvent } from "./types";

type ExistingMessageLookup = {
  id: string;
  conversation_id: string;
};

export type IngestInboundDmResult = {
  conversationId: string;
  messageId: string;
  jobId: string;
  messageCreated: boolean;
  jobCreated: boolean;
};

function isMessageDuplicateError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("messages_platform_message_id_key");
}

async function fetchExistingMessageByPlatformId(
  client: SupabaseClient,
  platformMessageId: string
): Promise<ExistingMessageLookup> {
  const { data, error } = await client
    .from("messages")
    .select("id, conversation_id")
    .eq("platform_message_id", platformMessageId)
    .single();

  if (error || !data) {
    throw new Error(
      `fetchExistingMessageByPlatformId failed: ${error?.message ?? "no message found"}`
    );
  }

  return data as unknown as ExistingMessageLookup;
}

async function updateConversationLastMessage(
  client: SupabaseClient,
  conversationId: string,
  occurredAtIso: string
): Promise<void> {
  const { error } = await client
    .from("conversations")
    .update({
      last_message_at: occurredAtIso
    })
    .eq("id", conversationId);

  if (error) {
    throw new Error(`updateConversationLastMessage failed: ${error.message}`);
  }
}

export async function ingestInboundDmEvent(
  client: SupabaseClient,
  event: InboundDmEvent
): Promise<IngestInboundDmResult> {
  const conversation = await getOrCreateConversation(
    client,
    event.platformUserId,
    event.platformUserHandle,
    event.platform
  );

  let messageId: string;
  let conversationId = conversation.id;
  let messageCreated = true;

  try {
    const message = await insertMessage(client, {
      conversationId: conversation.id,
      direction: "inbound",
      text: event.text,
      occurredAtIso: event.receivedAtIso,
      platformMessageId: event.platformMessageId,
      platform: event.platform
    });
    messageId = message.id;
  } catch (error) {
    if (!isMessageDuplicateError(error)) {
      throw error;
    }

    const existingMessage = await fetchExistingMessageByPlatformId(client, event.platformMessageId);
    messageId = existingMessage.id;
    conversationId = existingMessage.conversation_id;
    messageCreated = false;
  }

  const enqueueResult = await enqueueJob(client, {
    type: "respond_to_inbound_dm",
    payload: {
      inboundMessageId: event.platformMessageId,
      platformUserId: event.platformUserId
    },
    dedupeKey: dedupeKeyForInboundMessage(event.platformMessageId)
  });

  if (messageCreated) {
    await updateConversationLastMessage(client, conversationId, event.receivedAtIso);
  }

  return {
    conversationId,
    messageId,
    jobId: enqueueResult.job.id,
    messageCreated,
    jobCreated: enqueueResult.created
  };
}
