import { handlePublicCall, parseImages } from "@/lib/publicApi";
export const dynamic = "force-dynamic";
/** POST /api/v1/images — ver /docs. */
export const POST = (req: Request) => handlePublicCall(req, parseImages);
