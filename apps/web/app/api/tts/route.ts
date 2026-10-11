import { handleTts } from "./tts";

export async function POST(req: Request): Promise<Response> {
  return handleTts(req);
}
