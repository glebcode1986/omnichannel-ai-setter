-- Read and typing presence (#22, P4-05).
--
-- Presence is a promise to a customer: a read receipt says their message was seen, and a typing indicator
-- says a reply is on its way. So it is off until a business asks for it, and the two cannot be chosen
-- independently — the provider's documented request for the indicator carries the read status as a
-- required field, and a pair of booleans would offer a combination no channel can perform.
CREATE TYPE "PresenceMode" AS ENUM ('OFF', 'READ_ON_RECEIPT', 'READ_AND_TYPING');

ALTER TABLE "automation_policies"
  ADD COLUMN "presence_mode" "PresenceMode" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "presence_typing_lead_ms" INTEGER NOT NULL DEFAULT 8000;

-- The upper bound is the provider's, not ours: WhatsApp dismisses the typing indicator after 25 seconds,
-- so a longer lead would display it, drop it, and leave the customer watching nothing until the reply
-- arrives. A business may still choose less, and the delay engine's own choice shortens it further when a
-- reply is scheduled sooner than the lead.
ALTER TABLE "automation_policies" ADD CONSTRAINT "automation_policies_presence_lead_check" CHECK (
  "presence_typing_lead_ms" >= 0 AND "presence_typing_lead_ms" <= 25000
);
