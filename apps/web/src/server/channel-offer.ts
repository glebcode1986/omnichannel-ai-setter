/**
 * One answer to "which channels can this deployment connect, and how".
 *
 * There are two screens that ask — setup and channels — and they had drifted apart, which is the whole
 * reason this is a function rather than a few lines on each page. Setup offered both channels and built
 * its controls the current way; the channels screen still offered Instagram alone and passed a prop
 * `ChannelCards` had stopped accepting, so its connect button vanished on every deployment. TypeScript
 * could not see it: a JSX spread of a conditional object is not checked for properties the component does
 * not declare, so `{...(canConfigure ? { instagramConnectPath } : {})}` compiled and did nothing.
 *
 * Two inputs, both of which must hold before a control is drawn:
 *
 * - **the reader's role**, because a member who may not configure channels is shown no control; and
 * - **the deployment's configuration**, because a control that answers "not configured" reads as our
 *   failure, and an Instagram control with placeholder credentials reads as Meta's.
 *
 * `offered` lists both channels regardless, so an unconnected one still gets a card that says where it
 * stands; `connect` carries an entry only for the ones that can actually be started.
 *
 * **Each conditional branch carries `satisfies`, and that is load-bearing.** The same hole that produced
 * the dead prop reaches object literals, and what opens it is the **spread**, not the shape of the target:
 * excess-property checking applies to an object literal written in place and not to the result of a
 * spread. Measured both ways against this one type — `INSTAGRAM_TYPO` as a direct property of `connect`
 * is `TS2353`, while the identical key inside a bare `...(cond ? { … } : {})` compiles with no diagnostic
 * at all, which would have withdrawn Instagram's connect button on every deployment: the exact defect
 * this file was written to end. `satisfies` puts the branch back in a checked position, so both are errors.
 *
 * Being all-optional costs this type its last fallback rather than causing the hole. A target with a
 * required property at least fails as a missing property once every key is misspelled; `Partial<Record<…>>`
 * only trips TypeScript's weak-type check, which needs *no* key in common — and a sibling always leaves one.
 *
 * `Pick` rather than the whole `connect` type, because the whole type admits *either* key: a branch that
 * supplied `WHATSAPP` — the copy-paste this file invites, two near-identical branches — satisfied it and
 * compiled, withdrawing Instagram exactly as the original defect did. Narrowed to the one key each branch
 * is responsible for, that is `TS2322`. Measured; the broad form survives it and this one does not.
 *
 * The class is wider than this file — 124 of these spreads in `apps/web/src` reach a declared key set —
 * but two things decide whether any one of them matters, and neither is the key's name. **The verdict
 * belongs to the site:** `whatsapp-account-events.ts` spreads the same `reason` nine lines apart into a
 * declared type and into `LogFields`, which is `Readonly<Record<string, unknown>>` and admits any key, so
 * `satisfies` there would be a no-op that merely looks like hardening. **And a test defends only a field
 * it asserts** — the shape to look for is a *fake that answers a constant*, which silently moves the only
 * assertion into a test that calls the store directly and never exercises the spread at all.
 */
import { WORKSPACE_ADMIN_ROLES, type BusinessProfileContext } from "@omnichannel/db";
import type { ChannelType } from "@omnichannel/domain";

import type { ConnectControl } from "@/ui/channel-cards";
import { instagramOAuthConfigured } from "./instagram";
import { whatsAppSignupConfigured } from "./whatsapp";

/** Every channel this product supports, in the order the cards appear. */
export const SUPPORTED_CHANNELS: readonly ChannelType[] = ["INSTAGRAM", "WHATSAPP"];

export interface ChannelOffer {
  readonly offered: readonly ChannelType[];
  readonly connect: Partial<Record<ChannelType, ConnectControl>>;
}

export function channelOffer(
  target: { readonly workspaceId: string; readonly businessProfileId: string },
  /** Only the role is read; taking the whole context would let this reach for data it has no business in. */
  reader: Pick<BusinessProfileContext, "role">,
): ChannelOffer {
  const base = `/api/workspaces/${target.workspaceId}/business-profiles/${target.businessProfileId}/channels`;
  if (!WORKSPACE_ADMIN_ROLES.includes(reader.role)) {
    return { offered: SUPPORTED_CHANNELS, connect: {} };
  }
  return {
    offered: SUPPORTED_CHANNELS,
    connect: {
      // Instagram is a form POST to our own route, which answers `303` to Meta's authorize URL and sets
      // the state cookie on the same response.
      ...(instagramOAuthConfigured()
        ? ({ INSTAGRAM: { kind: "REDIRECT", action: `${base}/instagram/connect` } } satisfies Pick<
            ChannelOffer["connect"],
            "INSTAGRAM"
          >)
        : {}),
      // WhatsApp is Embedded Signup (ADR-015): Meta hands the result to our page through their SDK, so
      // the route answers JSON and something in the browser drives it.
      ...(whatsAppSignupConfigured()
        ? ({
            WHATSAPP: {
              kind: "EMBEDDED",
              connectPath: `${base}/whatsapp/connect`,
              completePath: `${base}/whatsapp/complete`,
            },
          } satisfies Pick<ChannelOffer["connect"], "WHATSAPP">)
        : {}),
    },
  };
}
