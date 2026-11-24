// Known-vulnerable dependencies via the OSV API. Only package names and versions are sent, never code.
import type { Finding, Severity } from '../../../lib/types';
import { stableId } from './rules';

interface Dep { name: string; version: string; ecosystem: 'npm' | 'PyPI'; file: string; line: number }

export function parseDeps(manifests: { path: string; text: string }[]): Dep[] {
  const deps: Dep[] = [];
  for (const m of manifests) {
    const lines = m.text.split('\n');
    if (m.path.endsWith('package-lock.json')) {
      try {
        const j = JSON.parse(m.text);
        const pkgs: Record<string, { version?: string }> = j.packages ?? {};
        for (const [key, v] of Object.entries(pkgs)) {
          if (!key || !v.version) continue;
          const name = key.replace(/^.*node_modules\//, '');
          const line = lines.findIndex(l => l.includes(`"${key}"`)) + 1;
          deps.push({ name, version: v.version, ecosystem: 'npm', file: m.path, line: line || 1 });
        }
        if (!Object.keys(pkgs).length && j.dependencies) for (const [name, v] of Object.entries<{ version: string }>(j.dependencies)) {
          const line = lines.findIndex(l => l.includes(`"${name}"`)) + 1;
          deps.push({ name, version: v.version, ecosystem: 'npm', file: m.path, line: line || 1 });
        }
      } catch { /* malformed lockfile */ }
    } else if (m.path.endsWith('requirements.txt')) {
      lines.forEach((l, i) => {
        const r = /^\s*([A-Za-z0-9_.-]+)\s*==\s*([A-Za-z0-9_.+-]+)/.exec(l);
        if (r) deps.push({ name: r[1], version: r[2], ecosystem: 'PyPI', file: m.path, line: i + 1 });
      });
    }
  }
  // one entry per name@version
  const seen = new Set<string>();
  return deps.filter(d => { const k = `${d.ecosystem}:${d.name}@${d.version}`; return seen.has(k) ? false : (seen.add(k), true); });
}

const SEV: Record<string, Severity> = { CRITICAL: 'critical', HIGH: 'high', MODERATE: 'medium', MEDIUM: 'medium', LOW: 'low' };

export async function osvFindings(manifests: { path: string; text: string }[], fetchImpl: typeof fetch = fetch): Promise<{ findings: Finding[]; warning?: string }> {
  const deps = parseDeps(manifests).slice(0, 2000);
  if (!deps.length) return { findings: [] };
  const findings: Finding[] = [];
  try {
    for (let i = 0; i < deps.length; i += 500) {
      const chunk = deps.slice(i, i + 500);
      const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ queries: chunk.map(d => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) }),
      });
      if (!res.ok) throw new Error(`OSV answered ${res.status}`);
      const data = await res.json() as { results: { vulns?: { id: string }[] }[] };
      data.results.forEach((r, j) => {
        if (!r.vulns?.length || findings.length >= 40) return;
        const d = chunk[j];
        findings.push({
          id: stableId('vulnerable-dependency', d.file, `${d.name}@${d.version}`), rule: 'vulnerable-dependency', source: 'rule',
          title: `${d.name}@${d.version} has ${r.vulns.length} known ${r.vulns.length === 1 ? 'vulnerability' : 'vulnerabilities'}`,
          severity: 'medium', confidence: 'high', category: 'Dependencies', file: d.file, lines: [d.line, d.line], evidence: [],
          why: `OSV lists: ${r.vulns.slice(0, 5).map(v => v.id).join(', ')}${r.vulns.length > 5 ? ' and more' : ''}. Upgrade to a fixed version.`,
        });
      });
    }
    // Severity details for the first findings
    await Promise.all(findings.slice(0, 15).map(async f => {
      const id = /OSV lists: ([^,.\s]+)/.exec(f.why)?.[1];
      if (!id) return;
      try {
        const r = await fetchImpl(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) });
        const v = await r.json() as { summary?: string; database_specific?: { severity?: string } };
        const s = SEV[(v.database_specific?.severity ?? '').toUpperCase()];
        if (s) f.severity = s;
        if (v.summary) f.why = `${v.summary}. ${f.why}`;
      } catch { /* keep defaults */ }
    }));
    return { findings };
  } catch (e) {
    return { findings, warning: `Dependency check skipped: ${(e as Error).message}` };
  }
}
