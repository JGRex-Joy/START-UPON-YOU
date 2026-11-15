import { useState } from 'react';
import { useStore } from '../app/store';
import type { Route } from '../app/router';
import { CHALLENGE_TARGETS, FOCUS_LABEL } from '../services/targets';
import { SkyContext } from '../components/sky/SkyContext';
import { deleteEntry, loadJournal, saveEntry, type JournalEntry } from '../services/journal';

const TOOLS = ['Image', 'Compare', 'Spectral', 'Sky context', 'Source detection (prototype)', 'Image subtraction (prototype)', 'Cross-epoch tracking (prototype)'];

/** Missions: the five challenge targets as community investigations of this project (not official NASA missions). */
export function MissionsPage({ go }: { go: (r: Route) => void }) {
  const { actions } = useStore();
  const done = new Set(loadJournal().map((e) => e.target));
  return (
    <div className="research">
      <header className="research__head">
        <p className="eyebrow">Missions</p>
        <h1>Pick an investigation</h1>
        <p className="dim">Five community investigations built on public SPHEREx data. Each one walks the same path: explore the target, optionally analyse what you see, then submit your findings to the Research Journal. These are citizen-science exercises of this project, not official NASA missions.</p>
      </header>
      <div className="missions">
        {CHALLENGE_TARGETS.map((t) => (
          <article key={t.id} className={`mission mission--${t.focus}`}>
            <span className="mission__status">{done.has(t.name) ? '✓ Submitted' : 'Open'}</span>
            <p className="mission__focus">{FOCUS_LABEL[t.focus]}</p>
            <h2>{t.focus === 'motion' ? `Is ${t.name} moving?` : `How does ${t.name} change?`}</h2>
            <p className="mission__kind">{t.kind}</p>
            <p className="dim">{t.focus === 'motion'
              ? 'Compare observations taken at different times and look for a shift in position against the background stars.'
              : 'Compare observations taken at different times and look for changes in brightness.'}</p>
            <button className="btn btn--primary" onClick={() => { void actions.search({ ra: t.ra, dec: t.dec }, t.name, t); go('explorer'); }}>Start mission</button>
          </article>
        ))}
      </div>
    </div>
  );
}

/** Observatory Submission: document a finished investigation. Prefilled only with facts the application already holds. */
export function SubmissionPage({ go }: { go: (r: Route) => void }) {
  const { state } = useStore();
  const t = state.target;
  const ds = state.dataset;
  const auto = [
    ds ? `Data source: ${ds.origin === 'spherex-live' ? 'SPHEREx archive' : ds.origin === 'demo' ? 'synthetic demo data (not an observation)' : 'user FITS file'}` : 'No data was loaded in this session.',
    ds ? `Observations loaded: ${ds.epochs.length}` : '',
    ds?.cube ? 'Spectral cube loaded.' : '',
    // Analysis results are carried over only if the user actually ran Analysis; nothing is required or invented.
    ...Object.entries(state.detection).map(([id, r]) => `Source detection (prototype) on ${ds?.epochs.find((e) => e.id === id)?.label ?? id}: ${r.candidates.length} unverified candidate(s).`),
  ].filter(Boolean).join('\n');
  const [f, setF] = useState({ title: '', question: '', findings: '', conclusion: '', evidence: auto });
  const [tools, setTools] = useState<string[]>([]);
  const [saved, setSaved] = useState<JournalEntry | null>(null);
  const [err, setErr] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ready = f.title.trim() && f.question.trim() && f.findings.trim() && f.conclusion.trim();

  if (saved) {
    return (
      <div className="research research--narrow">
        <div className="submitted">
          <p className="submitted__star">✦</p>
          <h1>Investigation complete</h1>
          <p>“{saved.title}” is now in your Research Journal. You explored and documented a real research question — that is the heart of the scientific loop.</p>
          <div className="research__row">
            <button className="btn btn--primary" onClick={() => go('journal')}>Open Research Journal</button>
            <button className="btn" onClick={() => go('missions')}>Choose another mission</button>
          </div>
        </div>
      </div>
    );
  }
  const submit = () => {
    try {
      const entry = saveEntry({
        ...f, target: t?.name ?? 'No target selected', tools,
        coordinates: t ? `RA ${t.pos.ra.toFixed(5)}°, Dec ${t.pos.dec.toFixed(5)}°` : '—',
      });
      setSaved(entry);
      window.dispatchEvent(new CustomEvent('suy:submitted'));
    } catch { setErr('Could not save: browser storage is unavailable. Nothing was submitted.'); }
  };
  const filled = [f.title, f.question, f.findings, f.conclusion].filter((x) => x.trim()).length;
  return (
    <div className="research station">
      <header className="research__head station__head">
        <p className="eyebrow">Observatory Submission · Research log</p>
        <h1>Log your investigation</h1>
        <p className="dim">Analysis is optional: you can submit your findings straight from the Explorer. <button className="linkbtn" onClick={() => go('analysis')}>Open Analysis (optional)</button> · <button className="linkbtn" onClick={() => go('explorer')}>Back to Explorer</button></p>
      </header>

      <aside className="station__left" aria-label="Sky and evidence">
        <div className="pxpanel">
          <p className="pxpanel__title"><i className="led" /> SKY VIEW</p>
          <div className="station__sky">
            {t ? <SkyContext position={t.pos} fovDeg={0.6} compact minimalChrome targetPos={t.pos} />
               : <p className="dim station__nosky">No target selected.<br /><button className="linkbtn" onClick={() => go('missions')}>Pick a mission first</button></p>}
          </div>
          <p className="station__cap">Context survey imagery (not SPHEREx)</p>
        </div>
        <div className="pxpanel">
          <p className="pxpanel__title"><i className="led led--pink" /> TARGET</p>
          <dl className="readout">
            <dt>OBJECT</dt><dd>{t?.name ?? '—'}</dd>
            <dt>RA</dt><dd className="mono">{t ? `${t.pos.ra.toFixed(5)}°` : '—'}</dd>
            <dt>DEC</dt><dd className="mono">{t ? `${t.pos.dec.toFixed(5)}°` : '—'}</dd>
            <dt>DATA</dt><dd>{ds ? (ds.origin === 'spherex-live' ? 'SPHEREx archive' : ds.origin === 'demo' ? 'Synthetic demo' : 'User FITS file') : 'none loaded'}</dd>
            <dt>OBS</dt><dd className="mono">{ds ? ds.epochs.length : 0}</dd>
            <dt>CUBE</dt><dd>{ds?.cube ? 'loaded' : '—'}</dd>
          </dl>
        </div>
        <div className="pxpanel">
          <p className="pxpanel__title"><i className="led led--lime" /> LOG STATUS</p>
          <div className="meter" aria-label={`${filled} of 4 required fields`}>{[0, 1, 2, 3].map((i) => <i key={i} className={i < filled ? 'is-on' : ''} />)}</div>
          <p className="station__cap">{filled}/4 required entries written</p>
        </div>
      </aside>

      <section className="station__right pxpanel" aria-label="Research log">
        <p className="pxpanel__title"><i className="led led--lime" /> RESEARCH LOG</p>
        <div className="subform">
          <label><span>01 · Title</span><input value={f.title} onChange={set('title')} placeholder="e.g. Looking for the motion of Barnard's Star" /></label>
          <label><span>02 · Research question</span><textarea rows={2} value={f.question} onChange={set('question')} placeholder="What did you want to find out?" /></label>
          <label><span>03 · Observations and findings</span><textarea rows={4} value={f.findings} onChange={set('findings')} placeholder="What did you actually see in the data?" /></label>
          <fieldset><legend>04 · Tools and methods</legend>
            <div className="subform__tools">
              {TOOLS.map((x) => (
                <label key={x} className={`chip ${tools.includes(x) ? 'is-active' : ''}`}>
                  <input type="checkbox" hidden checked={tools.includes(x)} onChange={() => setTools(tools.includes(x) ? tools.filter((y) => y !== x) : [...tools, x])} />{x}
                </label>
              ))}
            </div>
          </fieldset>
          <label><span>05 · Interpretation / conclusion</span><textarea rows={3} value={f.conclusion} onChange={set('conclusion')} placeholder="What do you think it means? How sure are you?" /></label>
          <label><span>06 · Supporting evidence / notes</span><textarea rows={3} value={f.evidence} onChange={set('evidence')} /></label>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn btn--primary subform__submit" disabled={!ready} onClick={submit} data-testid="submit-journal">▶ SUBMIT TO RESEARCH JOURNAL</button>
          {!ready && <p className="dim">Entries 01, 02, 03 and 05 are required.</p>}
        </div>
      </section>
    </div>
  );
}

export function JournalPage({ go }: { go: (r: Route) => void }) {
  const [entries, setEntries] = useState(loadJournal);
  return (
    <div className="research research--narrow">
      <header className="research__head">
        <p className="eyebrow">Research Journal</p>
        <h1>Your investigations</h1>
        <p className="dim">Saved in this browser. {entries.length === 0 ? 'Nothing submitted yet.' : `${entries.length} submitted.`}</p>
      </header>
      {entries.length === 0 && <button className="btn btn--primary" onClick={() => go('missions')}>Start with a mission</button>}
      {entries.map((e) => (
        <article key={e.id} className="entry">
          <p className="eyebrow">{new Date(e.submittedAt).toLocaleString()} · {e.target}</p>
          <h2>{e.title}</h2>
          <p className="mono dim">{e.coordinates}</p>
          <dl>
            <dt>Question</dt><dd>{e.question}</dd>
            <dt>Findings</dt><dd>{e.findings}</dd>
            {e.tools.length > 0 && <><dt>Tools</dt><dd>{e.tools.join(' · ')}</dd></>}
            <dt>Conclusion</dt><dd>{e.conclusion}</dd>
            {e.evidence && <><dt>Evidence / notes</dt><dd className="entry__pre">{e.evidence}</dd></>}
          </dl>
          <button className="linkbtn" onClick={() => { deleteEntry(e.id); setEntries(loadJournal()); }}>Delete entry</button>
        </article>
      ))}
    </div>
  );
}
