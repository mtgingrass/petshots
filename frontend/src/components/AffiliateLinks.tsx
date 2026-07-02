// Unobtrusive Amazon Associates links. Plain text-pill links only — no images,
// no tracking scripts, nothing that competes with the product. The disclosure
// line is required by the Amazon Associates operating agreement.
const TAG = 'hatro-20';

const LINKS: { label: string; query: string }[] = [
  { label: 'Pet first-aid kit', query: 'pet first aid kit' },
  { label: 'Vaccine record folder', query: 'pet vaccination record folder' },
  { label: 'Travel water bottle', query: 'dog travel water bottle' },
  { label: 'Collar ID tag', query: 'pet id tag engraved' },
];

function amazonUrl(query: string): string {
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}&tag=${TAG}`;
}

export function AffiliateLinks() {
  return (
    <div className="affiliate">
      <p className="affiliate__title">Gear we like</p>
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
