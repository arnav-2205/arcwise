import { draftReply } from './ai/draft';
import { summarizeThread } from './ai/summarize';
import { getThread } from './db/ticketRepo';

export async function suggestReply(ticketId: string) {
  const thread = await getThread(ticketId);
  const summary = thread.length > 6 ? await summarizeThread(thread) : null;
  const draft = await draftReply(thread);
  return { draft, summary };
}
