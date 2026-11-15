/** Research Journal: real persistence in localStorage (there is no backend). */
export interface JournalEntry {
  id: string;
  submittedAt: string;
  title: string;
  target: string;
  coordinates: string;
  question: string;
  findings: string;
  tools: string[];
  conclusion: string;
  evidence: string;
}
const KEY = 'suy.journal.v1';
export function loadJournal(): JournalEntry[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveEntry(e: Omit<JournalEntry, 'id' | 'submittedAt'>): JournalEntry {
  const entry: JournalEntry = { ...e, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, submittedAt: new Date().toISOString() };
  const all = [entry, ...loadJournal()];
  localStorage.setItem(KEY, JSON.stringify(all)); // throws if storage is unavailable: the caller reports it, never fakes success
  return entry;
}
export function deleteEntry(id: string): void {
  try { localStorage.setItem(KEY, JSON.stringify(loadJournal().filter((e) => e.id !== id))); } catch { /* ignore */ }
}
