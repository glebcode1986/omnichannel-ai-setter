# Voice, Images, Files & Media — Phase 5

## Principle

Media is first-class conversation input, but AI may rely only on media content that the system has actually processed with sufficient confidence. Unsupported or failed processing must never be silently guessed.

Conversation media and trusted Business Knowledge are separate domains. A customer attachment can influence the current conversation but does not become authoritative business knowledge unless an authorized human explicitly promotes it through the Knowledge workflow.

## Voice messages

Inbound voice/audio messages should appear in Inbox immediately even before transcription completes.

When the Business Profile is entitled for transcription and usage remains available:
- persist the original media reference and duration;
- create a transcription job;
- persist transcript text, detected language, processing status, timestamps and provenance back to the source message;
- make the transcript available to AI only after successful processing;
- preserve the original audio for authorized playback according to retention policy.

A transcript is derived data, not a substitute for the original message. If transcription is low confidence or unavailable, AI should ask for clarification or route to Review rather than inventing content.

## Voice usage metering

Public voice limits refer to successful transcription seconds/minutes, not general AI usage.

Accepted packaging reference:
- trial: 100 minutes;
- Starter: 300 minutes;
- Growth: 1,500 minutes;
- Scale: 6,000 minutes;
- optional one-time voice top-ups as defined in `PRICING_PACKAGING.md`.

If the allowance is exhausted:
- text AI continues normally;
- the voice message remains visible/playable in Inbox;
- automatic transcription does not run;
- the UI explains that voice transcription is unavailable and may offer a top-up/manual handling path;
- do not silently auto-charge overage.

Do not permanently consume billable voice allocation for failed attempts caused by provider/system processing failure. Usage accounting must be idempotent and reconciled against the source media operation.

## Images

Inbound images may be processed by a vision-capable adapter when the Business Profile/product configuration allows it.

Vision understanding may identify operationally useful content such as:
- object/product/category;
- screenshot/error context;
- visible text where supported;
- document/receipt type;
- property/interior/product characteristics relevant to the conversation.

Image understanding is not authoritative business truth. Product availability, price, policy, inventory, warranty and other business claims must still come from trusted Knowledge/integrations.

If visual interpretation is uncertain, ask a clarifying question or create Review rather than fabricate certainty.

Do not design customer-service flows around inferring sensitive personal attributes from images when they are not operationally necessary.

## Files and documents

Supported conversation attachments may include PDFs and other safe business/customer documents.

Conceptually separate:
- `ConversationAttachment` — customer/member file attached to a specific conversation;
- `KnowledgeDocument` — authorized trusted source ingested into business Knowledge.

A customer-provided attachment must never automatically become a cross-customer Knowledge source.

Document processing should expose only normalized extracted content needed for the current task, with provenance to the attachment and page/range when available.

## Media security

Before processing attachments:
- validate media/file type and size;
- store outside executable application paths;
- perform malware/security scanning where applicable;
- never execute macros/scripts/binaries from customer content;
- use controlled provider fetch/proxy/signed-link patterns instead of exposing permanent secret URLs;
- keep provider credentials and raw secrets out of model prompts/logs/audit.

Failed or blocked files remain visible as blocked/unsupported operational events rather than disappearing silently.

## Outbound approved media

Initial AUTOPILOT should not generate arbitrary new media and send it freely.

AI may select from Business-Profile-approved media assets through stable asset IDs, for example:
- brochure PDF;
- menu;
- price list;
- approved product/property photos;
- instructions;
- catalog.

The model proposes an asset/action. Deterministic policy verifies that the asset:
- belongs to the correct Business Profile;
- is current/active;
- is allowed for the current audience/channel;
- is marked sendable automatically or requires Review;
- remains valid at final send time.

Do not let the model invent arbitrary media URLs.

## Media Library

A Business Profile may maintain an approved Media Library with categories such as photos, catalogs, price lists, menus, brochures and instructions.

Each asset may carry policy metadata such as:
- `AUTOPILOT_ALLOWED`;
- `REVIEW_REQUIRED`;
- `INTERNAL_ONLY`;
- validity/version metadata;
- language/locale;
- related product/service tags.

Replacing an asset should preserve version/audit history and prevent stale asset references from being silently sent.

## Generated outbound media

AI-generated images, synthesized voice and other generated media are future capabilities and should be separately enabled and governed.

Initial product behavior should prefer DRAFT/Review for generated outbound media. Voice synthesis is distinct from transcription and must not be conflated with the public transcription-minute allowance.

## Contact memory

Facts extracted from voice/image/file content follow the same Contact Memory rules as facts from text.

- media-derived information is not automatically durable memory merely because extraction succeeded;
- low-risk explicit customer preferences may become normal memory candidates;
- sensitive/ambiguous facts require stricter confirmation/policy;
- provenance must retain the source media/message;
- newer explicit customer information supersedes stale derived memory.

## Review reasons

Media-related Review reasons may include:
- `TRANSCRIPTION_UNAVAILABLE`;
- `VOICE_ALLOWANCE_EXHAUSTED`;
- `MEDIA_UNSUPPORTED`;
- `VISION_LOW_CONFIDENCE`;
- `FILE_PROCESSING_FAILED`;
- `ATTACHMENT_SECURITY_BLOCK`;
- `MEDIA_FACT_UNVERIFIED`;
- `OUTBOUND_ASSET_REQUIRES_REVIEW`.

A media failure blocks only the affected action/conversation context when possible; it must not stop unrelated AUTOPILOT conversations for the Business Profile.

## Inbox UX

Voice:
- audio player;
- duration;
- transcript beneath when available;
- transcription status and retry/manual action where applicable.

Images:
- safe thumbnail/preview;
- processing status;
- optional concise extracted context for staff.

Documents:
- filename/type/size;
- safe open/download control according to permissions;
- processing/extraction status.

Do not force staff into a separate media-management screen just to understand the active conversation.

## Reliability and provenance

Normalize media understanding into explicit derived records linked to the original message/attachment. Every AI draft that uses derived media context should retain provenance IDs so reviewers/audit can determine what the model actually relied upon.

Media processing is an asynchronous server-side capability and must continue independently of browser presence.
