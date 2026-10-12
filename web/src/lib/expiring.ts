import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A line of status that goes by itself: it says what just happened, and is not worth keeping on
 * screen until something else replaces it. Every message is its own, so saying the same thing again
 * starts the clock again, and `count` tells it from the last one: a status region that is given a
 * new element for it says it again. `say` never changes, so an effect may depend on it.
 */
export function useExpiring(ms: number): [string | null, (text: string | null) => void, number] {
  const [message, setMessage] = useState<{ text: string; count: number } | null>(null);
  const said = useRef(0);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), ms);
    return () => clearTimeout(timer);
  }, [message, ms]);

  const say = useCallback((text: string | null) => {
    setMessage(text == null ? null : { text, count: ++said.current });
  }, []);
  return [message?.text ?? null, say, message?.count ?? 0];
}
