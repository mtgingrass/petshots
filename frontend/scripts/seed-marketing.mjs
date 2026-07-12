/**
 * seed-marketing.mjs — Populate the permanent demo@petshots.app account
 * with two realistic pets (Bella the golden retriever, Luna the tabby cat)
 * for marketing screenshots. Safe to re-run; wipes and rebuilds pets each time.
 *
 * Usage:  node scripts/seed-marketing.mjs
 *
 * Account: demo@petshots.app  (permanent, production)
 * Password stored in Claude memory only — never committed to git.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'amazon-cognito-identity-js';

const { CognitoUserPool, CognitoUser, AuthenticationDetails } = pkg;

const API = 'https://ycg5npcyk8.execute-api.us-east-1.amazonaws.com';
const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '..', '.env'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const EMAIL = 'demo@petshots.app';
const PASSWORD = process.env.DEMO_PASSWORD; // never hardcode - this is a real production account
if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD (credentials live in Claude memory, never in git).');
  process.exit(1);
}

// ── Auth ────────────────────────────────────────────────────────────────────

function login() {
  const pool = new CognitoUserPool({
    UserPoolId: env.VITE_COGNITO_USER_POOL_ID,
    ClientId:   env.VITE_COGNITO_CLIENT_ID,
  });
  const user    = new CognitoUser({ Username: EMAIL, Pool: pool });
  const details = new AuthenticationDetails({ Username: EMAIL, Password: PASSWORD });
  return new Promise((resolve, reject) =>
    user.authenticateUser(details, { onSuccess: (s) => resolve(s.getAccessToken().getJwtToken()), onFailure: reject }),
  );
}

// ── API helpers ──────────────────────────────────────────────────────────────

async function api(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body != null ? { 'content-type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function s3Post(presign, bytes, mimeType) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type: mimeType }));
  const res = await fetch(presign.url, { method: 'POST', body: form });
  if (res.status !== 204) throw new Error(`S3 POST → ${res.status}: ${await res.text()}`);
}

// ── Image download ───────────────────────────────────────────────────────────

async function downloadJpeg(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Petshots/1.0)' },
  });
  if (!res.ok) throw new Error(`Image download ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── PDF generator ────────────────────────────────────────────────────────────
// Builds a minimal but visually formatted vaccination certificate PDF.
// No external deps — pure PDF spec (Type1 fonts, content streams).

function makeCertPdf({
  petName, species, sex, dob, microchip,
  vaccine, manufacturer, lot, givenDate, expiryDate = 'N/A',
  vet, vetLicense,
  clinic = 'Riverside Animal Clinic',
  address = '4201 Oak Street, Suite 100  ·  Austin, TX 78731',
  phone = '(512) 555-0182',
}) {
  // PDF strings: escape parens and backslashes
  const e = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  // Accumulate content-stream operators
  const ops = [];
  const op  = (...args) => ops.push(args.join(' '));

  // Filled rectangle: rg sets fill color
  const box = (x, y, w, h, r, g, b) => { op(`${r} ${g} ${b} rg`); op(`${x} ${y} ${w} ${h} re f`); };
  // Horizontal rule (gray)
  const rule = (y) => { op('0.7 0.7 0.7 RG 0.5 w'); op(`36 ${y} m 576 ${y} l S`); };
  // Bold text
  const bold = (x, y, size, txt) => op(`BT /F1 ${size} Tf ${x} ${y} Td (${e(txt)}) Tj ET`);
  // Regular text
  const reg  = (x, y, size, txt) => op(`BT /F2 ${size} Tf ${x} ${y} Td (${e(txt)}) Tj ET`);

  // ── Header bar ─────────────────────────────────────────────────────────────
  box(0, 730, 612, 62, 0.13, 0.36, 0.62);
  op('1 1 1 rg');
  bold(36, 764, 16, clinic);
  reg(36,  746,  8, address + '     Tel: ' + phone);

  // ── Title ──────────────────────────────────────────────────────────────────
  op('0 0 0 rg');
  bold(36, 706, 13, 'CERTIFICATE OF VACCINATION');
  rule(699);

  // ── Patient section ────────────────────────────────────────────────────────
  const COL1 = 36, COL2 = 185;
  const fieldPairs = (startY, rows) => {
    let y = startY;
    for (const [label, val] of rows) {
      bold(COL1, y, 9, label + ':');
      reg(COL2,  y, 9, val);
      y -= 16;
    }
    return y;
  };

  bold(36, 683, 10, 'PATIENT INFORMATION');
  const afterPatient = fieldPairs(666, [
    ['Patient',    petName],
    ['Species',    species],
    ['Sex',        sex],
    ['Born',       dob],
    ['Microchip',  microchip],
  ]);

  // ── Vaccine section ────────────────────────────────────────────────────────
  rule(afterPatient + 5);
  bold(36, afterPatient - 10, 10, 'VACCINE ADMINISTERED');
  const afterVax = fieldPairs(afterPatient - 27, [
    ['Vaccine',       vaccine],
    ['Manufacturer',  manufacturer],
    ['Lot #',         lot],
    ['Date Given',    givenDate],
    ['Valid Through', expiryDate],
  ]);

  // ── Vet section ────────────────────────────────────────────────────────────
  rule(afterVax + 5);
  bold(36, afterVax - 10, 10, 'ADMINISTERING VETERINARIAN');
  fieldPairs(afterVax - 27, [
    ['Name',      vet],
    ['License',   vetLicense],
    ['Signature', '_________________________________'],
  ]);

  // ── Footer ─────────────────────────────────────────────────────────────────
  const footY = afterVax - 95;
  rule(footY + 10);
  reg(36, footY - 4,  7.5, 'This certificate is valid from the date of administration. Present at boarding, grooming, and daycare check-ins.');
  reg(36, footY - 16, 7.5, clinic + '  ·  ' + phone + '  ·  Keep this record for your files.');

  // ── Assemble PDF ───────────────────────────────────────────────────────────
  const stream = ops.join('\n');
  const streamLen = Buffer.byteLength(stream, 'utf8');

  // Object bodies
  const objs = [
    /* 1 */ '<< /Type /Catalog /Pages 2 0 R >>',
    /* 2 */ '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    /* 3 */ '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n' +
            '   /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >>\n' +
            '   /Contents 6 0 R >>',
    /* 4 */ '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    /* 5 */ '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const header = '%PDF-1.4\n';
  const offsets = [];
  let pos = header.length;

  // Build object strings and track offsets
  const objStrings = objs.map((body, i) => {
    const s = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    pos += s.length;
    return s;
  });

  // Stream object (obj 6)
  offsets.push(pos);
  const streamObjPre  = `6 0 obj\n<< /Length ${streamLen} >>\nstream\n`;
  const streamObjPost = `\nendstream\nendobj\n`;
  pos += streamObjPre.length + streamLen + streamObjPost.length;

  // xref + trailer
  const xrefOffset = pos;
  const totalObjs  = objs.length + 2; // 0..6 → 7 entries
  const xrefLines  = [`xref\n0 ${totalObjs}\n`, '0000000000 65535 f\r\n'];
  for (const o of offsets) xrefLines.push(`${String(o).padStart(10, '0')} 00000 n\r\n`);
  const trailer = `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    ...objStrings.map((s) => Buffer.from(s, 'latin1')),
    Buffer.from(streamObjPre, 'latin1'),
    Buffer.from(stream, 'utf8'),
    Buffer.from(streamObjPost, 'latin1'),
    Buffer.from(xrefLines.join(''), 'latin1'),
    Buffer.from(trailer, 'latin1'),
  ]);
}

// ── Pet record definitions ───────────────────────────────────────────────────
// Today: 2026-07-04
//   CURRENT  = expiry ≥ 2026-08-04  (>30 days out)
//   DUE SOON = 2026-07-05–2026-08-03 (within 30 days)
//   OVERDUE  = before 2026-07-04
//   NO DATE  = null / undefined

const VET1 = { vet: 'Dr. Sarah Chen, DVM', vetLicense: 'TX-8834-DVM' };
const VET2 = { vet: 'Dr. Marcus Rivera, DVM', vetLicense: 'TX-9217-DVM' };
const CLINIC = {
  clinic: 'Riverside Animal Clinic',
  address: '4201 Oak Street, Suite 100  ·  Austin, TX 78731',
  phone: '(512) 555-0182',
};

const BELLA_RECORDS = [
  {
    label:   'Rabies',
    expiry:  '2027-08-15',                 // CURRENT ✅
    pdf: makeCertPdf({
      petName: 'Bella', species: 'Canine (Golden Retriever)', sex: 'Female, Spayed', dob: 'July 4, 2023',
      microchip: '985112004567893',
      vaccine: 'IMRAB 3 (Rabies)', manufacturer: 'Boehringer Ingelheim', lot: 'RA2B-4421-L',
      givenDate: 'August 15, 2025', expiryDate: 'August 15, 2027',
      ...VET1, ...CLINIC,
    }),
  },
  {
    label:   'DHPP',
    expiry:  '2027-06-01',                 // CURRENT ✅
    pdf: makeCertPdf({
      petName: 'Bella', species: 'Canine (Golden Retriever)', sex: 'Female, Spayed', dob: 'July 4, 2023',
      microchip: '985112004567893',
      vaccine: 'Nobivac DHPP (Distemper, Hepatitis, Parainfluenza, Parvovirus)',
      manufacturer: 'Merck Animal Health', lot: 'DP2-1829-K',
      givenDate: 'June 1, 2025', expiryDate: 'June 1, 2027',
      ...VET1, ...CLINIC,
    }),
  },
  {
    label:   'Bordetella',
    expiry:  '2026-07-28',                 // DUE SOON 🟡
    pdf: makeCertPdf({
      petName: 'Bella', species: 'Canine (Golden Retriever)', sex: 'Female, Spayed', dob: 'July 4, 2023',
      microchip: '985112004567893',
      vaccine: 'Bronchi-Shield III (Bordetella / Kennel Cough)',
      manufacturer: 'Zoetis', lot: 'BC-9871-M',
      givenDate: 'July 28, 2025', expiryDate: 'July 28, 2026',
      ...VET1, ...CLINIC,
    }),
  },
  {
    label:   'Leptospirosis',
    expiry:  undefined,                    // NO DATE ⚪
    pdf: makeCertPdf({
      petName: 'Bella', species: 'Canine (Golden Retriever)', sex: 'Female, Spayed', dob: 'July 4, 2023',
      microchip: '985112004567893',
      vaccine: 'Nobivac Lepto4 (Leptospirosis)', manufacturer: 'Merck Animal Health', lot: 'LP-4512-J',
      givenDate: 'September 10, 2025', expiryDate: 'See label',
      ...VET1, ...CLINIC,
    }),
  },
];

const LUNA_RECORDS = [
  {
    label:   'Rabies',
    expiry:  '2027-05-20',                 // CURRENT ✅
    pdf: makeCertPdf({
      petName: 'Luna', species: 'Feline (Domestic Shorthair)', sex: 'Female, Spayed', dob: 'March 12, 2024',
      microchip: '985112003891245',
      vaccine: 'Purevax Feline Rabies', manufacturer: 'Boehringer Ingelheim', lot: 'FR3C-7744-A',
      givenDate: 'May 20, 2025', expiryDate: 'May 20, 2027',
      ...VET2, ...CLINIC,
    }),
  },
  {
    label:   'FVRCP',
    expiry:  '2026-06-10',                 // OVERDUE 🔴
    pdf: makeCertPdf({
      petName: 'Luna', species: 'Feline (Domestic Shorthair)', sex: 'Female, Spayed', dob: 'March 12, 2024',
      microchip: '985112003891245',
      vaccine: 'Purevax FVRCP (Rhinotracheitis, Calicivirus, Panleukopenia)',
      manufacturer: 'Boehringer Ingelheim', lot: 'FC-7729-N',
      givenDate: 'June 10, 2025', expiryDate: 'June 10, 2026',
      ...VET2, ...CLINIC,
    }),
  },
  {
    label:   'FeLV',
    expiry:  '2026-07-28',                 // DUE SOON 🟡
    pdf: makeCertPdf({
      petName: 'Luna', species: 'Feline (Domestic Shorthair)', sex: 'Female, Spayed', dob: 'March 12, 2024',
      microchip: '985112003891245',
      vaccine: 'Purevax Recombinant FeLV (Feline Leukemia Virus)',
      manufacturer: 'Boehringer Ingelheim', lot: 'FL-3345-P',
      givenDate: 'July 28, 2025', expiryDate: 'July 28, 2026',
      ...VET2, ...CLINIC,
    }),
  },
  {
    label:   'Heartworm Prevention',
    expiry:  undefined,                    // NO DATE ⚪
    pdf: makeCertPdf({
      petName: 'Luna', species: 'Feline (Domestic Shorthair)', sex: 'Female, Spayed', dob: 'March 12, 2024',
      microchip: '985112003891245',
      vaccine: 'Revolution Plus (Selamectin + Sarolaner) — Monthly',
      manufacturer: 'Zoetis', lot: 'RP-1192-Z',
      givenDate: 'July 1, 2026', expiryDate: 'Monthly — next due Aug 1, 2026',
      ...VET2, ...CLINIC,
    }),
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nLogging in as ${EMAIL}...`);
const token = await login();
console.log('✓ Authenticated\n');

// Clear any existing pets on this account
const { pets: existing = [] } = await api(token, 'GET', '/pets');
for (const p of existing) {
  await api(token, 'DELETE', `/pets/${p.id}`);
}
if (existing.length) console.log(`Cleared ${existing.length} prior pet(s)\n`);

// ── PET 1: BELLA ─────────────────────────────────────────────────────────────
console.log('Creating Bella (Golden Retriever)...');
const { pet: bella } = await api(token, 'POST', '/pets', { name: 'Bella', species: 'dog' });
await api(token, 'PUT', `/pets/${bella.id}`, {
  name: 'Bella', species: 'dog', breed: 'Golden Retriever',
  dob: '2023-07-04', allergies: 'None known', notes: 'Friendly with other dogs. Treats are in the blue bin.',
});

console.log('  Downloading photo...');
const bellaPhoto = await downloadJpeg(
  'https://images.unsplash.com/photo-1552053831-71594a27632d?w=400&h=400&fit=crop&q=80',
);
const bellaAv = await api(token, 'POST', `/pets/${bella.id}/avatar/upload-url`, { contentType: 'image/jpeg' });
await s3Post(bellaAv, bellaPhoto, 'image/jpeg');
console.log(`  ✓ Photo uploaded (${(bellaPhoto.length / 1024).toFixed(0)} KB)`);

for (const rec of BELLA_RECORDS) {
  const presign = await api(token, 'POST', `/pets/${bella.id}/docs/upload-url`, {
    filename: `${rec.label.replace(/[^a-zA-Z0-9]/g, '_')}_Certificate.pdf`,
    label:       rec.label,
    expiry:      rec.expiry ?? null,
    contentType: 'application/pdf',
  });
  await s3Post(presign, rec.pdf, 'application/pdf');
  const badge = rec.expiry
    ? (rec.expiry < '2026-07-04' ? 'OVERDUE 🔴' : rec.expiry < '2026-08-04' ? 'DUE SOON 🟡' : 'CURRENT ✅')
    : 'NO DATE ⚪';
  console.log(`  ✓ ${rec.label.padEnd(20)} ${badge}`);
}

// ── PET 2: LUNA ──────────────────────────────────────────────────────────────
console.log('\nCreating Luna (Domestic Shorthair Cat)...');
const { pet: luna } = await api(token, 'POST', '/pets', { name: 'Luna', species: 'cat' });
await api(token, 'PUT', `/pets/${luna.id}`, {
  name: 'Luna', species: 'cat', breed: 'Domestic Shorthair',
  dob: '2024-03-12', allergies: 'None known', notes: 'Indoor cat. Shy with strangers — give her a minute.',
});

console.log('  Downloading photo...');
const lunaPhoto = await downloadJpeg(
  'https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=400&h=400&fit=crop&q=80',
);
const lunaAv = await api(token, 'POST', `/pets/${luna.id}/avatar/upload-url`, { contentType: 'image/jpeg' });
await s3Post(lunaAv, lunaPhoto, 'image/jpeg');
console.log(`  ✓ Photo uploaded (${(lunaPhoto.length / 1024).toFixed(0)} KB)`);

for (const rec of LUNA_RECORDS) {
  const presign = await api(token, 'POST', `/pets/${luna.id}/docs/upload-url`, {
    filename: `${rec.label.replace(/[^a-zA-Z0-9]/g, '_')}_Certificate.pdf`,
    label:       rec.label,
    expiry:      rec.expiry ?? null,
    contentType: 'application/pdf',
  });
  await s3Post(presign, rec.pdf, 'application/pdf');
  const badge = rec.expiry
    ? (rec.expiry < '2026-07-04' ? 'OVERDUE 🔴' : rec.expiry < '2026-08-04' ? 'DUE SOON 🟡' : 'CURRENT ✅')
    : 'NO DATE ⚪';
  console.log(`  ✓ ${rec.label.padEnd(20)} ${badge}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`
Done! Marketing demo account seeded:
  URL:     https://petshots.app
  Email:   ${EMAIL}
  Pets:    Bella (4 docs: ✅✅🟡⚪)  +  Luna (4 docs: ✅🔴🟡⚪)
  Clinic:  Riverside Animal Clinic, Austin TX
  Vet:     Dr. Sarah Chen / Dr. Marcus Rivera

All four badge states visible on both pets. Good for screenshots.
`);
