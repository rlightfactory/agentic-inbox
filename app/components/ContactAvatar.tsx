// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getAvatarColor, getInitials } from "~/lib/contacts";

/** Round initials avatar whose colour is stable per address. */
export default function ContactAvatar({
	label,
	email,
	size = 32,
}: {
	label: string;
	email: string;
	size?: number;
}) {
	const { background, color } = getAvatarColor(email || label);
	return (
		<div
			aria-hidden="true"
			className="flex shrink-0 items-center justify-center rounded-full font-semibold select-none"
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.38),
				background,
				color,
			}}
		>
			{getInitials(label)}
		</div>
	);
}
