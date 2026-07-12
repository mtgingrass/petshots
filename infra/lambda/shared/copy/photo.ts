/**
 * Photo-album push copy — the real-time "a new photo was added" push sent by
 * the api Lambda's POST /pets/{petId}/photos/{photoId}/confirm to every OTHER
 * household member sharing the pet (not the uploader). See copy/reminder.ts's
 * header for the deploy recipe; same rule applies here. No uploader
 * attribution in v1 — keep it simple.
 */
export const photoCopy = {
  title: '🐾 New photo',
  body: (petName: string) => `A new photo of ${petName} was just added.`,
} as const;
