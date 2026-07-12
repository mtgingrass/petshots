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
  <body style="margin:0;padding:0;background:#f5f4fb;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f4fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:480px;width:100%;">
          <tr><td style="background:#6c5ce7;padding:20px 28px;">
            <span style="font-size:20px;font-weight:700;color:#ffffff;">🐾 Petshots</span>
          </td></tr>
          <tr><td style="padding:28px;color:#1a1a2e;font-size:15px;line-height:1.55;">
            <h1 style="margin:0 0 16px;font-size:18px;color:#1a1a2e;">${escapeHtml(title)}</h1>
            ${bodyHtml}
          </td></tr>
          <tr><td style="padding:16px 28px 28px;color:#8a8a9a;font-size:12px;line-height:1.5;border-top:1px solid #eeeef5;">
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
  return `<div style="margin:0 0 20px;padding:16px 18px;background:#f9f9fc;border-radius:10px;">
    <div style="font-weight:700;font-size:15px;color:#1a1a2e;margin:0 0 8px;">${escapeHtml(petName)}</div>
    ${rowsHtml}
  </div>`;
}

export function petRowHtml(text: string): string {
  return `<div style="margin:0 0 4px;color:#3a3a4e;">${text}</div>`;
}

export function insightRowHtml(text: string): string {
  return `<div style="margin:8px 0 0;padding:8px 10px;background:#fff8e8;border-radius:6px;font-size:13px;color:#7a5a1e;">${text}</div>`;
}

export function ctaButtonHtml(url: string, label: string): string {
  return `<div style="margin:20px 0 0;"><a href="${url}" style="display:inline-block;background:#6c5ce7;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(label)}</a></div>`;
}
