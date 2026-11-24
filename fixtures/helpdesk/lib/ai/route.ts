import OpenAI from 'openai';

const openai = new OpenAI();

const ROUTE_PROMPT = `You are a support ticket triage assistant for Acme Helpdesk.
Classify the customer ticket into exactly one team: billing, access, engineering or success.
Respond with only JSON in this format: {"team": "..."}.
Never include any explanation outside the JSON.`;

export async function routeTicket(text: string): Promise<string> {
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 10,
      messages: [
        { role: 'system', content: ROUTE_PROMPT },
        { role: 'user', content: text },
      ],
    });
    return res.choices[0].message.content ?? 'success';
  } catch {
    return 'success';
  }
}
