import { openai } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { titleFor } from '../../../lib/title';

const SYSTEM = 'You are a concise assistant for the Acme docs. Answer using the docs only. If unsure, say so.';

export async function POST(req: Request) {
  const { messages, chatId } = await req.json();
  if (messages.length === 1) titleFor(chatId, messages[0].content);
  const result = streamText({
    model: openai('gpt-4o'),
    system: SYSTEM,
    messages,
  });
  return result.toDataStreamResponse();
}
