// The Trends tab and its chart components were removed 2026-07-13 (replaced
// by the Summary tab's daily story). This file keeps only useSwipeStep,
// which the dashboard's overview swipe navigation still uses.
import { useEffect } from 'react';

// Same whole-screen horizontal-swipe gesture as the Daily tab's swipe-back
// history (PetDailyHistory in Dashboard.tsx) — written fresh here rather
// than extracted from that already-working, already-tested code, so this
// change carries zero risk of regressing it. "back" = swipe right (earlier
// period), "forward" = swipe left — same direction convention as Daily.
// Only mount this in ONE active view at a time (conditional rendering, not
// CSS show/hide) — two mounted instances would both fire on a single swipe.
export function useSwipeStep(onStep: (direction: 'back' | 'forward') => void) {
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      start = e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
    };
    const onEnd = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      start = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) onStep(dx > 0 ? 'back' : 'forward');
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  });
}
