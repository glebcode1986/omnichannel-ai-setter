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

### Style is configurable for different business models
The product must not assume every Business Profile is a conventional sales funnel. The same AI runtime may support sales, support, education, hospitality/concierge, premium personal service, relationship/dating services and other conversation-heavy businesses.

Model behavior therefore separates three independent layers:
1. **Business objective** — what outcome the business wants: qualify, sell, book, educate, support, retain, concierge, continue a relationship-oriented conversation, etc.
2. **Communication persona** — how the representative should sound.
3. **Safety / appropriateness boundary** — what the representative must not claim or escalate into, regardless of style.

Changing the communication persona must not silently change factual authority, qualification logic or deterministic send policy.

### Style profile
Simple instructions should support both presets and advanced controls, including:
- tone/adjectives;
- preferred answer length;
- formality and register;
- warmth / emotional softness;
- directness / assertiveness;
- sales pressure / persuasion intensity;
- humor and playfulness;
- emoji preference;
- greeting/sign-off habits;
- words/phrases to prefer or avoid;
- language/register conventions;
- optional persona presentation such as neutral, feminine, masculine or custom brand voice;
- compliment frequency and type;
- optional flirtation level for businesses where light relationship-oriented communication is appropriate;
- optional intimacy ceiling so a business can allow affectionate or mildly suggestive wording without permitting explicit sexual conversation.

The UI should prefer understandable presets first, then expose sliders/toggles/advanced text instructions for owners who need finer control.

### Example communication archetypes
Presets are starting points, not hard-coded business categories. Examples may include:
- Calm Expert;
- Friendly Consultant;
- Premium Concierge;
- Warm Teacher;
- Direct Sales Closer;
- Soft Feminine Host;
- Playful / Light Flirt;
- Custom.

For example, a dating/relationship agency may configure a feminine, warm, attentive representative who uses gentle compliments, soft humor and light flirtation without vulgarity or explicit sexual language. A B2B account may instead use a concise, professional, low-emotion style while sharing the same underlying lead/knowledge infrastructure.

### Relationship-sensitive / flirtatious style
Where a Business Profile intentionally enables relationship-oriented communication:
- flirtation must be explicit configuration, never inferred merely from the customer's gender or wording;
- the system may use warmth, playful attention, tasteful compliments and light suggestiveness within the configured boundary;
- it must not fabricate real-world personal history, physical presence, private actions, promises or emotions as facts;
- it must not impersonate a named real employee unless that identity/representation is truthful and intentionally configured;
- explicit sexual content should not be generated by AUTOPILOT; requests that cross the configured intimacy ceiling should be de-escalated, redirected or sent to Review according to business policy;
- romantic/flirtatious modes are adult-only behavior. If a conversation indicates the customer is a minor, or age is materially uncertain in a context where romantic content would be unsafe, the relationship-oriented persona is disabled for that conversation and the system uses neutral business communication / Review.

The intent is to support tasteful, commercially appropriate relationship-oriented communication without turning the product into an unrestricted erotic-chat system.

### Example library
Each example stores inbound context + verified human outbound response + provenance:
- `HUMAN_TYPED`;
- `HUMAN_EDITED_DRAFT`.

User can approve/reject suggested style examples before they become active.

Examples influence phrasing, emotional register and pacing only. They never become factual Knowledge merely because a human previously wrote them.

### Learning loop
The initial product should not continuously fine-tune or mutate the base LLM from every conversation.

Instead, learning is controlled through:
- approved style examples;
- explicit Style Profile settings;
- retrieval of relevant examples for the current conversation;
- aggregate pattern suggestions derived from repeated human edits.

If humans repeatedly make the same edit (for example removing formal greetings, shortening replies, softening sales pressure, adding more warmth or reducing flirtation), the system may propose a Style Profile change. The owner/admin must approve the change before it becomes active unless an explicit future policy says otherwise.

This prevents one bad employee response from silently retraining the product voice.

### Multilingual style behavior
Style is semantic, not a literal translation template. Preserve the intended personality and relationship level when switching languages, while adapting phrasing to what sounds natural in that language.

A Russian feminine/warm style should not be mechanically translated phrase-for-phrase into English, Polish or another language. The model should preserve warmth, formality, playfulness, flirtation level and boundaries while using culturally natural wording.

### Test style
Style testing should allow a neutral customer message plus optional customer context and show candidate outputs under the current profile.

For advanced profiles, the tester should expose which dimensions were active (for example warmth, formality, persuasion, flirtation ceiling) and which approved examples influenced the answer.

A useful comparison mode may show alternatives such as:
- current profile;
- more formal;
- warmer/softer;
- more concise;
- less/more persuasive;
- where enabled, less/more playful within the configured safe ceiling.

This test must not imply that style examples validate business facts.

## Scope

Both knowledge and style can be workspace-wide or Business-Profile-specific. Business-Profile-specific material wins only within that profile; cross-workspace retrieval is forbidden.

A workspace may define a base brand voice while each Business Profile overrides persona/objective dimensions appropriate to that business.

## Quality controls

- detect empty/duplicate/near-duplicate sources where practical;
- show stale/version/expiry warnings;
- do not silently index failed uploads;
- allow archive/restore with audit history;
- retrieval/outage state must be visible rather than producing invented confident answers;
- never promote chat text or style examples into factual authority without an explicit human confirmation step;
- never allow Style settings to override deterministic channel, entitlement, human-takeover or safety gates.
