/**
 * Email through Cloudflare Email Sending (the `EMAIL` binding). Transactional
 * only: invitations and notifications. Every message has a plain-text part and a
 * small HTML part built here, with anything a person typed escaped.
 */
import { env } from "cloudflare:workers";

export interface Email {
	to: string;
	subject: string;
	/** Short paragraphs of plain text. */
	paragraphs: string[];
	/** The one thing to do, as a button. */
	action?: { label: string; url: string };
	/** A last line in small print, e.g. why this was sent and where to change it. */
	footer?: string;
	replyTo?: string;
}

const escape = (value: string) =>
	value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function renderEmail(email: Email): { html: string; text: string } {
	const text = [
		...email.paragraphs,
		...(email.action ? [`${email.action.label}: ${email.action.url}`] : []),
		...(email.footer ? ["--", email.footer] : []),
	].join("\n\n");
	const button = email.action
		? `<p style="margin:28px 0"><a href="${escape(email.action.url)}" style="background:#16130f;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">${escape(email.action.label)}</a></p>`
		: "";
	const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f2ee">
<div style="max-width:520px;margin:0 auto;padding:32px 24px;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16130f">
<p style="font-weight:700;letter-spacing:-0.01em;margin:0 0 24px">Retween</p>
${email.paragraphs.map((paragraph) => `<p style="margin:0 0 14px">${escape(paragraph)}</p>`).join("\n")}
${button}
${email.footer ? `<p style="margin:32px 0 0;font-size:12px;color:#77706a">${escape(email.footer)}</p>` : ""}
</div></body></html>`;
	return { html, text };
}

/** Sends one message. Returns false (and logs why) instead of throwing, so a mail problem never fails the work that caused it. */
export async function sendEmail(email: Email): Promise<boolean> {
	try {
		const { html, text } = renderEmail(email);
		await env.EMAIL.send({
			to: email.to,
			from: { email: env.EMAIL_FROM, name: "Retween" },
			subject: email.subject,
			html,
			text,
			...(email.replyTo ? { replyTo: email.replyTo } : {}),
		});
		return true;
	} catch (error) {
		console.error("email not sent", email.subject, error instanceof Error ? error.message : error);
		return false;
	}
}
