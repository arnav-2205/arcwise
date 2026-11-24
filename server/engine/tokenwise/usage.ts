// Usage import: OpenAI / Anthropic usage CSV exports, and Langfuse, Helicone or OpenTelemetry GenAI JSON.
// Rows are aggregated per model; volumes and average tokens replace estimates for call sites on that model.

export interface ModelUsage { model: string; requests: number; inputTokens: number; outputTokens: number }

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x !== '')) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map(h => h.trim().toLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

const pick = (o: Record<string, unknown>, names: string[]): unknown => {
  for (const n of names) {
    if (o[n] !== undefined && o[n] !== '') return o[n]; // flat keys such as "gen_ai.request.model"
    const v = n.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
};
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

const MODEL = ['model', 'model_name', 'model_id', 'request_model', 'gen_ai.request.model', 'attributes.gen_ai.request.model', 'request.model', 'body.model'];
const IN = ['input_tokens', 'prompt_tokens', 'n_context_tokens_total', 'usage_input_tokens', 'input tokens', 'usage.input', 'usage.input_tokens', 'usage.prompt_tokens', 'gen_ai.usage.input_tokens', 'attributes.gen_ai.usage.input_tokens', 'prompt_tokens_used'];
const OUT = ['output_tokens', 'completion_tokens', 'n_generated_tokens_total', 'usage_output_tokens', 'output tokens', 'usage.output', 'usage.output_tokens', 'usage.completion_tokens', 'gen_ai.usage.output_tokens', 'attributes.gen_ai.usage.output_tokens', 'completion_tokens_used'];
const REQ = ['num_model_requests', 'requests', 'request_count', 'n_requests', 'count'];

export function parseUsage(name: string, text: string): { format: string; models: ModelUsage[]; rows: number } {
  let records: Record<string, unknown>[];
  let format: string;
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    const arr = Array.isArray(data) ? data : data.data ?? data.observations ?? data.spans ?? data.resourceSpans?.flatMap((r: { scopeSpans?: { spans?: unknown[] }[] }) => r.scopeSpans?.flatMap(s => s.spans ?? []) ?? []) ?? [];
    records = (arr as Record<string, unknown>[]).map(r => {
      // OpenTelemetry attributes as [{key, value:{stringValue|intValue}}]
      if (Array.isArray(r.attributes)) {
        const attrs: Record<string, unknown> = {};
        for (const a of r.attributes as { key: string; value: Record<string, unknown> }[]) attrs[a.key] = Object.values(a.value ?? {})[0];
        return { ...r, ...attrs };
      }
      return r;
    });
    format = /otel|telemetry/i.test(name) || records.some(r => 'gen_ai.request.model' in r) ? 'OpenTelemetry GenAI' : /helicone/i.test(name) ? 'Helicone' : 'Langfuse / JSON';
  } else {
    records = parseCsv(text);
    format = records.some(r => 'n_context_tokens_total' in r || 'num_model_requests' in r) ? 'OpenAI usage CSV' : 'Anthropic / usage CSV';
  }
  const by = new Map<string, ModelUsage>();
  for (const r of records) {
    const model = String(pick(r, MODEL) ?? '').trim();
    if (!model) continue;
    const u = by.get(model) ?? { model, requests: 0, inputTokens: 0, outputTokens: 0 };
    const reqs = num(pick(r, REQ)) || 1;
    u.requests += reqs; u.inputTokens += num(pick(r, IN)); u.outputTokens += num(pick(r, OUT));
    by.set(model, u);
  }
  return { format, models: [...by.values()], rows: records.length };
}
