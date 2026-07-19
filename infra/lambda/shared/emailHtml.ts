/**
 * Shared HTML email chrome — table-based layout with inline styles (email
 * clients strip <style> blocks and don't support flexbox/grid). Every
 * transactional/report email (reminder, digest, monthly report, on-demand
 * Trends report) wraps its body in emailHtml() so they share one visual
 * identity instead of each Lambda inventing its own. The plain-text body
 * stays the deliverability/accessibility fallback — SES sends both in one
 * Simple body; this is purely a nicer rendering of the same content.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function emailHtml(title: string, bodyHtml: string, footerHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6efe4;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f1d1a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(title)} · Open Petshots to review the latest update for your pets.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:
      radial-gradient(circle at top, #f6d7ac 0%, #f6efe4 34%, #f3eee8 100%);
      padding:28px 0;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fffdf9;border:1px solid #eadfcd;border-radius:22px;overflow:hidden;max-width:560px;width:100%;box-shadow:0 18px 40px rgba(71,50,20,0.10);">
          <tr><td style="padding:26px 30px 22px;background:linear-gradient(135deg,#1f3b36 0%,#31584c 52%,#d58f49 100%);">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,248,238,0.72);margin:0 0 10px;">Pet care, kept close</div>
            <div style="font-size:26px;font-weight:800;color:#fff8ee;line-height:1.1;">🐾 Petshots</div>
            <div style="margin:10px 0 0;font-size:14px;line-height:1.5;color:rgba(255,248,238,0.88);max-width:360px;">
              Records, reminders, and check-ins that keep your household in sync.
            </div>
          </td></tr>
          <tr><td style="padding:30px;color:#2b2823;font-size:15px;line-height:1.65;">
            <h1 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#1f1d1a;">${escapeHtml(title)}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:18px 30px 30px;color:#726a5f;font-size:12px;line-height:1.6;border-top:1px solid #efe6d8;background:#fcf8f1;">
            ${footerHtml}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

// A pet's report is a titled card: name heading + a stack of label/value
// rows, used by the weekly digest, monthly report, and on-demand Trends
// report emails — all three render "one card per pet" content.
export function petCardHtml(petName: string, rowsHtml: string): string {
  return `<div style="margin:0 0 18px;padding:18px 18px 16px;background:#fffaf2;border:1px solid #efe3d2;border-radius:16px;">
    <div style="font-weight:800;font-size:16px;color:#1f1d1a;margin:0 0 10px;">${escapeHtml(petName)}</div>
    ${rowsHtml}
  </div>`;
}

export function petRowHtml(text: string): string {
  return `<div style="margin:0 0 6px;color:#4b463e;">${text}</div>`;
}

export function insightRowHtml(text: string): string {
  return `<div style="margin:10px 0 0;padding:10px 12px;background:#fff3dc;border:1px solid #f1d7a6;border-radius:10px;font-size:13px;line-height:1.5;color:#76531d;">${text}</div>`;
}

export function ctaButtonHtml(url: string, label: string): string {
  return `<div style="margin:22px 0 0;"><a href="${url}" style="display:inline-block;background:#1f3b36;color:#fffaf2;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;font-size:14px;">${escapeHtml(label)}</a></div>`;
}

export function infoCardHtml(html: string): string {
  return `<div style="margin:0 0 18px;padding:16px 18px;background:#fffaf2;border:1px solid #efe3d2;border-radius:16px;">${html}</div>`;
}
