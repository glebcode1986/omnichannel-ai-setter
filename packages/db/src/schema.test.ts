import { NORMALIZED_CHANNEL_EVENT_TYPES } from "@omnichannel/channel-core";
import {
  AI_DRAFT_STATUSES,
  AI_MODES,
  CHANNEL_ACCOUNT_STATUSES,
  CHANNEL_TYPES,
  CONVERSATION_STATUSES,
  DELIVERY_JOB_STATUSES,
  HUMAN_TAKEOVER_STATES,
  INSTAGRAM_AFTER_WINDOW_POLICIES,
  LEAD_STAGES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  MESSAGE_SOURCES,
  OUTBOUND_TRANSPORT_PATHS,
  REVIEW_MODES,
  TAKEOVER_REASONS,
  WHATSAPP_AFTER_WINDOW_POLICIES,
  WORKSPACE_ROLES,
  type Actor,
} from "@omnichannel/domain";
import { describe, expect, expectTypeOf, it } from "vitest";

import * as enums from "./generated/prisma/enums";

describe("Prisma enums", () => {
  it.each<[string, Record<string, string>, readonly string[]]>([
    ["ChannelType", enums.ChannelType, CHANNEL_TYPES],
    ["AiMode", enums.AiMode, AI_MODES],
    ["WorkspaceRole", enums.WorkspaceRole, WORKSPACE_ROLES],
    ["ChannelAccountStatus", enums.ChannelAccountStatus, CHANNEL_ACCOUNT_STATUSES],
    ["ConversationStatus", enums.ConversationStatus, CONVERSATION_STATUSES],
    ["LeadStage", enums.LeadStage, LEAD_STAGES],
    ["TakeoverState", enums.TakeoverState, HUMAN_TAKEOVER_STATES],
    ["TakeoverReason", enums.TakeoverReason, TAKEOVER_REASONS],
    ["ReviewMode", enums.ReviewMode, REVIEW_MODES],
    ["MessageDirection", enums.MessageDirection, MESSAGE_DIRECTIONS],
    ["MessageSource", enums.MessageSource, MESSAGE_SOURCES],
    ["MessageKind", enums.MessageKind, MESSAGE_KINDS],
    ["MessageDeliveryStatus", enums.MessageDeliveryStatus, MESSAGE_DELIVERY_STATUSES],
    ["OutboundTransportPath", enums.OutboundTransportPath, OUTBOUND_TRANSPORT_PATHS],
    ["ChannelEventType", enums.ChannelEventType, NORMALIZED_CHANNEL_EVENT_TYPES],
    ["AiDraftStatus", enums.AiDraftStatus, AI_DRAFT_STATUSES],
    ["DeliveryJobStatus", enums.DeliveryJobStatus, DELIVERY_JOB_STATUSES],
    ["InstagramAfterWindowPolicy", enums.InstagramAfterWindowPolicy, INSTAGRAM_AFTER_WINDOW_POLICIES],
    ["WhatsAppAfterWindowPolicy", enums.WhatsAppAfterWindowPolicy, WHATSAPP_AFTER_WINDOW_POLICIES],
  ])("%s mirrors the domain literal set", (_name, prismaEnum, domainValues) => {
    expect(Object.values(prismaEnum)).toEqual([...domainValues]);
  });

  it("types stay aligned with the domain", () => {
    expectTypeOf<enums.ActorKind>().toEqualTypeOf<Actor["kind"]>();
    expectTypeOf<enums.WorkspaceRole>().toEqualTypeOf<(typeof WORKSPACE_ROLES)[number]>();
    expectTypeOf<enums.DeliveryJobStatus>().toEqualTypeOf<(typeof DELIVERY_JOB_STATUSES)[number]>();
    expectTypeOf<enums.AiDraftStatus>().toEqualTypeOf<(typeof AI_DRAFT_STATUSES)[number]>();
  });
});
