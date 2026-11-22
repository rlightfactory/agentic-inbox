// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Convert an HTML email body to plain text without a DOM, so it works in the
 * Worker, during SSR and in the browser.
 *
 * Newsletter and form-notification emails carry large <style> blocks, MSO
 * conditional comments and <head> content; if only the tags are removed their
 * CSS shows up as "text" (e.g. "/* GLOBAL basic CSS reset *\/ img { ... }").
 * Those blocks are dropped before any tag stripping.
 *
 * @param keepLines Keep paragraph / line breaks as "\n" (for quoting in a
 *   reply) instead of collapsing everything to one line (for snippets).
 */
export function htmlToText(html: string | null | undefined, keepLines = false): string {
	if (!html) return "";

	let text = html
		// Comments, including <!--[if mso]> ... <![endif]--> conditional blocks
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<!\[[^\]]*\]>/g, " ")
		// Whole elements whose content is never visible text
		.replace(/<(head|style|script|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
		// Unclosed style/script: drop everything after the opening tag
		.replace(/<(style|script)\b[\s\S]*$/gi, " ");

	if (keepLines) {
		text = text
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n");
	}

	text = decodeEntities(text.replace(/<[^>]*>/g, " "));

	if (keepLines) {
		return text
			.replace(/[ \t\r\f\v ]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}
	return text.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		return NAMED_ENTITIES[body.toLowerCase()] ?? match;
	});
}

/**
 * Repair reply quotes written by an older version that kept the original
 * email's <style> content as text.
 *
 * Those stored replies contain a <blockquote> whose text includes whole CSS
 * (comments like `/* GLOBAL *\/` and rules like `img { max-width: 100%; }`),
 * and entities that were escaped twice (`&amp;#39;`). The repair only touches
 * blockquotes that contain both a CSS comment and a CSS rule, so ordinary
 * quoted text is never altered.
 */
export function cleanLeakedCss(html: string): string {
	if (!html || !html.includes("/*")) return html;
	return html.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote>/gi, (block) => {
		const hasComment = /\/\*[\s\S]*?\*\//.test(block);
		const hasRule = /[^{}<>]*\{[^{}]*:[^{}]*;[^{}]*\}/.test(block);
		if (!hasComment || !hasRule) return block;
		// A CSS comment marks a boundary, so prose in front of it ("A new
		// submission") is never mistaken for the selector of the next rule.
		const BOUNDARY = "\u0001";
		return block
			.replace(/\/\*[\s\S]*?\*\//g, BOUNDARY)
			// @media blocks hold nested rules, so remove them before plain rules
			.replace(/@(?:media|supports|font-face|keyframes|-webkit-keyframes|import|page|charset)\b[^{};\u0001]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/gi, " ")
			.replace(/[^{}<>;\u0001]*\{[^{}]*\}/g, " ")
			.replace(/\u0001/g, " ")
			.replace(/&amp;(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, "&$1;")
			.replace(/[ \t]{2,}/g, " ");
	});
}
