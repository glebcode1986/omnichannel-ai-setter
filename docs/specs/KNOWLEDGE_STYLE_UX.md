# Knowledge + Style UX — Phase 5

## Product distinction

`Knowledge` answers: **what is true about the business?**

`Style` answers: **how should the business sound?**

They are separate screens, stores and permissions because style examples must never become factual authority.

## Knowledge screen

### Library
Show knowledge sources with:
- title/type;
- workspace or Business Profile scope;
- active/draft/archived status;
- last updated/version;
- optional validity end / review-after date;
- ingestion/index status;
- provenance/source;
- quick search/test.

### Source types for MVP
- manually entered fact/article/FAQ;
- structured FAQ pair;
- pricing / plans / services;
- products and availability facts;
- delivery / returns / warranty / business policy;
- locations / opening hours;
- promotions with optional validity dates;
- pasted long text;
- later supported document ingestion, website import and connectors.

### Editing and versions
Editing creates a new version rather than mutating provenance invisibly. Old versions remain auditable and inactive when superseded.

A superseded version must not continue participating in retrieval merely because an old embedding/index row still exists.

### Freshness and expiry
Knowledge may optionally have:
- `valid_until` for time-bounded facts such as promotions;
- `review_after` for facts that should be reconfirmed periodically.

Expired knowledge is excluded from authoritative retrieval. `review_after` produces a visible stale/review-needed warning but does not silently rewrite the fact. The product should surface a queue/count such as "5 knowledge items need review".

### Scope and precedence
Knowledge may be workspace-wide or Business-Profile-specific.

Workspace-wide material is reusable across profiles. Business-Profile-specific material takes precedence within that profile when it intentionally overrides a shared fact. Cross-workspace retrieval is forbidden.

### Multilingual behavior
Knowledge truth is language-independent at the product level. A source may be authored in Russian, English or another supported language while the AI answers the end customer in the conversation language.

Do not require owners to create duplicate FAQ entries for every response language. Translation/adaptation belongs to reply generation, not to creating a second independent factual authority. The original source/provenance must remain traceable.

### Test retrieval
User enters a customer question and sees top factual hits and provenance. This is retrieval testing, not merely an opaque LLM answer test.

The UI should make it easy to understand which facts would be used for a real response and whether any relevant source is stale, expired or failed to index.

### Missing-fact feedback loop
When review is triggered because of `MISSING_FACT`, the human reviewer may choose `Add to knowledge`. The UI opens a factual editor with suggested wording, but saving requires human confirmation. A human message or edited draft is never automatically promoted into factual knowledge.

### Retrieval failure behavior
If retrieval/index infrastructure is unavailable or the relevant source failed ingestion, the AI must not silently fall back to invented business facts from model memory.

Depending on the conversation, it may ask a clarifying question, use explicit conversation context that is already trustworthy, or hold/escalate to Review. Technical retrieval failure must be visible in operational state.

## Style screen

### Style profile
Simple instructions:
- tone/adjectives;
- preferred answer length;
- emoji preference;
- greeting/sign-off habits;
- words/phrases to prefer or avoid;
- language/register conventions.

### Example library
Each example stores inbound context + verified human outbound response + provenance:
- `HUMAN_TYPED`;
- `HUMAN_EDITED_DRAFT`.

User can approve/reject suggested style examples before they become active.

### Test style
Show a neutral test prompt with candidate output and the style examples/instructions that influenced it. This test must not imply that style examples validate business facts.

## Scope

Both knowledge and style can be workspace-wide or Business-Profile-specific. Business-Profile-specific material wins only within that profile; cross-workspace retrieval is forbidden.

## Quality controls

- detect empty/duplicate/near-duplicate sources where practical;
- show stale/version/expiry warnings;
- do not silently index failed uploads;
- allow archive/restore with audit history;
- retrieval/outage state must be visible rather than producing invented confident answers;
- never promote chat text or style examples into factual authority without an explicit human confirmation step.
