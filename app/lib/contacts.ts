// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Helpers for turning raw sender strings into something a person can
 * tell apart at a glance: display name, domain and a stable avatar colour.
 */

export interface ParsedAddress {
	/** Lowercased address, e.g. "jane@acme.com". */
	email: string;
	/** Display name when known, otherwise null. */
	name: string | null;
	/** Domain part, e.g. "acme.com". */
	domain: string;
	/** Best label to show: display name, else a prettified local part. */
	label: string;
}

const ADDRESS_RE = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/;

function prettifyLocalPart(local: string): string {
	// "john.smith_99" -> "John Smith 99"
	const words = local
		.replace(/[._+-]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) return local;
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Parse `Name <addr@host>` or a bare address. An explicit display name
 * (e.g. from the `sender_name` column) overrides the one in the string.
 */
export function parseAddress(raw: string, knownName?: string | null): ParsedAddress {
	const input = (raw || "").trim();
	const m = input.match(ADDRESS_RE);
	const email = (m ? m[2] : input).trim().toLowerCase();
	const parsedName = (m?.[1] ?? "").trim();
	const name = (knownName?.trim() || parsedName || null);
	const at = email.lastIndexOf("@");
	const local = at > 0 ? email.slice(0, at) : email;
	const domain = at > 0 ? email.slice(at + 1) : "";
	return {
		email,
		name,
		domain,
		label: name || prettifyLocalPart(local),
	};
}

/**
 * Parse the `participants` list returned for threads
 * ("Name <a@x.com>,b@y.com,...") into unique people (deduped by address).
 */
export function parseParticipants(
	participants: string | undefined,
	fallbackSender: string,
	fallbackName?: string | null,
): ParsedAddress[] {
	const parts = participants
		? participants.split(",").map((p) => p.trim()).filter(Boolean)
		: [fallbackSender];
	const byEmail = new Map<string, ParsedAddress>();
	for (const part of parts) {
		const parsed = parseAddress(part);
		// The thread's latest sender is the one we know a stored name for.
		if (parsed.email === fallbackSender.toLowerCase() && fallbackName) {
			parsed.name = parsed.name || fallbackName;
			parsed.label = parsed.name;
		}
		const existing = byEmail.get(parsed.email);
		if (!existing || (!existing.name && parsed.name)) byEmail.set(parsed.email, parsed);
	}
	return [...byEmail.values()];
}

/** Up to two initials for an avatar. */
export function getInitials(label: string): string {
	const words = label.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "?";
	if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
	return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
}

/** Deterministic hue so the same person always gets the same colour. */
export function getAvatarColor(key: string): { background: string; color: string } {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
	}
	const hue = hash % 360;
	return {
		background: `hsl(${hue} 55% 88%)`,
		color: `hsl(${hue} 55% 28%)`,
	};
}

export interface RowPeople {
	/** Everyone except this mailbox (recipients for outgoing folders). */
	people: ParsedAddress[];
	/** The person to show the avatar for. */
	primary: ParsedAddress;
	/** Ready-to-render label, e.g. "Jane, Bob +2" or "To: Jane" or "You". */
	label: string;
	/** True when this mailbox itself took part (shown as "You"). */
	includesSelf: boolean;
	/** Tooltip text listing every full address. */
	title: string;
}

/**
 * Who a list row is "about". Incoming folders show the other people (this
 * mailbox is dropped, or shown as "You" when it replied); Sent/Drafts show
 * the recipients instead of the mailbox's own address.
 */
export function getRowPeople(
	email: {
		sender: string;
		sender_name?: string | null;
		participants?: string;
		recipient?: string;
	},
	mailboxEmail: string | undefined,
	outgoing: boolean,
): RowPeople {
	const self = mailboxEmail?.toLowerCase();
	const all = outgoing
		? (email.recipient || "")
				.split(",")
				.map((r) => r.trim())
				.filter(Boolean)
				.map((r) => parseAddress(r))
		: parseParticipants(email.participants, email.sender, email.sender_name);

	const includesSelf = !!self && all.some((p) => p.email === self);
	const people = all.filter((p) => p.email && p.email !== self);

	const names = people.map((p) => p.label);
	if (!outgoing && includesSelf && names.length > 0) names.push("You");

	let text: string;
	if (names.length === 0) text = "You";
	else if (names.length <= 3) text = names.join(", ");
	else text = `${names.slice(0, 2).join(", ")} +${names.length - 2}`;

	const primary =
		people[0] ?? parseAddress(email.sender || self || "", email.sender_name);

	return {
		people,
		primary,
		label: outgoing && people.length > 0 ? `To: ${text}` : text,
		includesSelf,
		title: people.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join("\n"),
	};
}
