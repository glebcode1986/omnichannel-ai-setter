# ADR-007: Threads Private Messaging Is Not an MVP Channel

**Status:** Accepted

## Decision

Do not include Threads private DM automation in MVP until Meta provides a supported public private-messaging API suitable for third-party apps.

## Why

Current official Threads API references expose publishing, replies, insights, search and mention management, but no public DM send/read capability was identified during the 2026-09-16 verification.

## Consequences

- preserve generic `ChannelType`/adapter extensibility so Threads can be added later;
- do not use browser automation, session-cookie automation or other unofficial private-message workarounds on customer accounts;
- re-check Meta API capabilities before each major release planning cycle.
