# Knowledge + Style UX — Phase 5

## Product distinction

`Knowledge` answers: **what is true about the business?**

`Style` answers: **how should the business sound?**

They are separate screens, stores and permissions because style examples must never become factual authority.

## Knowledge screen

### Library
Show knowledge sources with:
- title/type;
- workspace/account scope;
- active/draft/archived status;
- last updated/version;
- ingestion/index status;
- quick search/test.

### Source types for MVP
- manually entered fact/article/FAQ;
- structured FAQ pair;
- pasted long text;
- later supported document ingestion.

### Editing
Editing creates a new version rather than mutating provenance invisibly. Old versions remain auditable and inactive when superseded.

### Test retrieval
User enters a customer question and sees top factual hits and provenance. This is retrieval testing, not an LLM answer test.

### Missing-fact feedback loop
When review is triggered because of `MISSING_FACT`, the human reviewer may choose `Add to knowledge`. The UI opens a factual editor with suggested wording, but saving requires human confirmation. A human message or edited draft is never automatically promoted into factual knowledge.

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

Both knowledge and style can be workspace-wide or account-specific. Account-specific material wins only within that account; cross-workspace retrieval is forbidden.

## Quality controls

- detect empty/duplicate/near-duplicate sources where practical;
- show stale/version warnings;
- do not silently index failed uploads;
- allow archive/restore with audit history;
- retrieval/outage state must be visible rather than producing invented confident answers.
