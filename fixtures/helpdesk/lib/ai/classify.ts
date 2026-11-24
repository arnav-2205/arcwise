import OpenAI from 'openai';

const openai = new OpenAI();

export const CLASSIFY_PROMPT = `You are a support ticket triage assistant for Acme Helpdesk.
Classify the customer ticket into exactly one category: billing, access, bug, question or feedback.
Also rate the urgency as low, normal or high.
Respond with only JSON in this format: {"category": "...", "urgency": "..."}.
Never include any explanation outside the JSON.`;

export async function classifyTicket(text: string) {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 20,
    messages: [
      { role: 'system', content: CLASSIFY_PROMPT },
      { role: 'user', content: text },
    ],
  });
  const raw = res.choices[0].message.content ?? '{}';
  const out = JSON.parse(raw);
  return { category: out.category as string, urgency: out.urgency as string };
}
