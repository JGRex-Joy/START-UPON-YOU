import { CHALLENGE_TARGETS } from '../../services/targets';
import type { ChallengeTarget } from '../../types';

interface Props {
  activeId: string | null;
  onSelect: (t: ChallengeTarget) => void;
  disabled?: boolean;
}

export function TargetSelector({ activeId, onSelect, disabled }: Props) {
  return (
    <ul className="targets" aria-label="Challenge targets">
      {CHALLENGE_TARGETS.map((t) => (
        <li key={t.id}>
          <button className={`target ${activeId === t.id ? 'is-active' : ''}`} onClick={() => onSelect(t)} disabled={disabled} aria-pressed={activeId === t.id}>
            <span className="target__name">{t.name}</span>
            <span className="target__kind">{t.kind}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
