"use server";

/**
 * Server actions for the Knowledge Library (KNOWLEDGE_STYLE_UX.md, ADR-011, Issue #31).
 *
 * Authorization is re-resolved from the database on every call, and the store scopes every read and write
 * to the resolved Business Profile. A form can name any document id it likes; it will get `GONE`.
 *
 * Nothing here can turn a message, a draft or a style example into a fact. The only way text reaches the
 * factual corpus is a person typing or pasting it into a form and pressing save, which is the whole of
 * ADR-011's separation: style is learned from human writing, facts are stated.
 *
 * **Every write that changes an existing source carries the version the screen was rendered against.** Not
 * as a convenience — as the condition. These are public endpoints, so "the form always sends it" is not a
 * guarantee about what arrives; a submission without a usable version is refused here, before the store is
 * called, because the alternative is applying it to whatever happens to be current. The decision is in
 * `knowledge-submission.ts` so that it can be run against requests no browser built.
 */
import { archiveKnowledge, createKnowledge, editKnowledge, publishKnowledge, restoreKnowledge } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import {
  expectedVersionOf,
  factsOf,
  field,
  knowledgeEditOf,
  knowledgeOutcomeOf,
  type KnowledgeOutcome,
  type KnowledgeTarget,
} from "./knowledge-submission";
import { requireBusinessProfileContext } from "./request-context";

export type { KnowledgeOutcome, KnowledgeTarget } from "./knowledge-submission";

const libraryPath = (target: KnowledgeTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/knowledge`;

function finish(target: KnowledgeTarget, outcome: KnowledgeOutcome, documentId?: string): never {
  const path = libraryPath(target);
  revalidatePath(path);
  redirect(documentId === undefined ? `${path}?outcome=${outcome}` : `${path}/${documentId}?outcome=${outcome}`);
}

export async function createKnowledgeAction(target: KnowledgeTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  // Creation is the one write with no prior version to be stale against: there is nothing to overwrite.
  const outcome = await createKnowledge(getDb(), context, {
    title: field(formData, "title"),
    chunks: factsOf(formData),
    scope: field(formData, "scope") === "WORKSPACE" ? "WORKSPACE" : "BUSINESS_PROFILE",
  });
  if (outcome.status === "CREATED") {
    finish(target, "CREATED", outcome.documentId);
  }
  finish(target, knowledgeOutcomeOf(outcome.status));
}

export async function editKnowledgeAction(target: KnowledgeTarget, documentId: string, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const edit = knowledgeEditOf(formData);
  if (edit === undefined) {
    // A submission that does not say which version it was composed against. Refused rather than applied
    // to whatever is current: that is the stale-tab overwrite this whole mechanism exists to prevent, and
    // it cannot be allowed to come back through a form that simply left the field out.
    finish(target, "REJECTED", documentId);
  }
  const outcome = await editKnowledge(getDb(), context, documentId, edit);
  finish(target, knowledgeOutcomeOf(outcome.status), outcome.status === "GONE" ? undefined : documentId);
}

export async function publishKnowledgeAction(target: KnowledgeTarget, documentId: string, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const expectedVersion = expectedVersionOf(formData);
  if (expectedVersion === undefined) {
    finish(target, "REJECTED", documentId);
  }
  // Publishing is the only act that changes what customers are told, so it is bound to both premises the
  // screen rendered: the version the operator was looking at, and the fact that it offered *Publish*. A
  // save that landed first makes this a CONFLICT; an archive makes it a STALE_STATE, which a version
  // check cannot see because archiving leaves the version alone.
  const outcome = await publishKnowledge(getDb(), context, documentId, { expectedVersion, act: "PUBLISH" });
  finish(target, knowledgeOutcomeOf(outcome.status, "PUBLISHED"), documentId);
}

export async function archiveKnowledgeAction(target: KnowledgeTarget, documentId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  // Archiving needs no version: it takes the source out of retrieval whatever its current wording is, so
  // there is no newer version it could be deciding about by mistake.
  const outcome = await archiveKnowledge(getDb(), context, documentId);
  finish(target, knowledgeOutcomeOf(outcome.status), documentId);
}

export async function restoreKnowledgeAction(target: KnowledgeTarget, documentId: string, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const expectedVersion = expectedVersionOf(formData);
  if (expectedVersion === undefined) {
    finish(target, "REJECTED", documentId);
  }
  // `RESTORE` rather than `PUBLISH`: this button was rendered for an archived source, and a source
  // somebody has already brought back is not one to quietly re-publish.
  const outcome = await restoreKnowledge(getDb(), context, documentId, { expectedVersion, act: "RESTORE" });
  finish(target, knowledgeOutcomeOf(outcome.status), documentId);
}
