import type { ReactNode } from 'react';
import { GLOSSARY } from '../../utils/glossary';

/** Inline scientific term with an accessible tooltip. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: ReactNode }) {
  const tip = GLOSSARY[k];
  if (!tip) return <>{children}</>;
  return (
    <span className="term" tabIndex={0} role="note" aria-label={`${String(children)}: ${tip}`} data-tip={tip}>
      {children}
    </span>
  );
}
