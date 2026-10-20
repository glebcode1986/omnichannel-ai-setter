import { createWhatsAppDisconnectHandler } from "../../../../../../../../../../server/whatsapp-routes";
import { getWhatsAppRouteDependencies } from "../../../../../../../../../../server/whatsapp";

export const dynamic = "force-dynamic";

export const POST = createWhatsAppDisconnectHandler(getWhatsAppRouteDependencies());
