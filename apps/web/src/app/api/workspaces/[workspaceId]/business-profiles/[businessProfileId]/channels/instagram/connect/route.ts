import { getInstagramRouteDependencies } from "../../../../../../../../../server/instagram";
import { createInstagramConnectHandler } from "../../../../../../../../../server/instagram-routes";

export const dynamic = "force-dynamic";

export const POST = createInstagramConnectHandler(getInstagramRouteDependencies());
