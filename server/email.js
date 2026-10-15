// Sending email reminders through an email API (Resend's, by default). Nothing is sent unless both
// RESEND_API_KEY and EMAIL_FROM are set; EMAIL_API_URL points it at another compatible service (or a test server).
export const emailConfigured = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

/** → 'sent', or throws with a short reason. Callers check emailConfigured() first. */
export async function sendEmail({ to, subject, text }) {
  const r = await fetch(process.env.EMAIL_API_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`The email service answered ${r.status}.`);
  return 'sent';
}
