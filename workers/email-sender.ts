// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/** Email sending via the Brevo transactional email HTTP API. */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

interface BrevoSendResponse {
	messageId?: string;
	messageIds?: string[];
	code?: string;
	message?: string;
}

interface BrevoContact {
	email: string;
	name?: string;
}

function toContact(address: string | { email: string; name: string }): BrevoContact {
	if (typeof address === "string") return { email: address };
	return {
		email: address.email,
		name: address.name.replace(/[\r\n]/g, " "),
	};
}

function toContacts(addresses: string | string[]): BrevoContact[] {
	return (Array.isArray(addresses) ? addresses : [addresses]).map((email) => ({ email }));
}

/**
 * Send an email using Brevo.
 *
 * @param apiKey - Brevo API key from the `BREVO_API_KEY` Worker secret
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The Brevo message ID
 * @throws When configuration, validation, or API delivery acceptance fails
 */
export async function sendEmail(
	apiKey: string,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	if (!apiKey) {
		throw new Error("BREVO_API_KEY is not configured");
	}

	const message: Record<string, unknown> = {
		to: toContacts(params.to),
		sender: toContact(params.from),
		subject: params.subject,
	};

	if (params.html) message.htmlContent = params.html;
	if (params.text) message.textContent = params.text;
	if (params.cc) message.cc = toContacts(params.cc);
	if (params.bcc) message.bcc = toContacts(params.bcc);
	if (params.replyTo) message.replyTo = toContact(params.replyTo);

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachment = params.attachments.map((att) => ({
			content: att.content,
			name: att.filename,
		}));
	}

	const response = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: {
			"api-key": apiKey,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(message),
	});

	let result: BrevoSendResponse;
	try {
		result = await response.json<BrevoSendResponse>();
	} catch {
		throw new Error(`Brevo returned an invalid response (HTTP ${response.status})`);
	}

	const messageId = result.messageId || result.messageIds?.[0];
	if (!response.ok || !messageId) {
		const detail = result.message || result.code || response.statusText;
		throw new Error(`Brevo send failed (HTTP ${response.status}): ${detail}`);
	}

	return { messageId };
}
