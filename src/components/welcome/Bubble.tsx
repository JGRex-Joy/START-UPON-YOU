import { useEffect, useRef, type ReactNode } from 'react';
import { useTypewriter } from './typewriter';

/**
 * The one speech bubble used everywhere Nyan Cat talks: the welcome, the companion greeting and every tour step.
 * The full text is always in the DOM for assistive technology; only the visible copy is typed out.
 */
export function Bubble({ text, tail = 'up', instant = false, speed, className = '', onDone, children, testId }: {
  text: string;
  tail?: 'up' | 'down' | 'none';
  instant?: boolean;
  speed?: number;
  className?: string;
  onDone?: () => void;
  children?: ReactNode;
  testId?: string;
}) {
  const { shown, done } = useTypewriter(text, { speed, instant });
  const fired = useRef('');
  useEffect(() => {
    if (done && fired.current !== text) { fired.current = text; onDone?.(); }
  }, [done, text, onDone]);
  return (
    <div className={`bubble ${tail === 'none' ? '' : `bubble--${tail}`} ${className}`} data-testid={testId}>
      <p className="sr-only">{text}</p>
      <p className="bubble__text" aria-hidden="true">
        {shown}
        {!done && <span className="bubble__caret" />}
      </p>
      {children && <div className="bubble__actions">{children}</div>}
    </div>
  );
}
