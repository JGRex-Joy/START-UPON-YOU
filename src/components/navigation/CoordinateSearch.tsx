import { useState, type FormEvent } from 'react';
import { parsePosition, formatDeg, type RaUnit } from '../../utils/coords';
import type { SkyPosition } from '../../types';

interface Props {
  initial?: SkyPosition | null;
  onSubmit: (pos: SkyPosition) => void;
  busy?: boolean;
  submitLabel?: string;
  size?: 'large' | 'compact';
  idPrefix: string;
  /** Offer RA in hours as an alternative to degrees (plain numbers are then read as hours). */
  allowHours?: boolean;
}

/** RA/Dec entry in decimal degrees or sexagesimal, with inline range validation. */
export function CoordinateSearch({ initial, onSubmit, busy, submitLabel = 'Explore', size = 'compact', idPrefix, allowHours = false }: Props) {
  const [ra, setRa] = useState(initial ? formatDeg(initial.ra) : '');
  const [dec, setDec] = useState(initial ? formatDeg(initial.dec) : '');
  const [unit, setUnit] = useState<RaUnit>('deg');
  const [errors, setErrors] = useState<{ ra?: string; dec?: string }>({});

  const validate = (): SkyPosition | null => {
    const res = parsePosition(ra, dec, unit);
    if (res.ok) { setErrors({}); return res.value; }
    // Report each field separately so the message sits under the right input.
    const e: { ra?: string; dec?: string } = {};
    const r = parsePosition(ra, '0', unit);
    const d = parsePosition('0', dec);
    if (!r.ok) e.ra = r.error.replace(/^RA: /, '');
    if (!d.ok) e.dec = d.error.replace(/^Dec: /, '');
    setErrors(e);
    return null;
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    const p = validate();
    if (p) onSubmit(p);
  };

  return (
    <form className={`coord coord--${size}`} onSubmit={submit} noValidate>
      <div className="coord__field">
        <label htmlFor={`${idPrefix}-ra`}>Right ascension</label>
        {allowHours && (
          <div className="seg coord__unit" role="radiogroup" aria-label="RA unit">
            <button type="button" role="radio" aria-checked={unit === 'deg'} className={unit === 'deg' ? 'is-active' : ''} onClick={() => setUnit('deg')}>degrees</button>
            <button type="button" role="radio" aria-checked={unit === 'hours'} className={unit === 'hours' ? 'is-active' : ''} onClick={() => setUnit('hours')}>hours</button>
          </div>
        )}
        <input
          id={`${idPrefix}-ra`} className="mono" inputMode="text" autoComplete="off" spellCheck={false}
          placeholder={unit === 'hours' ? '8.91967  or  08h55m10.8s' : '133.79513  or  08h55m10.8s'}
          value={ra} onChange={(e) => setRa(e.target.value)} aria-invalid={!!errors.ra} aria-describedby={errors.ra ? `${idPrefix}-ra-err` : undefined}
        />
        <span className="coord__hint">{unit === 'hours' ? '0 – 24 h (decimal) or hms' : '0 – 360° (decimal) or hms'}</span>
        {errors.ra && <span id={`${idPrefix}-ra-err`} className="coord__error" role="alert">{errors.ra}</span>}
      </div>
      <div className="coord__field">
        <label htmlFor={`${idPrefix}-dec`}>Declination</label>
        <input
          id={`${idPrefix}-dec`} className="mono" inputMode="text" autoComplete="off" spellCheck={false}
          placeholder="-7.24515  or  -07°14′42.5″"
          value={dec} onChange={(e) => setDec(e.target.value)} aria-invalid={!!errors.dec} aria-describedby={errors.dec ? `${idPrefix}-dec-err` : undefined}
        />
        <span className="coord__hint">−90 – +90° (decimal) or dms</span>
        {errors.dec && <span id={`${idPrefix}-dec-err`} className="coord__error" role="alert">{errors.dec}</span>}
      </div>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Searching…' : submitLabel}</button>
    </form>
  );
}
