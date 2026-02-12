import { describe, expect, it } from "vitest";

import { normalizeXInboundDmEvent } from "./x-normalize";

describe("normalizeXInboundDmEvent", () => {
  it("normalizes a valid X DM payload", () => {
    const payload = {
      direct_message_events: [
        {
          type: "message_create",
          id: "1900000000000000001",
          created_timestamp: "1760000000000",
          message_create: {
            sender_id: "12345",
            message_data: {
              text: "Hello there"
            }
          }
        }
      ],
      users: {
        "12345": {
          id: "12345",
          screen_name: "inbound_user"
        }
      }
    };

    const event = normalizeXInboundDmEvent(payload);

    expect(event).toEqual({
      platform: "x",
      platformMessageId: "1900000000000000001",
      platformUserId: "12345",
      platformUserHandle: "inbound_user",
      receivedAtIso: "2025-10-09T08:53:20.000Z",
      text: "Hello there"
    });
  });

  it("rejects payload with missing direct_message_events", () => {
    expect(() => normalizeXInboundDmEvent({})).toThrow("direct_message_events");
  });

  it("rejects payload with unsupported event type", () => {
    const payload = {
      direct_message_events: [
        {
          type: "typing_indicator"
        }
      ]
    };

    expect(() => normalizeXInboundDmEvent(payload)).toThrow("unsupported direct message event type");
  });

  it("rejects payload with missing sender_id or text", () => {
    const payload = {
      direct_message_events: [
        {
          type: "message_create",
          id: "1",
          created_timestamp: "1760000000000",
          message_create: {
            message_data: {
              text: ""
            }
          }
        }
      ]
    };

    expect(() => normalizeXInboundDmEvent(payload)).toThrow("sender_id");
  });
});
