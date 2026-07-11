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
