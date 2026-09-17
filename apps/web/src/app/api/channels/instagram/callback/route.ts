import { getInstagramRouteDependencies } from "../../../../../server/instagram";
import { createInstagramCallbackHandler } from "../../../../../server/instagram-routes";

export const dynamic = "force-dynamic";

export const GET = createInstagramCallbackHandler(getInstagramRouteDependencies());
