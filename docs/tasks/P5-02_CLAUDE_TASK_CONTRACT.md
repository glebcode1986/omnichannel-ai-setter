# Task Contract — P5-02 Claude

**Issue:** #28 `[P5-02] Build unified omnichannel Inbox`  
**Branch:** `feat/p5-02-unified-inbox`  
**Owner:** Claude. Do not merge own PR.

## Start condition
Conversation/message query APIs and workspace tenancy are stable. One live channel is sufficient; UI must remain channel-neutral.

## Read first
`PROJECT_CONTEXT.md`, `PRODUCT_UX.md`, `PHASE5_IMPLEMENTATION_PLAN.md`, channel contracts, Issue #28.

## Objective
Build one unified operational Inbox for Instagram and WhatsApp.

## Required scope
- three-pane desktop / stacked mobile layout;
- conversation list/search/filter/pagination;
- thread rendering with source distinctions;
- channel/account badges and AI/review/takeover state;
- right-side contact/lead/AI context summary;
- robust empty/loading/error/stale states.

## Forbidden
Do not put provider payload types in generic UI state. Do not implement policy/send decisions in React components. Do not implement Review actions from #29 except non-functional status display/placeholders.

## Verification
Test mixed-channel fixtures, workspace isolation, pagination/search/filter combinations, unread updates, keyboard/focus, mobile navigation and large-list performance strategy. Run root checks and open a focused PR; do not merge.