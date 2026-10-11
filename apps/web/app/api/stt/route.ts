import { handleStt } from "./stt";

export async function POST(req: Request): Promise<Response> {
  return handleStt(req);
}
