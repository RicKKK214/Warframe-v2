/**
 * Transactional email for account verification and password reset.
 *
 * Uses SMTP via nodemailer when SMTP_URL is configured (works with Gmail app
 * passwords, Resend/SendGrid/Mailgun SMTP, or any relay). Without SMTP_URL the
 * app logs the link to the server console only — accounts still work, password
 * reset is disabled with an honest error, and email verification is skipped
 * (accounts start verified) so nothing silently pretends to have sent mail.
 *
 * The mailer NEVER receives anything but the reset/verify token link (which is
 * single-use and hashed at rest); passwords are never emailed or logged.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailerStatus {
  configured: boolean;
  from: string;
}

let cachedTransport: Transporter | null | undefined;

export function mailerStatus(): MailerStatus {
  const url = process.env.SMTP_URL?.trim();
  return {
    configured: !!url,
    from: process.env.MAIL_FROM?.trim() || 'Warframe Prime Arbitrage <no-reply@wf-arb.local>',
  };
}

function getTransport(): Transporter | null {
  if (cachedTransport !== undefined) return cachedTransport;
  const url = process.env.SMTP_URL?.trim();
  cachedTransport = url ? nodemailer.createTransport(url) : null;
  return cachedTransport;
}

/** Send an email. Returns false (and logs the link) when SMTP is not configured. */
export async function sendMail(msg: MailMessage): Promise<boolean> {
  const t = getTransport();
  if (!t) {
    // Dev fallback: the link is printed server-side only, never to the client.
    console.log(`[mail] SMTP not configured - not sending "${msg.subject}" to ${msg.to}`);
    console.log(`[mail] link: ${msg.text.match(/https?:\/\/\S+/)?.[0] ?? '(no link)'}`);
    return false;
  }
  try {
    await t.sendMail({ from: mailerStatus().from, ...msg });
    return true;
  } catch (e) {
    console.error('[mail] send failed:', e instanceof Error ? e.message : e);
    return false;
  }
}

/** Themed HTML wrapper matching the dark/purple scanner UI (email clients ignore
 * Tailwind, so inline styles). */
export function wrapEmail(title: string, bodyHtml: string, ctaUrl?: string, ctaLabel?: string): { text: string; html: string } {
  const text = `${title}\n\n${bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}${ctaUrl ? `\n\n${ctaUrl}` : ''}`;
  const html = `<!doctype html><html><body style="margin:0;background:#05060a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d6ff;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#0d1018;border:1px solid #1f2637;border-radius:12px;padding:24px;">
    <div style="color:#a78bfa;font-weight:600;letter-spacing:.08em;font-size:12px;">PRIME ARBITRAGE SCANNER</div>
    <h2 style="margin:12px 0 8px;color:#f1f5f9;font-size:18px;">${title}</h2>
    <div style="font-size:13px;line-height:1.6;color:#94a3b8;">${bodyHtml}</div>
    ${ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:18px;background:#8b5cf6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;">${ctaLabel ?? 'Open link'}</a>
    <p style="margin-top:16px;font-size:11px;color:#475569;">Or paste this link into your browser:<br><span style="color:#64748b;word-break:break-all;">${ctaUrl}</span></p>` : ''}
    <p style="margin-top:22px;font-size:11px;color:#475569;">If you did not request this email you can ignore it.</p>
  </div>
</body></html>`;
  return { text, html };
}
