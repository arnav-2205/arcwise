import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const anthropic = new Anthropic();
const MODEL = process.env.DRAFT_MODEL ?? 'claude-sonnet-4-20250514';

export interface Message { from: 'customer' | 'agent'; body: string }

export async function draftReply(thread: Message[]) {
  const system = readFileSync(path.join(process.cwd(), 'prompts/support.md'), 'utf8');
  const res = await anthropic.messages.create({
    model: MODEL,
    system,
    messages: thread.map(m => ({ role: m.from === 'customer' ? 'user' : 'assistant', content: m.body })),
  });
  return res.content[0].type === 'text' ? res.content[0].text : '';
}
