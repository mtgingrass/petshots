// Unobtrusive Amazon Associates links. Plain text-pill links only — no images,
// no tracking scripts, nothing that competes with the product. The disclosure
// line is required by the Amazon Associates operating agreement.
const TAG = 'hatro-20';

const ALL_LINKS: { label: string; query: string }[] = [
  { label: 'Pet first-aid kit', query: 'pet first aid kit' },
  { label: 'Vaccine record folder', query: 'pet vaccination record folder' },
  { label: 'Travel water bottle', query: 'dog travel water bottle collapsible' },
  { label: 'Collar ID tag', query: 'pet id tag engraved' },
  { label: 'Dog harness', query: 'no pull dog harness' },
  { label: 'Cat carrier', query: 'cat carrier soft sided airline approved' },
  { label: 'Pet nail clippers', query: 'pet nail clippers with safety guard' },
  { label: 'Flea & tick prevention', query: 'flea tick prevention dog' },
  { label: 'Pet pill organizer', query: 'pet medication organizer weekly' },
  { label: 'Dog waste bags', query: 'dog waste bags biodegradable' },
  { label: 'Dog crate', query: 'dog crate collapsible' },
  { label: 'Pet thermometer', query: 'digital pet thermometer' },
  { label: 'Retractable leash', query: 'retractable dog leash heavy duty' },
  { label: 'Pet stroller', query: 'pet stroller dog cat' },
  { label: 'Calming treats', query: 'dog calming treats anxiety' },
  { label: 'Microchip scanner', query: 'universal pet microchip scanner' },
];

// Pick 4 at random each page load — changes on refresh, stable within a session.
const LINKS = [...ALL_LINKS].sort(() => Math.random() - 0.5).slice(0, 4);

function amazonUrl(query: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}&tag=${TAG}`;
}

export function AffiliateLinks() {
  return (
    <div className="affiliate">
      <p className="affiliate__title">Support us — shop pet gear</p>
      <ul className="affiliate__links">
        {LINKS.map((l) => (
          <li key={l.label}>
            <a
              href={amazonUrl(l.query)}
              target="_blank"
              rel="noopener noreferrer sponsored"
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="affiliate__disclosure">
        As an Amazon Associate, Petshots earns from qualifying purchases.
      </p>
    </div>
  );
}
