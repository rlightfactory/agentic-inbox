// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef } from "react";

type Bindings = Record<string, (event: KeyboardEvent) => void>;

/** True when the key press belongs to a text field and must not trigger shortcuts. */
function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Gmail-style single-key shortcuts. Keys are matched against `event.key`
 * (e.g. "j", "#", "?", "Escape"). Ignored while typing in a field or when a
 * modifier key (other than Shift) is held, so browser shortcuts keep working.
 */
export function useShortcuts(bindings: Bindings, enabled = true) {
	const ref = useRef(bindings);
	ref.current = bindings;

	useEffect(() => {
		if (!enabled) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			if (event.key !== "Escape" && isTyping(event.target)) return;
			const handler = ref.current[event.key];
			if (!handler) return;
			handler(event);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled]);
}

export const SHORTCUT_HELP: { keys: string; description: string }[] = [
	{ keys: "j / k", description: "Next / previous conversation" },
	{ keys: "x", description: "Select conversation" },
	{ keys: "e", description: "Archive" },
	{ keys: "#", description: "Move to Trash" },
	{ keys: "s", description: "Star / unstar" },
	{ keys: "u", description: "Mark as unread" },
	{ keys: "r", description: "Reply" },
	{ keys: "a", description: "Reply all" },
	{ keys: "f", description: "Forward" },
	{ keys: "c", description: "Compose" },
	{ keys: "/", description: "Search" },
	{ keys: "⌘K / Ctrl+K", description: "Command palette" },
	{ keys: "Esc", description: "Clear selection / close" },
	{ keys: "?", description: "Show this help" },
];
