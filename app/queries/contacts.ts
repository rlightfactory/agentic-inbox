// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Contact } from "~/types";
import { queryKeys } from "./keys";

export function useContact(
	mailboxId: string | undefined,
	email: string | undefined,
) {
	return useQuery<Contact>({
		queryKey:
			mailboxId && email
				? queryKeys.contacts.detail(mailboxId, email)
				: ["contacts", "_disabled"],
		queryFn: ({ signal }) => api.getContact(mailboxId!, email!, { signal }),
		enabled: !!mailboxId && !!email,
	});
}

/** Merging changes which addresses belong together, so drop every cached contact. */
function useInvalidateContacts() {
	const qc = useQueryClient();
	return (mailboxId: string) =>
		qc.invalidateQueries({ queryKey: queryKeys.contacts.all(mailboxId) });
}

export function useMergeContact() {
	const invalidate = useInvalidateContacts();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
			into,
		}: {
			mailboxId: string;
			email: string;
			into: string;
		}) => api.mergeContact(mailboxId, email, into),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUnmergeContact() {
	const invalidate = useInvalidateContacts();
	return useMutation({
		mutationFn: ({ mailboxId, email }: { mailboxId: string; email: string }) =>
			api.unmergeContact(mailboxId, email),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
