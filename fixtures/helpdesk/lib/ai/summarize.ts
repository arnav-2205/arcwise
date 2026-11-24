import OpenAI from 'openai';
import type { Message } from './draft';

const openai = new OpenAI();

export async function summarizeThread(allMessages: Message[]) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 300,
    messages: [
      { role: 'system', content: 'Summarise this support conversation in three short bullet points for the next agent.' },
      { role: 'user', content: JSON.stringify(allMessages) },
    ],
  });
  return res.choices[0].message.content ?? '';
}
