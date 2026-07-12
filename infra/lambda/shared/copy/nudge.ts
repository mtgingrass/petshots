/**
 * Feeding/walk nudge copy — the push notification sent by
 * infra/lambda/reminder/index.ts's runDailyNudge() when breakfast/dinner/
 * walk isn't checked off yet. See copy/reminder.ts's header for the deploy
 * recipe; same rule applies here.
 */

export const nudgeCopy = {
  title: (which: 'breakfast' | 'evening') => (which === 'breakfast' ? '🐾 Feeding check' : '🐾 Evening check'),
  body: (missedItems: string[]) => `Still not checked off: ${missedItems.join(', ')}.`,
} as const;

/**
 * Weight staleness push — sent by the main daily reminder scan (not a
 * separate EventBridge nudge rule; see WEIGHTS.STALE_NUDGE_DAYS in
 * config.ts) when a pet's most recent weight entry is a month or more old.
 * Repeats on the same cadence until a fresh weight is logged.
 */
export const weightNudgeCopy = {
  title: '🐾 Weight check-in',
  body: (petNames: string[]) =>
    petNames.length === 1
      ? `It's been a while since you logged ${petNames[0]}'s weight — tap to update it.`
      : `It's been a while since you logged a weight for ${petNames.join(', ')} — tap to update.`,
} as const;
