// Cloudflare Turnstile widget. Loads the script once, renders the challenge, and
// reports the resulting token up to the parent. The token is single-use, so the
// parent remounts this (via `key`) to get a fresh one after a failed submit.
import { useEffect, useRef } from 'react';
import { config } from '../config';
import { getSavedTheme } from '../utils/theme';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

export function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-running the effect.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let widgetId: string | undefined;

    function render() {
      if (!window.turnstile || !containerRef.current || widgetId) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: config.turnstileSiteKey,
        theme: getSavedTheme(),
        callback: (token: string) => onTokenRef.current(token),
        'error-callback': () => onTokenRef.current(''),
        'expired-callback': () => onTokenRef.current(''),
      });
    }

    if (window.turnstile) {
      render();
    } else {
      let script = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
      if (!script) {
        script = document.createElement('script');
        script.src = SCRIPT_SRC;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener('load', render);
    }

    return () => {
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, []);

  return <div ref={containerRef} />;
}
