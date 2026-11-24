// Shared types between the Express engine and the Next UI.

export type Layer = 'interface' | 'service' | 'ai' | 'data' | 'config';
export type SideEffect = 'llm' | 'network' | 'database' | 'filesystem';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Confidence = 'high' | 'medium' | 'low';
export type Quality = 'proven' | 'testing' | 'unvalidated' | 'atrisk';
export type FeedbackStatus = 'accepted' | 'false_positive' | 'fixed';

export interface FunctionInfo {
  name: string;
  lines: [number, number];
  async: boolean;
  exported: boolean;
}

export interface GraphNode {
  id: string; // repo-relative file path
  name: string;
  file: string;
  language: string;
  layer: Layer;
  loc: number;
  functions: FunctionInfo[];
  sideEffects: SideEffect[];
  summary: string;
  plain: string;
  summarySource: 'llm' | 'structure';
  /** Content fingerprint, used for incremental re-analysis. */
  hash: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'imports';
}

export interface Flow {
  name: string;
  description: string;
  steps: string[]; // node ids, in order
}

export interface Diff {
  del: string[];
  add: string[];
}

export interface Finding {
  id: string;
  rule: string;
  title: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  source: 'rule' | 'llm';
  file: string;
  lines: [number, number];
  evidence: string[];
  why: string;
  fix?: Diff;
  note?: string;
}

export interface PromptInfo {
  text: string;
  tokens: number;
  tokensEstimated: boolean;
  source: string; // e.g. "inline", "constant SYSTEM_PROMPT", "file prompts/support.md"
  static: boolean;
}

export interface CallSite {
  id: string; // path#function
  file: string;
  fn: string;
  lines: [number, number];
  provider: string;
  api: string;
  model: string;
  modelResolved: 'literal' | 'constant' | 'env-default' | 'dynamic';
  inLoop: boolean;
  maxTokens: number | null;
  streaming: boolean;
  tools: boolean;
  hasTimeout: boolean;
  hasRetry: boolean;
  systemPrompt: PromptInfo | null;
  inputTokens: number;
  outputTokens: number;
  outputTokensSource: 'max-tokens' | 'task-guess' | 'usage';
  callsPerMonth: number;
  callsSource: 'default' | 'user' | 'usage';
  /** USD per month at the current volume and token counts; null when the model has no known price. */
  monthlyCostUsd?: number | null;
  flags: string[];
  quality: Quality;
  /** Raw argument text of the call, kept so analyzers can re-run when volumes change. */
  argsText?: string;
}

export interface Recommendation {
  id: string;
  siteId: string;
  kind: 'model-fit' | 'prompt-caching' | 'response-caching' | 'redundant' | 'batching' | 'prompt-bloat' | 'output-cap' | 'context-trimming';
  title: string;
  detail: string;
  saving: { low: number; high: number } | null; // USD per month; null = no estimate possible
  qualityRisk: 'low' | 'medium' | 'high';
  status: Quality;
  change: Diff;
  candidate?: { model?: string; systemPrompt?: string };
  replayable: boolean;
  validationId?: string;
}

export interface Stage {
  key: 'clone' | 'parse' | 'map' | 'explain' | 'risk' | 'cost' | 'assemble';
  label: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  count?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ValidationReport {
  id: string;
  recId: string;
  siteId: string;
  createdAt: string;
  inputsSource: 'uploaded' | 'synthetic';
  n: number;
  scoring: string;
  baseline: { model: string; costPerCall: number };
  candidate: { model: string; costPerCall: number };
  meanDiff: number;
  ci: [number, number];
  delta: number;
  passed: boolean;
  examples: { input: string; baseline: string; candidate: string; score: number }[];
  errors: number;
  monthlySaving: number;
}

export interface LedgerEntry {
  id: string;
  recId: string;
  siteId: string;
  title: string;
  monthlySaving: number;
  validationId: string;
  createdAt: string;
}

export interface AnalysisSummary {
  id: string;
  repo: string;
  branch: string;
  commit: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
}

export interface Analysis extends AnalysisSummary {
  /** The user who started it. Every read and write is checked against this. */
  ownerId: string;
  source: 'github' | 'fixture';
  error?: string;
  stages: Stage[];
  overview: {
    description: string;
    languages: { name: string; files: number }[];
    frameworks: string[];
    fileCount: number;
    loc: number;
  } | null;
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; flows: Flow[] } | null;
  findings: Finding[];
  feedback: Record<string, FeedbackStatus>;
  callSites: CallSite[];
  /** Every system prompt found in the code, including ones no call site could be linked to. */
  prompts?: { id: string; name: string; file: string; line: number; text: string; tokens: number; usedBy: string | null }[];
  recommendations: Recommendation[];
  validations: ValidationReport[];
  ledger: LedgerEntry[];
  usageImports: { name: string; format: string; rows: number; importedAt: string }[];
  pricingAsOf: string;
  llm: { used: boolean; estimatedTokens: number; inputTokens: number; outputTokens: number; costUsd: number | null };
  changes: { since: string; added: string[]; removed: string[]; modified: string[] } | null;
  warnings: string[];
}

export interface Settings {
  currency: 'INR' | 'USD';
  fxRate: number; // INR per USD
  fxAsOf: string;
  defaultDelta: number;
}
