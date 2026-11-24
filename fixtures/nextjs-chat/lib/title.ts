import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { saveTitle } from './store';

export async function titleFor(chatId: string, firstMessage: string) {
  const { text } = await generateText({
    model: openai('gpt-4o'),
    system: 'Write a short title for this chat. Reply with only the title, at most six words.',
    prompt: firstMessage,
    maxTokens: 20,
  });
  await saveTitle(chatId, text);
}
