// Shared test fixture: synthetic vaccination-certificate PDFs built from raw
// PDF content streams (no deps) — same trick as seed-marketing.mjs. Used by
// smoke-ai.mjs and ui-verify-ai-upload.mjs so both assert against CERT below.

export function buildPdf(drawOps) {
  const stream = drawOps.join('\n');
  const streamLen = Buffer.byteLength(stream, 'utf8');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]\n' +
      '   /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >>\n' +
      '   /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const header = '%PDF-1.4\n';
  const offsets = [];
  let pos = header.length;
  const objStrings = objs.map((body, i) => {
    const s = `${i + 1} 0 obj\n${body}\nendobj\n`;
    offsets.push(pos);
    pos += s.length;
    return s;
  });
  offsets.push(pos);
  const pre = `6 0 obj\n<< /Length ${streamLen} >>\nstream\n`;
  const post = `\nendstream\nendobj\n`;
  pos += pre.length + streamLen + post.length;
  const xrefOffset = pos;
  const xref = [`xref\n0 7\n`, '0000000000 65535 f\r\n'];
  for (const o of offsets) xref.push(`${String(o).padStart(10, '0')} 00000 n\r\n`);
  const trailer = `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([
    Buffer.from(header, 'latin1'),
    ...objStrings.map((s) => Buffer.from(s, 'latin1')),
    Buffer.from(pre, 'latin1'),
    Buffer.from(stream, 'utf8'),
    Buffer.from(post, 'latin1'),
    Buffer.from(xref.join(''), 'latin1'),
    Buffer.from(trailer, 'latin1'),
  ]);
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const bold = (x, y, size, txt) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(txt)}) Tj ET`;
const reg = (x, y, size, txt) => `BT /F2 ${size} Tf ${x} ${y} Td (${esc(txt)}) Tj ET`;

// The known-good values every assertion keys on.
export const CERT = {
  petName: 'Scout',
  breed: 'Golden Retriever',
  dob: '2023-07-04',
  weight: '62 lbs',
  microchip: '985112004567890',
  vet: 'Dr. Sarah Chen',
  clinic: 'Riverside Animal Clinic',
  phone: '(512) 555-0182',
  vaccines: [
    { name: 'Rabies', given: '2025-07-01', expiry: '2028-07-01' },
    { name: 'DHPP (Distemper/Parvo)', given: '2025-07-01', expiry: '2026-07-01' },
    { name: 'Bordetella', given: '2025-01-15', expiry: '2026-01-15' },
  ],
};

export function makeMultiVaccineCert() {
  const ops = [];
  ops.push('0.13 0.36 0.62 rg', '0 730 612 62 re f', '1 1 1 rg');
  ops.push(bold(36, 764, 16, CERT.clinic));
  ops.push(reg(36, 746, 8, `4201 Oak Street, Suite 100 · Austin, TX 78731     Tel: ${CERT.phone}`));
  ops.push('0 0 0 rg');
  ops.push(bold(36, 706, 13, 'CERTIFICATE OF VACCINATION'));

  let y = 683;
  const pair = (label, val) => {
    ops.push(bold(36, y, 9, label + ':'), reg(185, y, 9, val));
    y -= 16;
  };
  ops.push(bold(36, y, 10, 'PATIENT INFORMATION'));
  y -= 17;
  pair('Patient', CERT.petName);
  pair('Species', 'Canine (dog)');
  pair('Breed', CERT.breed);
  pair('Born', CERT.dob);
  pair('Weight', CERT.weight);
  pair('Microchip', CERT.microchip);

  y -= 12;
  ops.push(bold(36, y, 10, 'VACCINATIONS ADMINISTERED'));
  y -= 17;
  ops.push(bold(36, y, 9, 'Vaccine'), bold(280, y, 9, 'Date Given'), bold(420, y, 9, 'Valid Through'));
  y -= 15;
  for (const v of CERT.vaccines) {
    ops.push(reg(36, y, 9, v.name), reg(280, y, 9, v.given), reg(420, y, 9, v.expiry));
    y -= 15;
  }

  y -= 12;
  ops.push(bold(36, y, 10, 'ADMINISTERING VETERINARIAN'));
  y -= 17;
  pair('Name', CERT.vet);
  pair('Clinic', CERT.clinic);
  pair('Phone', CERT.phone);
  return buildPdf(ops);
}

export function makeNonVaccinePdf() {
  const ops = [];
  ops.push(bold(36, 740, 14, 'Weekly Grocery List'));
  ['Milk (2%)', 'Eggs, one dozen', 'Sourdough bread', 'Coffee beans', 'Apples'].forEach((t, i) =>
    ops.push(reg(36, 710 - i * 18, 10, '- ' + t)),
  );
  return buildPdf(ops);
}
