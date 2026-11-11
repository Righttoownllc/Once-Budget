import { useEffect, useRef, useState } from 'preact/hooks';
import { fmt } from '../budget.js';

// Money that rolls to its new value instead of jumping, and briefly glows green (up) or red (down).
// Skipped when the device asks for reduced motion.
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const ease = t => 1 - Math.pow(1 - t, 3);

export function Roll({ value, format = fmt, ms = 650, class: cls = '', ...rest }) {
  const [shown, setShown] = useState(value);
  const [dir, setDir] = useState('');
  const from = useRef(value), raf = useRef(0), first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; from.current = value; return; }
    const start = from.current;
    if (start === value) return;
    cancelAnimationFrame(raf.current);
    if (reduced()) { setShown(value); from.current = value; return; }
    setDir(value > start ? 'up' : 'down');
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ms);
      const v = Math.round(start + (value - start) * ease(t));
      from.current = v; setShown(v);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else { from.current = value; setTimeout(() => setDir(''), 350); }
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value]);
  return <span class={(cls + ' roll ' + (dir ? 'roll-' + dir : '')).trim()} {...rest}>{format(shown)}</span>;
}
