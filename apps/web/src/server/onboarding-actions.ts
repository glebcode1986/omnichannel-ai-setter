"use server";

/**
 * The front door (#115).
 *
 * `createWorkspaceWithOwner` and `createBusinessProfile` have existed in `packages/db` since Phase 1 and
 * **only tests called them**: an authenticated customer could reach the chooser, see an empty list and do
 * nothing about it. These two actions are the missing path, and they are deliberately the *only* new one —
 * the stores, the role rules, the capacity lock, the default policy and the onboarding checklist already
 * exist and are reused as they stand.
 *
 * Three rules this file keeps, each of which it would be easy to break:
 *
 * - **The owner is the session, never the submission.** `ownerUserId` comes from
 *   `requireSessionUserId()`. A posted `ownerUserId` would let any authenticated caller create a
 *   workspace owned by somebody else, which is why no field of that name is read anywhere below.
 * - **The Workspace is named by the route and authorized by membership.** Profile creation re-resolves
 *   the context from the database on every call, so a form that names another tenant's workspace is
 *   refused by `authorizeWorkspaceAccess` before this file does anything with it.
 * - **Nothing here starts a trial.** Creating a Workspace or a Business Profile buys nothing and grants
 *   nothing; the accepted no-card trial starts in `connectChannelAccount`, on the first verified
 *   successful channel connection, and this file must stay out of that decision.
 */
import { createBusinessProfile, createWorkspaceOnce, listAuthorizedBusinessProfiles } from "@omnichannel/db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getDb } from "./db";
import { nameOf, refusalOutcome, type OnboardingOutcome } from "./onboarding-submission";
import { requireSessionUserId, requireWorkspaceContext } from "./request-context";

/**
 * Leaves the page and says what happened, in the URL.
 *
 * The same mechanism every other screen in this app uses: an outcome in the query string survives a
 * reload, which is exactly when somebody re-reads a refusal they did not expect. Typed `never` and called
 * outside any `try`, because `redirect()` works by throwing — catching it would turn a navigation into a
 * swallowed error and leave the person on a page that reported nothing.
 */
function finish(path: string, outcome: OnboardingOutcome): never {
  revalidatePath(path);
  redirect(`${path}?outcome=${outcome}`);
}

/**
 * Creates the Workspace the signed-in person will own.
 *
 * Idempotent by way of `createWorkspaceOnce`, which takes the same transaction-scoped advisory lock the
 * capacity checks take and reports a replay instead of inserting a second row. A double-click therefore
 * produces one workspace and two navigations to it, rather than two workspaces with one name — and a
 * workspace cannot be deleted, so the duplicate would have been permanent.
 */
export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const ownerUserId = await requireSessionUserId();
  const submitted = nameOf(formData);
  if (submitted.kind === "REFUSED") {
    finish("/workspaces", submitted.outcome);
  }

  let outcome: OnboardingOutcome;
  let path = "/workspaces";
  try {
    const created = await createWorkspaceOnce(getDb(), { name: submitted.name, ownerUserId });
    outcome = created.replayed ? "WORKSPACE_REPLAYED" : "WORKSPACE_CREATED";
    path = `/workspaces/${created.workspace.workspaceId}`;
  } catch (error) {
    const refused = refusalOutcome(error, submitted.name);
    if (refused === undefined) {
      throw error;
    }
    outcome = refused;
  }
  // `/workspaces` is revalidated as well as the page we land on: the chooser's list is what just changed,
  // and a cached copy of it would show a person an empty list immediately after they filled it.
  revalidatePath("/workspaces");
  finish(path, outcome);
}

/**
 * Creates a Business Profile inside a Workspace this person administers.
 *
 * The role, the profile scope, the plan's profile ceiling and the default automation policy are all the
 * store's decisions, taken inside its own transaction under its own lock; this action's job is to resolve
 * the context, hand over a validated name and report what came back. On success it goes to that profile's
 * resumable setup, because a profile in `SETUP` with nothing connected is not a destination.
 *
 * The pre-check against the profiles already in this Workspace catches the ordinary double-submit. It is
 * **not** the guarantee for concurrent submissions on a workspace with no plan: a plan with a ceiling is
 * serialized by the store's capacity lock, and an unbounded workspace has no ceiling to serialize on, so
 * two genuinely simultaneous submissions could both land. Said plainly rather than implied, because the
 * duplicate is a profile nothing deletes.
 */
export async function createBusinessProfileAction(workspaceId: string, formData: FormData): Promise<void> {
  const context = await requireWorkspaceContext(workspaceId);
  const submitted = nameOf(formData);
  const workspacePath = `/workspaces/${workspaceId}`;
  if (submitted.kind === "REFUSED") {
    finish(workspacePath, submitted.outcome);
  }

  let outcome: OnboardingOutcome;
  let path = workspacePath;
  try {
    // The ordinary double-submit, answered before the store is asked: a profile this membership can
    // already see, under the name just typed, is this submission arriving twice. Matched on the stored
    // name, which is the trimmed one `nameOf` produced, so the two sides are comparable.
    const existing = (await listAuthorizedBusinessProfiles(getDb(), context)).find((profile) => profile.name === submitted.name);
    if (existing !== undefined) {
      outcome = "PROFILE_REPLAYED";
      path = `${workspacePath}/profiles/${existing.businessProfileId}/setup`;
    } else {
      const created = await createBusinessProfile(getDb(), context, { name: submitted.name });
      outcome = "PROFILE_CREATED";
      path = `${workspacePath}/profiles/${created.businessProfileId}/setup`;
    }
  } catch (error) {
    const refused = refusalOutcome(error, submitted.name);
    if (refused === undefined) {
      throw error;
    }
    outcome = refused;
  }
  revalidatePath(workspacePath);
  finish(path, outcome);
}
