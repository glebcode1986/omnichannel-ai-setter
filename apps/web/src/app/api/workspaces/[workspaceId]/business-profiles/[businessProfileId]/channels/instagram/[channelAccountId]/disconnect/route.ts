import { getInstagramRouteDependencies } from "../../../../../../../../../../server/instagram";
import { createInstagramDisconnectHandler } from "../../../../../../../../../../server/instagram-routes";

export const dynamic = "force-dynamic";

export const POST = createInstagramDisconnectHandler(getInstagramRouteDependencies());
