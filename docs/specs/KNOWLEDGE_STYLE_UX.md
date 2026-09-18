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

### Business objective presets
A Business Profile may choose one primary objective and optional secondary objectives. Initial presets:
- Sales / conversion;
- Lead qualification;
- Booking / appointment;
- Customer support;
- Education / guidance;
- Concierge / premium service;
- Retention / relationship management;
- Relationship-oriented engagement;
- Custom.

Objectives influence conversational strategy and suggested next actions, not factual truth or transport eligibility.

### Communication archetypes
Archetypes are editable starting presets, not rigid industries. The owner can choose one and then tune every dimension.

Initial archetypes:
- **Calm Expert** — composed, factual, confident, low-pressure;
- **Friendly Consultant** — approachable, helpful, lightly persuasive;
- **Premium Concierge** — polished, attentive, proactive, elegant;
- **Warm Teacher** — patient, explanatory, encouraging;
- **Direct Sales Closer** — concise, assertive, conversion-oriented within configured pressure limits;
- **Soft Feminine Host** — gentle, attentive, warm, graceful, optionally lightly playful;
- **Playful / Light Flirt** — warm, charming, tasteful, lightly flirtatious when explicitly enabled;
- **Custom** — owner-defined.

The archetype name is UX sugar. Runtime behavior is driven by the resolved Style Profile dimensions below so future archetypes can be added without changing core architecture.

### Style profile dimensions
Use discrete named levels rather than fake-precise 0–100 sliders in the default UI. Advanced settings may expose finer numeric values internally.

Core dimensions:
- **Formality:** casual / balanced / formal;
- **Warmth:** low / medium / high;
- **Empathy / softness:** low / medium / high;
- **Concision:** brief / balanced / detailed;
- **Directness:** soft / balanced / direct;
- **Persuasion pressure:** none / light / active / strong-within-policy;
- **Humor:** off / subtle / playful;
- **Playfulness:** off / light / expressive;
- **Emoji:** off / occasional / frequent;
- **Compliments:** off / occasional / warm / frequent-within-policy;
- **Persona presentation:** neutral / feminine / masculine / custom brand voice;
- **Flirtation:** off / light / playful / romantic;
- **Intimacy ceiling:** neutral / affectionate / romantic / mildly suggestive;
- **Greeting style:** none / short / warm / custom;
- **Sign-off style:** none / short / warm / custom.

The product may also store free-text instructions such as preferred phrases, prohibited phrases, brand vocabulary and examples of what "too pushy", "too cold" or "too flirtatious" means for this business.

### Relationship-sensitive / romantic communication
Where a Business Profile intentionally enables relationship-oriented communication:
- flirtation is explicit configuration and is never inferred merely from the customer's gender, name or wording;
- persona presentation may be feminine, masculine, neutral or custom only when the business intentionally configures that representation;
- the system may use warmth, playful attention, tasteful compliments, romantic tone and mild suggestiveness within the configured ceiling;
- it may acknowledge attraction/interest conversationally without inventing real-world physical presence, private actions, relationship status, personal history, promises or genuine human emotions as facts;
- it must not impersonate a named real employee unless that identity/representation is truthful and intentionally configured;
- explicit sexual content is outside AUTOPILOT behavior; content crossing the configured intimacy ceiling is de-escalated, redirected or sent to Review according to policy;
- romantic/flirtatious modes are adult-only behavior. If a conversation indicates the customer is a minor, or age is materially uncertain in a context where romantic content would be unsafe, the relationship-oriented persona is disabled for that conversation and the system uses neutral business communication / Review.

The product therefore supports dating agencies, romantic-event businesses, premium companionship-style customer communication and similar legitimate conversation-heavy use cases without turning the platform into an unrestricted erotic-chat system.

### Contextual tone adaptation
The configured profile is a ceiling and default, not a requirement to behave identically in every message.

The AI may temporarily become more neutral, concise or formal when the context calls for it, for example:
- complaint, refund or conflict;
- customer discomfort or rejection of a playful tone;
- legal/payment/security issue;
- grief, distress or another sensitive topic;
- missing factual basis or mandatory Review condition.

It may reduce warmth, persuasion, humor, compliments, flirtation or intimacy automatically when appropriate. It must never increase those dimensions beyond the Business Profile's configured maximum without an explicit human change.

### Conversation-level overrides
A human may temporarily adjust style for one conversation without changing the Business Profile default, for example:
- `More formal for this conversation`;
- `No sales pressure`;
- `No flirtation`;
- `Short replies only`;
- `Human takeover`.

Conversation overrides are auditable and expire/resume according to explicit policy. A customer signal that clearly rejects a tone should result in an automatic downward adjustment for that conversation, not repeated attempts to reintroduce it.

### Example library
Each example stores inbound context + verified human outbound response + provenance:
- `HUMAN_TYPED`;
- `HUMAN_EDITED_DRAFT`.

Examples may optionally be tagged by archetype/dimension, language and conversation type so retrieval can prefer relevant examples.

User can approve/reject suggested style examples before they become active.

Examples influence phrasing, emotional register and pacing only. They never become factual Knowledge merely because a human previously wrote them.

### Learning loop
The initial product should not continuously fine-tune or mutate the base LLM from every conversation.

Instead, learning is controlled through:
- approved style examples;
- explicit Style Profile settings;
- retrieval of relevant examples for the current conversation;
- aggregate pattern suggestions derived from repeated human edits.

If humans repeatedly make the same edit (for example removing formal greetings, shortening replies, softening sales pressure, adding more warmth, increasing elegance or reducing flirtation), the system may propose a Style Profile change. The owner/admin must approve the change before it becomes active unless an explicit future policy says otherwise.

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

For relationship-sensitive profiles, Test Style should include at least one boundary example showing how the AI responds when a customer pushes beyond the configured intimacy ceiling.

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

## Product-owner implementation clarifications — 2026-09-18

### Style Profile / persona persistence
The business communication persona is customer-owned product configuration, not worker environment configuration.

Canonical runtime resolution:
1. Workspace base `StyleProfile`;
2. optional Business-Profile-specific `StyleProfile` override;
3. conversation-level downward/temporary overrides where allowed;
4. platform default only when no customer-owned Style Profile exists.

Worker/environment configuration may provide a safe generic platform fallback, but must never be the authoritative persona for a specific Workspace or Business Profile.

Phase 5 owns the end-user Style UI. Earlier backend phases may seed/store the same canonical Style Profile shape so AI behavior is testable before the UI exists.

### Pre-Phase-5 seeding
Do not pull the full Knowledge/Style editing UI into Phase 2. Provide a minimal internal/dev/test seeding path sufficient for the Instagram vertical slice and CI to create versioned trusted Knowledge and approved Style data with real provenance. This path is not a public customer API and must not bypass normal Workspace/Business-Profile scope rules.

### Workspace base vs Business Profile override
Retrieve both Workspace-base and Business-Profile-specific material. Business-Profile-specific material takes precedence **only when an override is intentional and explicitly represented**; semantic similarity alone must never guess that two facts conflict.

Until ingestion has explicit override metadata, do not silently shadow Workspace facts by semantic inference. The Phase-2 vertical-slice fixtures should avoid contradictory unlinked sources. Phase-5 ingestion must expose an explicit override/supersession relationship or stable logical key so deterministic shadowing is possible.

Style follows the same base + BP-override model at the profile/dimension level.
