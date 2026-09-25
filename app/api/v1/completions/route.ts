import { handlePublicCall, parseCompletion } from "@/lib/publicApi";
export const dynamic = "force-dynamic";
/** POST /api/v1/completions — ver /docs. */
export const POST = (req: Request) => handlePublicCall(req, parseCompletion);
