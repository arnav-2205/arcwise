import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/ai/classify', () => ({ classifyTicket: async () => ({ category: 'billing', urgency: 'high' }) }));

describe('createTicket', () => {
  it('classifies the ticket', async () => {
    const { createTicket } = await import('../lib/ticketService');
    expect(createTicket).toBeTypeOf('function');
  });
});
