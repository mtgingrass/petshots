// First-run tour: four swipeable cards ending in the push-notification ask.
// Shown ONCE per device (localStorage), phones + native only.
//
// The last card is the whole point: iOS gives exactly one shot at the system
// notification dialog, so our own screen makes the case FIRST and the button
// (a user gesture, which iOS requires) triggers the real prompt. Declining
// here costs nothing — the Settings toggle remains the recovery path.
import { useRef, useState } from 'react';
import { enablePush, pushSupported, iosNeedsInstall } from '../push';
import { hapticTap, hapticSuccess } from '../native';

export const TOUR_DONE_KEY = 'petshots.tourDone';

const CARDS = [
  {
    icon: '🐾',
    title: 'Welcome to Petshots',
    body: "Every vaccine record, one tap away — no more digging through email while the front desk waits.",
  },
  {
    icon: '💉',
    title: 'Show records at the door',
    body: "Press and hold a pet's photo to present their records full screen — rabies certificate first, the way check-in desks ask for it.",
  },
  {
    icon: '📸',
    title: 'Scan, don’t type',
    body: 'Photograph a vet certificate and the details fill themselves in — dates, vaccines, even the vet’s info.',
  },
  {
    icon: '🔔',
    title: 'Never miss a shot',
    body: 'Petshots reminds you before vaccines lapse and when meds are due. Turn on notifications so the reminder finds you in time.',
  },
];

export function OnboardingTour({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushResult, setPushResult] = useState<'on' | 'denied' | null>(null);
  const slidesRef = useRef<HTMLDivElement>(null);

  const last = index === CARDS.length - 1;
  const supported = pushSupported();
  const needsInstall = iosNeedsInstall();

  function finish() {
    localStorage.setItem(TOUR_DONE_KEY, '1');
    onDone();
  }

  function goTo(i: number) {
    const el = slidesRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }

  function handleScroll() {
    const el = slidesRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== index) setIndex(Math.max(0, Math.min(CARDS.length - 1, i)));
  }

  async function handleEnablePush() {
    setPushBusy(true);
    try {
      await enablePush();
      hapticSuccess();
      setPushResult('on');
    } catch {
      // Denied (or failed) — Settings keeps the toggle for later.
      setPushResult('denied');
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <div className="tour" role="dialog" aria-label="Welcome tour">
      <button
        type="button"
        className="tour__skip btn btn--link"
        onClick={() => { hapticTap(); finish(); }}
      >
        Skip
      </button>

      <div className="tour__slides" ref={slidesRef} onScroll={handleScroll}>
        {CARDS.map((card, i) => (
          <div className="tour__slide" key={i}>
            <span className="tour__icon" aria-hidden="true">{card.icon}</span>
            <h2 className="tour__title">{card.title}</h2>
            <p className="tour__body">{card.body}</p>

            {i === CARDS.length - 1 && (
              <div className="tour__push">
                {pushResult === 'on' ? (
                  <p className="tour__push-note" role="status">
                    Notifications are on. 🎉
                  </p>
                ) : pushResult === 'denied' ? (
                  <p className="tour__push-note subtle" role="status">
                    No problem — you can turn them on anytime in Settings.
                  </p>
                ) : supported ? (
                  <button
                    type="button"
                    className="btn btn--primary btn--lg"
                    disabled={pushBusy}
                    onClick={() => void handleEnablePush()}
                  >
                    {pushBusy ? 'One moment…' : 'Turn on notifications'}
                  </button>
                ) : needsInstall ? (
                  <p className="tour__push-note subtle">
                    Add Petshots to your Home Screen (Share → Add to Home
                    Screen) to get notifications — reminders arrive by email
                    either way.
                  </p>
                ) : (
                  <p className="tour__push-note subtle">
                    Reminders arrive by email — you're set.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="tour__footer">
        <div className="tour__dots" aria-hidden="true">
          {CARDS.map((_, i) => (
            <span key={i} className={`tour__dot${i === index ? ' tour__dot--active' : ''}`} />
          ))}
        </div>
        {last ? (
          <button
            type="button"
            className="btn tour__next"
            onClick={() => { hapticTap(); finish(); }}
          >
            {pushResult ? 'Done' : supported ? 'Maybe later' : 'Get started'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary tour__next"
            onClick={() => { hapticTap(); goTo(index + 1); }}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
