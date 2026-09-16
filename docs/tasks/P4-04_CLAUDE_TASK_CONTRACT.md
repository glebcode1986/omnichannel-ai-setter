# Task Contract — P4-04 Claude

**Issue:** #21 `[P4-04] Implement WhatsApp media and voice-note processing`  
**Branch:** `feat/p4-04-whatsapp-media-voice`  
**Owner:** Claude. Do not merge own PR.

## Read first
`PROJECT_CONTEXT.md`, `WHATSAPP_ADAPTER.md`, `AI_BEHAVIOR.md`, relevant privacy/data specs, Issue #21.

## Objective
Safely process inbound WhatsApp media and add voice-note transcription without making the transport adapter responsible for AI understanding.

## Required behavior
- persist provider media reference/type/MIME/caption/context/provenance;
- authenticated bounded media fetch with size/type/time limits;
- provider-neutral transcription boundary for audio/voice notes;
- store transcript + provider/model/version/confidence/error provenance separately;
- transcript enters AI context as untrusted participant content;
- failures/unsupported formats -> safe review/escalation, never guessed content;
- sensitive logging/retention/deletion hooks.

## Tests
Valid voice note, unsupported type/codec, oversize, download error, transcription timeout/malformed response, duplicate webhook/media, workspace isolation and successful transcript propagation into draft context.

## Forbidden
No raw media/token logging, no model/provider-specific transcript type leaking into core, no automatic reply based on failed transcription.

## PR
Document limits and retention assumptions. Run integration/security/root tests. Do not merge.