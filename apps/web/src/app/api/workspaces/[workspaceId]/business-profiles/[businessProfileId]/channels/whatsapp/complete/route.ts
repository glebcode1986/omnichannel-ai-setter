import { createWhatsAppCompleteHandler } from "../../../../../../../../../server/whatsapp-routes";
import { getWhatsAppRouteDependencies } from "../../../../../../../../../server/whatsapp";

export const dynamic = "force-dynamic";

export const POST = createWhatsAppCompleteHandler(getWhatsAppRouteDependencies());
