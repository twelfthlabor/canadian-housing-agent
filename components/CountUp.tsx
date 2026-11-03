"use client";

import { useEffect, useRef, useState } from "react";

/** Eases a number from its previous value to `target`; reduced-motion users get the final value at once. */
export function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const shown = useRef(target);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      shown.current = target;
      setValue(target);
      return;
    }
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (reduceMotion || shown.current === target) {
      shown.current = target;
      setValue(target);
      return;
    }

    const origin = shown.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      shown.current = origin + (target - origin) * eased;
      setValue(shown.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
      else shown.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

/** Animated number, rendered as text so screen readers get the final value. */
export default function CountUp({ value, format = (n: number) => Math.round(n).toLocaleString("en-CA") }: { value: number; format?: (n: number) => string }) {
  const animated = useCountUp(value);
  return <span className="count-up" aria-label={format(value)}>{format(animated)}</span>;
}
