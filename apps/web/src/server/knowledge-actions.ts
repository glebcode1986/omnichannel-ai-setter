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
 */
import { archiveKnowledge, createKnowledge, editKnowledge, publishKnowledge, restoreKnowledge } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { requireBusinessProfileContext } from "./request-context";

export interface KnowledgeTarget {
  readonly workspaceId: string;
  readonly businessProfileId: string;
}

export type KnowledgeOutcome = "CREATED" | "VERSIONED" | "UNCHANGED" | "PUBLISHED" | "ARCHIVED" | "RESTORED" | "GONE" | "REJECTED";

const libraryPath = (target: KnowledgeTarget) => `/workspaces/${target.workspaceId}/profiles/${target.businessProfileId}/knowledge`;

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * One fact per line.
 *
 * Splitting is the operator's decision made visible, not a hidden heuristic: they can see exactly which
 * lines became which facts, and a retrieval hit later points at one of them. A silent splitter would make
 * provenance unexplainable — "which sentence did it cite?" would have no answer on screen.
 */
function factsOf(formData: FormData): readonly string[] {
  return field(formData, "facts")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function finish(target: KnowledgeTarget, outcome: KnowledgeOutcome, documentId?: string): never {
  const path = libraryPath(target);
  revalidatePath(path);
  redirect(documentId === undefined ? `${path}?outcome=${outcome}` : `${path}/${documentId}?outcome=${outcome}`);
}

export async function createKnowledgeAction(target: KnowledgeTarget, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await createKnowledge(getDb(), context, {
    title: field(formData, "title"),
    chunks: factsOf(formData),
    scope: field(formData, "scope") === "WORKSPACE" ? "WORKSPACE" : "BUSINESS_PROFILE",
  });
  if (outcome.status === "CREATED") {
    finish(target, "CREATED", outcome.documentId);
  }
  finish(target, outcome.status === "REJECTED" ? "REJECTED" : "GONE");
}

export async function editKnowledgeAction(target: KnowledgeTarget, documentId: string, formData: FormData): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await editKnowledge(getDb(), context, documentId, { title: field(formData, "title"), chunks: factsOf(formData) });
  finish(
    target,
    outcome.status === "VERSIONED" ? "VERSIONED" : outcome.status === "UNCHANGED" ? "UNCHANGED" : outcome.status === "REJECTED" ? "REJECTED" : "GONE",
    outcome.status === "GONE" ? undefined : documentId,
  );
}

export async function publishKnowledgeAction(target: KnowledgeTarget, documentId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await publishKnowledge(getDb(), context, documentId);
  finish(target, outcome.status === "RESTORED" ? "PUBLISHED" : outcome.status === "REJECTED" ? "REJECTED" : "GONE", documentId);
}

export async function archiveKnowledgeAction(target: KnowledgeTarget, documentId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await archiveKnowledge(getDb(), context, documentId);
  finish(target, outcome.status === "ARCHIVED" ? "ARCHIVED" : "GONE", documentId);
}

export async function restoreKnowledgeAction(target: KnowledgeTarget, documentId: string): Promise<void> {
  const context = await requireBusinessProfileContext(target.workspaceId, target.businessProfileId);
  const outcome = await restoreKnowledge(getDb(), context, documentId);
  finish(target, outcome.status === "RESTORED" ? "RESTORED" : outcome.status === "REJECTED" ? "REJECTED" : "GONE", documentId);
}
