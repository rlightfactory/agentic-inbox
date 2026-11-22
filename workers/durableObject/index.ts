// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { eq, and, or, asc, desc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import * as schema from "../db/schema";
import { Folders } from "../../shared/folders";
import type { Env } from "../types";
import { applyMigrations, mailboxMigrations } from "./migrations";

/**
 * SQL expression to normalize email subjects by stripping common
 * reply/forward prefixes (Re:, Fwd:, FW:, AW:, WG:, Réf:, SV:).
 * Used for conversation grouping. Hardcoded to the `subject` column.
 */
const NORMALIZED_SUBJECT_SQL = `LOWER(TRIM(
	REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
		LOWER(subject),
		'aw: ', ''), 'wg: ', ''), 'réf: ', ''), 'sv: ', ''),
		're: ', ''), 'fwd: ', ''), 'fw: ', '')
))`;

/**
 * Aggregate distinct thread participants as "Name <address>" (or a bare
 * address when no display name is known). Commas and angle brackets are
 * stripped from names so the result stays safely comma-splittable.
 */
const PARTICIPANTS_SQL = `GROUP_CONCAT(DISTINCT CASE
	WHEN sender_name IS NOT NULL AND sender_name != ''
	THEN REPLACE(REPLACE(REPLACE(sender_name, ',', ' '), '<', ' '), '>', ' ') || ' <' || sender || '>'
	ELSE sender END)`;

/**
 * Gmail-style conversation grouping, as a CTE named `keyed`.
 *
 * Every message gets a `conversation_id`: its normalized subject plus the
 * other party (the sender for received mail, the first recipient for Sent and
 * Drafts), with merged contact addresses counted as one person. Replies
 * therefore join the original conversation even when they were sent days
 * later or carry no usable threading headers. Messages without a subject fall
 * back to their thread id.
 */
const COUNTERPART_SQL = `LOWER(TRIM(CASE
	WHEN folder_id IN ('${Folders.SENT}', '${Folders.DRAFT}') THEN
		CASE WHEN INSTR(recipient, ',') > 0
			THEN SUBSTR(recipient, 1, INSTR(recipient, ',') - 1)
			ELSE COALESCE(recipient, '') END
	ELSE COALESCE(sender, '') END))`;

const KEYED_CTE = `keyed AS (
	SELECT m.*,
		CASE WHEN m.ns != ''
			THEN m.ns || char(31) || COALESCE(a.canonical, m.cp)
			ELSE COALESCE(m.thread_id, m.id) END AS conversation_id
	FROM (
		SELECT emails.*, ${NORMALIZED_SUBJECT_SQL} AS ns, ${COUNTERPART_SQL} AS cp
		FROM emails
	) m
	LEFT JOIN contact_aliases a ON a.email = m.cp
)`;

const ALLOWED_SORT_COLUMNS = [
	"id",
	"subject",
	"sender",
	"recipient",
	"date",
	"read",
	"starred",
] as const;

type SortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

/**
 * Map SortColumn string names to Drizzle column references for safe
 * ORDER BY construction (no string interpolation into SQL).
 */
const SORT_COLUMN_MAP = {
	id: schema.emails.id,
	subject: schema.emails.subject,
	sender: schema.emails.sender,
	recipient: schema.emails.recipient,
	date: schema.emails.date,
	read: schema.emails.read,
	starred: schema.emails.starred,
} satisfies Record<SortColumn, typeof schema.emails[keyof typeof schema.emails]>;

interface SearchFilterOptions {
	query: string;
	folder?: string;
	from?: string;
	contact?: string;
	to?: string;
	subject?: string;
	date_start?: string;
	date_end?: string;
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
}

export type ConversationFilter = "unread" | "starred";

interface GetEmailsOptions {
	filter?: ConversationFilter;
	folder?: string;
	thread_id?: string;
	page?: number;
	limit?: number;
	sortColumn?: SortColumn;
	sortDirection?: "ASC" | "DESC";
}

interface EmailData {
	id: string;
	subject: string;
	sender: string;
	sender_name?: string | null;
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	body: string;
	read?: boolean;
	starred?: boolean;
	in_reply_to?: string | null;
	email_references?: string | null;
	thread_id?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
}

interface AttachmentData {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string | null;
	disposition?: string | null;
}

export class MailboxDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, mailboxMigrations, this.ctx.storage);
		this.#backfillSenderNames();
	}

	/**
	 * One-time best-effort backfill of sender display names from the stored
	 * raw headers, so mail received before sender_name existed also shows
	 * names. Failures are non-fatal: the UI falls back to the address.
	 */
	#backfillSenderNames() {
		const KEY = "sender_names_backfilled";
		try {
			if (this.ctx.storage.kv.get(KEY)) return;
			const rows = [
				...this.ctx.storage.sql.exec(
					"SELECT id, raw_headers FROM emails WHERE sender_name IS NULL AND raw_headers IS NOT NULL",
				),
			] as { id: string; raw_headers: string }[];
			for (const row of rows) {
				try {
					const headers = JSON.parse(row.raw_headers);
					if (!Array.isArray(headers)) continue;
					const from = headers.find(
						(h: any) => typeof h?.key === "string" && h.key.toLowerCase() === "from",
					);
					const m = typeof from?.value === "string" ? from.value.match(/^\s*"?([^"<]+?)"?\s*</) : null;
					const name = m?.[1]?.trim();
					if (name) {
						this.ctx.storage.sql.exec("UPDATE emails SET sender_name = ?1 WHERE id = ?2", name, row.id);
					}
				} catch {
					// ignore malformed header blobs
				}
			}
			this.ctx.storage.kv.put(KEY, true);
		} catch (err) {
			console.error("sender name backfill failed", err);
		}
	}

	// ── Email CRUD (Drizzle) ───────────────────────────────────────

	async getEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			thread_id,
			page = 1,
			limit: rawLimit = 25,
			sortColumn: rawSortColumn = "date",
			sortDirection = "DESC",
		} = options;

		// Cap pagination limit to prevent unbounded queries
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		const sortColumn: SortColumn = ALLOWED_SORT_COLUMNS.includes(
			rawSortColumn as SortColumn,
		)
			? rawSortColumn
			: "date";

		const offset = (page - 1) * limit;

		const conditions: SQL[] = [];
		if (folder) {
			conditions.push(
				sql`${schema.emails.folder_id} = (SELECT id FROM folders WHERE name = ${folder} OR id = ${folder} LIMIT 1)`,
			);
		}
		if (thread_id) {
			conditions.push(eq(schema.emails.thread_id, thread_id));
		}

		const orderCol = SORT_COLUMN_MAP[sortColumn];
		const orderDir = sortDirection === "ASC" ? asc(orderCol) : desc(orderCol);

		const result = this.db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				sender: schema.emails.sender,
				sender_name: schema.emails.sender_name,
				recipient: schema.emails.recipient,
				cc: schema.emails.cc,
				bcc: schema.emails.bcc,
				date: schema.emails.date,
				read: schema.emails.read,
				starred: schema.emails.starred,
				in_reply_to: schema.emails.in_reply_to,
				email_references: schema.emails.email_references,
				thread_id: schema.emails.thread_id,
				folder_id: schema.emails.folder_id,
				snippet: sql<string>`SUBSTR(${schema.emails.body}, 1, 300)`,
			})
			.from(schema.emails)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(orderDir)
			.limit(limit)
			.offset(offset)
			.all();

		return result.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
		}));
	}

	/**
	 * Count total emails matching the given filters (for pagination).
	 */
	async countEmails(options: { folder?: string; thread_id?: string } = {}) {
		const { folder, thread_id } = options;
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		if (folder) {
			conditions.push(
				"folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			);
			params.push(folder);
		}

		if (thread_id) {
			conditions.push(`thread_id = ?${params.length + 1}`);
			params.push(thread_id);
		}

		const where =
			conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) as total FROM emails ${where}`,
				...params,
			),
		][0] as { total: number } | undefined;

		return row?.total ?? 0;
	}

	// ── Threaded queries (raw SQL — too complex for Drizzle's builder) ──

	async getThreadedEmails(options: GetEmailsOptions = {}) {
		const {
			folder,
			page = 1,
			limit: rawLimit = 25,
			filter,
		} = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);

		if (!folder) {
			// Fallback to regular getEmails if no folder specified
			return this.getEmails(options);
		}

		const offset = (page - 1) * limit;

		// Thread grouping strategy:
		// For DRAFT folder: group by in_reply_to (the email being replied to).
		//   This ensures reply-drafts to different emails stay separate, even if
		//   they share a thread_id or subject. New drafts (no in_reply_to) each
		//   get their own group via their unique id.
		// For other folders:
		//   1. Primary: group by thread_id (from email threading headers)
		//   2. Fallback: group by normalized subject (strips Re:/Fwd:/FW: prefixes)
		//      for legacy emails that lack threading headers (thread_id IS NULL).
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const result = this.ctx.storage.sql.exec(
				`WITH
				folder_emails AS (
					SELECT *,
						COALESCE(in_reply_to, id) as draft_group_key
					FROM emails
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				),
				draft_stats AS (
					SELECT
						draft_group_key,
						COUNT(*) as thread_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
						${PARTICIPANTS_SQL} as participants
					FROM folder_emails
					GROUP BY draft_group_key
				),
				latest_per_group AS (
					SELECT
						fe.*,
						ROW_NUMBER() OVER (
							PARTITION BY fe.draft_group_key
							ORDER BY fe.date DESC
						) as rn
					FROM folder_emails fe
				)
				SELECT
					lp.id, lp.subject, lp.sender, lp.sender_name, lp.recipient, lp.date,
					lp.read, lp.starred, lp.thread_id, lp.folder_id,
					lp.in_reply_to, lp.email_references,
					SUBSTR(lp.body, 1, 300) as snippet,
					ds.thread_count, ds.thread_unread_count, ds.participants
				FROM latest_per_group lp
				JOIN draft_stats ds ON lp.draft_group_key = ds.draft_group_key
				WHERE lp.rn = 1
				ORDER BY lp.date DESC
				LIMIT ?2 OFFSET ?3`,
				folder, limit, offset
			);

			const rows = [...result];
			return rows.map((row: any) => ({
				...row,
				read: !!row.read,
				starred: !!row.starred,
				thread_count: row.thread_count || 1,
				thread_unread_count: row.thread_unread_count || 0,
				participants: row.participants || row.sender,
			}));
		}

		// Non-draft folders: Gmail-style conversations (see KEYED_CTE).
		const folderIdSql = "(SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)";
		const result = this.ctx.storage.sql.exec(
			`WITH
			${KEYED_CTE},
			folder_conversations AS (
				SELECT DISTINCT conversation_id FROM keyed
				WHERE folder_id = ${folderIdSql}
			),
			conversation_stats AS (
				SELECT
					conversation_id,
					COUNT(*) as thread_count,
					SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) as thread_unread_count,
					SUM(CASE WHEN read = 1 THEN 1 ELSE 0 END) as thread_read_count,
					SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) as thread_starred_count,
					${PARTICIPANTS_SQL} as participants,
					SUM(CASE WHEN folder_id = 'draft' THEN 1 ELSE 0 END) as has_draft
				FROM keyed
				WHERE conversation_id IN (SELECT conversation_id FROM folder_conversations)
				GROUP BY conversation_id
			),
			latest_message_per_conversation AS (
				SELECT
					conversation_id,
					folder_id,
					ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY date DESC) as rn
				FROM keyed
				WHERE conversation_id IN (SELECT conversation_id FROM folder_conversations)
			),
			latest_in_folder AS (
				SELECT
					k.*,
					ROW_NUMBER() OVER (PARTITION BY k.conversation_id ORDER BY k.date DESC) as rn
				FROM keyed k
				WHERE k.folder_id = ${folderIdSql}
			)
			SELECT
				lif.id, lif.subject, lif.sender, lif.sender_name, lif.recipient, lif.date,
				lif.read, CASE WHEN cs.thread_starred_count > 0 THEN 1 ELSE 0 END as starred, lif.thread_id, lif.folder_id,
				lif.in_reply_to, lif.email_references,
				SUBSTR(lif.body, 1, 300) as snippet,
				cs.thread_count, cs.thread_unread_count, cs.participants,
				CASE WHEN lmc.folder_id != 'sent'
					AND lmc.folder_id != 'draft'
					AND cs.thread_read_count > 0
					THEN 1 ELSE 0 END as needs_reply,
				CASE WHEN cs.has_draft > 0 THEN 1 ELSE 0 END as has_draft
			FROM latest_in_folder lif
			JOIN conversation_stats cs ON lif.conversation_id = cs.conversation_id
			LEFT JOIN latest_message_per_conversation lmc
				ON lmc.conversation_id = lif.conversation_id AND lmc.rn = 1
			WHERE lif.rn = 1 ${filter === "unread" ? "AND cs.thread_unread_count > 0" : filter === "starred" ? "AND cs.thread_starred_count > 0" : ""}
			ORDER BY lif.date DESC
			LIMIT ?2 OFFSET ?3`,
			folder, limit, offset
		);

		const rows = [...result];
		return rows.map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
			thread_count: row.thread_count || 1,
			thread_unread_count: row.thread_unread_count || 0,
			participants: row.participants || row.sender,
			needs_reply: !!row.needs_reply,
			has_draft: !!row.has_draft,
		}));
	}

	/**
	 * Count threaded conversations in a folder (for pagination).
	 * Returns the number of conversation groups, not individual emails.
	 */
	async countThreadedEmails(folder: string, filter?: ConversationFilter) {
		const isDraftFolder = folder === Folders.DRAFT;

		if (isDraftFolder) {
			const row = [
				...this.ctx.storage.sql.exec(
					`SELECT COUNT(DISTINCT COALESCE(in_reply_to, id)) as total
					 FROM emails
					 WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)`,
					folder,
				),
			][0] as { total: number } | undefined;
			return row?.total ?? 0;
		}

		const row = [
			...this.ctx.storage.sql.exec(
				`WITH ${KEYED_CTE},
				folder_conversations AS (
					SELECT DISTINCT conversation_id FROM keyed
					WHERE folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)
				)
				SELECT COUNT(*) as total FROM (
					SELECT conversation_id FROM keyed
					WHERE conversation_id IN (SELECT conversation_id FROM folder_conversations)
					GROUP BY conversation_id
					HAVING ${filter === "unread" ? "SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) > 0" : filter === "starred" ? "SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END) > 0" : "1"}
				)`,
				folder,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}

	// ── Single email operations (Drizzle) ──────────────────────────

	async getEmail(id: string) {
		const email = this.db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select()
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		return {
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: emailAttachments,
		};
	}

	/** Load full rows plus attachments for the given ids, oldest first. */
	#hydrateEmails(emailIds: string[]) {
		if (emailIds.length === 0) return [];
		const placeholders = emailIds.map((_, i) => `?${i + 1}`).join(",");
		const emailRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM emails WHERE id IN (${placeholders}) ORDER BY date ASC`,
				...emailIds,
			),
		] as any[];
		const attachmentRows = [
			...this.ctx.storage.sql.exec(
				`SELECT * FROM attachments WHERE email_id IN (${placeholders})`,
				...emailIds,
			),
		] as any[];

		const attachmentsByEmail = new Map<string, any[]>();
		for (const att of attachmentRows) {
			const list = attachmentsByEmail.get(att.email_id) || [];
			list.push(att);
			attachmentsByEmail.set(att.email_id, list);
		}

		return emailRows.map((email) => ({
			...email,
			read: !!email.read,
			starred: !!email.starred,
			attachments: attachmentsByEmail.get(email.id) || [],
		}));
	}

	/**
	 * Fetch all emails sharing a thread id with full bodies and attachments.
	 */
	async getThreadEmails(threadId: string) {
		const ids = [
			...this.ctx.storage.sql.exec(
				`SELECT id FROM emails WHERE thread_id = ?1`,
				threadId,
			),
		].map((r: any) => r.id as string);
		return this.#hydrateEmails(ids);
	}

	/**
	 * Fetch the whole Gmail-style conversation that contains `emailId`:
	 * every message with the same normalized subject and counterpart (or
	 * the same thread when there is no subject), oldest first.
	 */
	async getConversationEmails(emailId: string) {
		const ids = [
			...this.ctx.storage.sql.exec(
				`WITH ${KEYED_CTE}
				SELECT id FROM keyed
				WHERE conversation_id = (SELECT conversation_id FROM keyed WHERE id = ?1)`,
				emailId,
			),
		].map((r: any) => r.id as string);
		return this.#hydrateEmails(ids);
	}

	/** Ids of the conversation containing `emailId`, plus those in the same folder as it. */
	#conversationScope(emailId: string): { all: string[]; sameFolder: string[]; folderId: string | null } {
		const rows = [
			...this.ctx.storage.sql.exec(
				`WITH ${KEYED_CTE}
				SELECT id, folder_id FROM keyed
				WHERE conversation_id = (SELECT conversation_id FROM keyed WHERE id = ?1)`,
				emailId,
			),
		] as { id: string; folder_id: string }[];
		const self = rows.find((r) => r.id === emailId);
		const folderId = self?.folder_id ?? null;
		return {
			all: rows.map((r) => r.id),
			sameFolder: rows.filter((r) => r.folder_id === folderId).map((r) => r.id),
			folderId,
		};
	}

	#setFolder(ids: string[], folderId: string) {
		if (ids.length === 0) return;
		const ph = ids.map((_, i) => `?${i + 2}`).join(",");
		this.ctx.storage.sql.exec(`UPDATE emails SET folder_id = ?1 WHERE id IN (${ph})`, folderId, ...ids);
	}

	#folderExists(folderId: string): boolean {
		return [
			...this.ctx.storage.sql.exec("SELECT 1 AS x FROM folders WHERE id = ?1", folderId),
		].length > 0;
	}

	/**
	 * Apply one action to whole conversations, the way Gmail does.
	 *
	 * - archive / trash / move / delete act on the messages of the conversation
	 *   that live in the same folder as the selected email, so replies in Sent
	 *   stay where they are.
	 * - read marks the whole conversation read; unread marks only the selected
	 *   email unread; star marks the selected email; unstar clears every star.
	 * - move_messages moves exactly the given message ids (used for undo).
	 *
	 * Returns the ids it touched and, for delete, the attachments whose stored
	 * files the caller must remove.
	 */
	async applyConversationAction(
		emailIds: string[],
		action: "archive" | "trash" | "move" | "delete" | "read" | "unread" | "star" | "unstar" | "move_messages",
		folderId?: string,
	) {
		const affected = new Set<string>();
		const removedAttachments: { emailId: string; id: string; filename: string }[] = [];
		let originalFolder: string | null = null;

		if (action === "move_messages") {
			if (!folderId || !this.#folderExists(folderId)) return { affected: [], removedAttachments, originalFolder };
			this.#setFolder(emailIds, folderId);
			return { affected: emailIds, removedAttachments, originalFolder };
		}

		for (const emailId of new Set(emailIds)) {
			const scope = this.#conversationScope(emailId);
			if (!scope.folderId) continue;
			originalFolder ??= scope.folderId;

			switch (action) {
				case "archive":
				case "trash":
				case "move": {
					const target = action === "move" ? folderId : action === "archive" ? Folders.ARCHIVE : Folders.TRASH;
					if (!target || !this.#folderExists(target)) break;
					this.#setFolder(scope.sameFolder, target);
					scope.sameFolder.forEach((id) => affected.add(id));
					break;
				}
				case "delete": {
					for (const id of scope.sameFolder) {
						const attachmentsOfEmail = await this.deleteEmail(id);
						for (const att of attachmentsOfEmail ?? []) {
							removedAttachments.push({ emailId: id, id: att.id, filename: att.filename });
						}
						affected.add(id);
					}
					break;
				}
				case "read": {
					const ph = scope.all.map((_, i) => `?${i + 1}`).join(",");
					this.ctx.storage.sql.exec(`UPDATE emails SET read = 1 WHERE read = 0 AND id IN (${ph})`, ...scope.all);
					scope.all.forEach((id) => affected.add(id));
					break;
				}
				case "unread":
					this.ctx.storage.sql.exec("UPDATE emails SET read = 0 WHERE id = ?1", emailId);
					affected.add(emailId);
					break;
				case "star":
					this.ctx.storage.sql.exec("UPDATE emails SET starred = 1 WHERE id = ?1", emailId);
					affected.add(emailId);
					break;
				case "unstar": {
					const ph = scope.all.map((_, i) => `?${i + 1}`).join(",");
					this.ctx.storage.sql.exec(`UPDATE emails SET starred = 0 WHERE starred = 1 AND id IN (${ph})`, ...scope.all);
					scope.all.forEach((id) => affected.add(id));
					break;
				}
			}
		}
		return { affected: [...affected], removedAttachments, originalFolder };
	}

	/** Mark every unread message in a folder as read. */
	async markFolderRead(folder: string) {
		this.ctx.storage.sql.exec(
			"UPDATE emails SET read = 1 WHERE read = 0 AND folder_id = (SELECT id FROM folders WHERE name = ?1 OR id = ?1 LIMIT 1)",
			folder,
		);
		return { folder, markedRead: true };
	}

	/** Permanently delete everything in Trash or Spam; returns attachments to purge. */
	async emptyFolder(folder: string) {
		if (folder !== Folders.TRASH && folder !== Folders.SPAM) return null;
		const ids = [
			...this.ctx.storage.sql.exec("SELECT id FROM emails WHERE folder_id = ?1", folder),
		].map((r: any) => r.id as string);
		const removedAttachments: { emailId: string; id: string; filename: string }[] = [];
		for (const id of ids) {
			const attachmentsOfEmail = await this.deleteEmail(id);
			for (const att of attachmentsOfEmail ?? []) {
				removedAttachments.push({ emailId: id, id: att.id, filename: att.filename });
			}
		}
		return { deleted: ids.length, removedAttachments };
	}

	/** Mark every unread message of the conversation containing `emailId` as read. */
	async markConversationRead(emailId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE read = 0 AND id IN (
				WITH ${KEYED_CTE}
				SELECT id FROM keyed
				WHERE conversation_id = (SELECT conversation_id FROM keyed WHERE id = ?1)
			)`,
			emailId,
		);
		return { emailId, markedRead: true };
	}

	async updateEmail(
		id: string,
		{ read, starred }: { read?: boolean; starred?: boolean },
	) {
		const data: { read?: number; starred?: number } = {};
		if (read !== undefined) {
			data.read = read ? 1 : 0;
		}
		if (starred !== undefined) {
			data.starred = starred ? 1 : 0;
		}

		if (Object.keys(data).length === 0) {
			return this.getEmail(id);
		}

		this.db
			.update(schema.emails)
			.set(data)
			.where(eq(schema.emails.id, id))
			.run();

		return this.getEmail(id);
	}

	async markThreadRead(threadId: string) {
		this.ctx.storage.sql.exec(
			`UPDATE emails SET read = 1 WHERE thread_id = ? AND read = 0`,
			threadId,
		);
		return { threadId, markedRead: true };
	}

	async deleteEmail(id: string) {
		const email = this.db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.id, id))
			.get();

		if (!email) return null;

		const emailAttachments = this.db
			.select({
				id: schema.attachments.id,
				filename: schema.attachments.filename,
			})
			.from(schema.attachments)
			.where(eq(schema.attachments.email_id, id))
			.all();

		this.db
			.delete(schema.emails)
			.where(eq(schema.emails.id, id))
			.run();

		return emailAttachments;
	}

	async getAttachment(id: string) {
		return (
			this.db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.id, id))
				.get() ?? null
		);
	}

	// ── Folders (Drizzle) ──────────────────────────────────────────

	async getFolders() {
		const result = this.db
			.select({
				id: schema.folders.id,
				name: schema.folders.name,
				unreadCount: sql<number>`COALESCE(SUM(CASE WHEN ${schema.emails.read} = 0 THEN 1 ELSE 0 END), 0)`.mapWith(Number),
			})
			.from(schema.folders)
			.leftJoin(schema.emails, eq(schema.emails.folder_id, schema.folders.id))
			.groupBy(schema.folders.id, schema.folders.name)
			.all();
		return result;
	}

	async createFolder(id: string, name: string, is_deletable: number = 1) {
		try {
			const result = this.db
				.insert(schema.folders)
				.values({ id, name, is_deletable })
				.returning({ id: schema.folders.id, name: schema.folders.name })
				.get();
			return { ...result, unreadCount: 0 };
		} catch (e: unknown) {
			if (e instanceof Error && e.message.includes("UNIQUE constraint failed")) {
				return null;
			}
			throw e;
		}
	}

	async updateFolder(id: string, name: string) {
		const result = this.db
			.update(schema.folders)
			.set({ name })
			.where(eq(schema.folders.id, id))
			.returning({ id: schema.folders.id, name: schema.folders.name })
			.get();
		return result;
	}

	async deleteFolder(id: string) {
		const folder = this.db
			.select({ is_deletable: schema.folders.is_deletable })
			.from(schema.folders)
			.where(eq(schema.folders.id, id))
			.get();

		if (!folder || folder.is_deletable === 0) {
			return false;
		}

		this.db
			.delete(schema.folders)
			.where(eq(schema.folders.id, id))
			.run();

		return true;
	}

	async moveEmail(id: string, folderId: string) {
		const folder = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(eq(schema.folders.id, folderId))
			.get();

		if (!folder) return false;

		this.db
			.update(schema.emails)
			.set({ folder_id: folderId })
			.where(eq(schema.emails.id, id))
			.run();

		return true;
	}

	// ── Search (raw SQL — dynamic condition builder) ───────────────

	/**
	 * Build WHERE conditions and params for search queries.
	 * Shared between searchEmails and countSearchResults.
	 */
	#buildSearchConditions(
		options: SearchFilterOptions,
		tableAlias = "",
	): { conditions: string[]; params: (string | number)[] } {
		const { query, folder, from, contact, to, subject, date_start, date_end, is_read, is_starred, has_attachment } = options;
		const prefix = tableAlias ? `${tableAlias}.` : "";
		const conditions: string[] = [];
		const params: (string | number)[] = [];
		let paramIdx = 0;

		const addParam = (value: string | number) => {
			paramIdx++;
			params.push(value);
			return `?${paramIdx}`;
		};

		if (query) {
			const p1 = addParam(`%${query}%`);
			const p2 = addParam(`%${query}%`);
			const p3 = addParam(`%${query}%`);
			const p4 = addParam(`%${query}%`);
			conditions.push(`(${prefix}subject LIKE ${p1} OR ${prefix}body LIKE ${p2} OR ${prefix}sender LIKE ${p3} OR ${prefix}recipient LIKE ${p4} OR ${prefix}cc LIKE ${p4} OR ${prefix}bcc LIKE ${p4})`);
		}
		if (folder) {
			const p = addParam(folder);
			conditions.push(`${prefix}folder_id = (SELECT id FROM folders WHERE name = ${p} OR id = ${p} LIMIT 1)`);
		}
		if (from) { const p = addParam(`%${from}%`); conditions.push(`${prefix}sender LIKE ${p}`); }
		if (contact) {
			// Match a contact by address or name, expanded to every address
			// merged into the same contact (see contact_aliases).
			const p = addParam(`%${contact}%`);
			const group = `SELECT canonical FROM contact_aliases WHERE email LIKE ${p} OR canonical LIKE ${p}`;
			const members = `SELECT email FROM contact_aliases WHERE canonical IN (${group}) UNION SELECT canonical FROM contact_aliases WHERE canonical IN (${group})`;
			conditions.push(
				`(${prefix}sender LIKE ${p} OR ${prefix}sender_name LIKE ${p} OR ${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p}` +
				` OR ${prefix}sender IN (${members})` +
				` OR EXISTS (SELECT 1 FROM (${members}) mm WHERE ${prefix}recipient LIKE '%' || mm.email || '%'))`,
			);
		}
		if (to) { const p = addParam(`%${to}%`); conditions.push(`(${prefix}recipient LIKE ${p} OR ${prefix}cc LIKE ${p} OR ${prefix}bcc LIKE ${p})`); }
		if (subject) { const p = addParam(`%${subject}%`); conditions.push(`${prefix}subject LIKE ${p}`); }
		if (date_start) { const p = addParam(date_start); conditions.push(`${prefix}date >= ${p}`); }
		if (date_end) { const p = addParam(date_end); conditions.push(`${prefix}date <= ${p}`); }
		if (is_read !== undefined) { const p = addParam(is_read ? 1 : 0); conditions.push(`${prefix}read = ${p}`); }
		if (is_starred !== undefined) { const p = addParam(is_starred ? 1 : 0); conditions.push(`${prefix}starred = ${p}`); }
		if (has_attachment) { conditions.push(`${prefix}id IN (SELECT DISTINCT email_id FROM attachments)`); }

		return { conditions, params };
	}

	async searchEmails(options: SearchFilterOptions & { page?: number; limit?: number }) {
		const { page = 1, limit: rawLimit = 25 } = options;
		const limit = Math.min(Math.max(rawLimit, 1), 100);
		const { conditions, params } = this.#buildSearchConditions(options, "e");

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const offset = (page - 1) * limit;

		const query = `
			SELECT e.id, e.subject, e.sender, e.sender_name, e.recipient, e.cc, e.bcc, e.date,
				e.read, e.starred, e.in_reply_to, e.email_references,
				e.thread_id, e.folder_id,
				SUBSTR(e.body, 1, 300) as snippet,
				f.name as folder_name
			FROM emails e
			LEFT JOIN folders f ON e.folder_id = f.id
			${where}
			ORDER BY e.date DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
		params.push(limit, offset);

		const result = this.ctx.storage.sql.exec(query, ...params);
		return [...result].map((row: any) => ({
			...row,
			read: !!row.read,
			starred: !!row.starred,
		}));
	}

	/**
	 * Count total search results matching the given filters (for pagination).
	 */
	async countSearchResults(options: SearchFilterOptions) {
		const { conditions, params } = this.#buildSearchConditions(options);

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const query = `SELECT COUNT(*) as total FROM emails ${where}`;

		const row = [...this.ctx.storage.sql.exec(query, ...params)][0] as
			| { total: number }
			| undefined;
		return row?.total ?? 0;
	}

	// ── Contacts ───────────────────────────────────────────────────

	/** Canonical address for an email address (itself unless merged). */
	#canonicalOf(address: string): string {
		const row = [
			...this.ctx.storage.sql.exec(
				"SELECT canonical FROM contact_aliases WHERE email = ?1",
				address,
			),
		][0] as { canonical: string } | undefined;
		return row?.canonical ?? address;
	}

	/** Every address belonging to the same contact, canonical first. */
	#contactAddresses(address: string): string[] {
		const canonical = this.#canonicalOf(address);
		const aliases = [
			...this.ctx.storage.sql.exec(
				"SELECT email FROM contact_aliases WHERE canonical = ?1 ORDER BY email",
				canonical,
			),
		] as { email: string }[];
		return [canonical, ...aliases.map((a) => a.email)];
	}

	/**
	 * Aggregate view of one contact: all merged addresses, display name,
	 * message statistics and every conversation they take part in.
	 */
	async getContact(rawAddress: string) {
		const address = rawAddress.trim().toLowerCase();
		const addresses = this.#contactAddresses(address);
		const canonical = addresses[0];

		const senderPh = addresses.map(() => "?").join(",");
		const involved =
			`(sender IN (${senderPh}) OR ` +
			addresses.map(() => "recipient LIKE ?").join(" OR ") +
			")";
		const involvedParams = [...addresses, ...addresses.map((a) => `%${a}%`)];

		const nameRow = [
			...this.ctx.storage.sql.exec(
				`SELECT sender_name FROM emails
				 WHERE sender IN (${senderPh}) AND sender_name IS NOT NULL AND sender_name != ''
				 ORDER BY date DESC LIMIT 1`,
				...addresses,
			),
		][0] as { sender_name: string } | undefined;

		const stats = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) AS total,
					SUM(CASE WHEN sender IN (${senderPh}) THEN 1 ELSE 0 END) AS received,
					MIN(date) AS first_date, MAX(date) AS last_date
				 FROM emails WHERE folder_id != ? AND ${involved}`,
				...addresses,
				Folders.TRASH,
				...involvedParams,
			),
		][0] as any;

		const conversations = [
			...this.ctx.storage.sql.exec(
				`WITH ${KEYED_CTE}, m AS (
					SELECT id, subject, date, read, folder_id, conversation_id AS tkey,
						SUBSTR(body, 1, 300) AS snippet
					FROM keyed WHERE folder_id != ? AND ${involved}
				), latest AS (
					SELECT *,
						ROW_NUMBER() OVER (PARTITION BY tkey ORDER BY date DESC) AS rn,
						COUNT(*) OVER (PARTITION BY tkey) AS message_count,
						SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY tkey) AS unread_count
					FROM m
				)
				SELECT id, subject, date, folder_id, snippet, message_count, unread_count
				FROM latest WHERE rn = 1 ORDER BY date DESC LIMIT 50`,
				Folders.TRASH,
				...involvedParams,
			),
		] as any[];

		return {
			email: canonical,
			name: nameRow?.sender_name ?? null,
			domain: canonical.includes("@") ? canonical.split("@")[1] : "",
			addresses,
			stats: {
				total_messages: stats?.total ?? 0,
				received_messages: stats?.received ?? 0,
				first_date: stats?.first_date ?? null,
				last_date: stats?.last_date ?? null,
				conversation_count: conversations.length,
			},
			conversations: conversations.map((c) => ({
				...c,
				unread_count: c.unread_count ?? 0,
			})),
		};
	}

	/** Treat `address` as another address of the contact that owns `into`. */
	async mergeContact(address: string, into: string) {
		const source = this.#canonicalOf(address.trim().toLowerCase());
		const target = this.#canonicalOf(into.trim().toLowerCase());
		if (!source || !target || source === target) return false;
		this.ctx.storage.sql.exec(
			"UPDATE contact_aliases SET canonical = ?1 WHERE canonical = ?2",
			target,
			source,
		);
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO contact_aliases (email, canonical) VALUES (?1, ?2)",
			source,
			target,
		);
		return true;
	}

	/** Detach a merged alias from its contact. */
	async unmergeContact(address: string) {
		const addr = address.trim().toLowerCase();
		const exists = [
			...this.ctx.storage.sql.exec("SELECT 1 AS x FROM contact_aliases WHERE email = ?1", addr),
		].length;
		if (!exists) return false;
		this.ctx.storage.sql.exec("DELETE FROM contact_aliases WHERE email = ?1", addr);
		return true;
	}

	// ── Threading helpers (raw SQL) ────────────────────────────────

	async findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null> {
		const normalized = subject
			.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
			.trim()
			.toLowerCase();

		if (!normalized) return null;

		const result = this.ctx.storage.sql.exec(
			`SELECT thread_id, subject,
			        GROUP_CONCAT(DISTINCT LOWER(sender)) as senders,
			        GROUP_CONCAT(DISTINCT LOWER(recipient)) as recipients
			 FROM emails
			 WHERE thread_id IS NOT NULL
			   AND thread_id != id
			   AND date >= datetime('now', '-7 days')
			 GROUP BY thread_id
			 ORDER BY MAX(date) DESC
			 LIMIT 50`,
		);

		const normalizedSender = senderAddress?.toLowerCase().trim();

		for (const row of result) {
			const rowSubject = String((row as any).subject || "")
				.replace(/^(?:(?:re|fwd?|fw|aw|wg|r[eé]f|sv)\s*:\s*)+/i, "")
				.trim()
				.toLowerCase();
			if (rowSubject !== normalized) continue;

			if (normalizedSender) {
				const threadSenders = String((row as any).senders || "");
				const threadRecipients = String((row as any).recipients || "");
				const allParticipants = `${threadSenders},${threadRecipients}`;
				if (!allParticipants.includes(normalizedSender)) {
					continue;
				}
			}

			return String((row as any).thread_id);
		}
		return null;
	}

	// ── Rate limiting (raw SQL) ────────────────────────────────────

	/**
	 * Check if the mailbox has exceeded the send rate limit.
	 * Limits: 20 emails per hour, 100 per day per mailbox.
	 * Returns null if under limit, or an error message string if exceeded.
	 */
	async checkSendRateLimit(): Promise<string | null> {
		const hourRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 hour')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((hourRow?.cnt ?? 0) >= 20) {
			return "Rate limit exceeded: max 20 emails per hour per mailbox";
		}

		const dayRow = [...this.ctx.storage.sql.exec(
			`SELECT COUNT(*) as cnt FROM emails
			 WHERE folder_id = ?1
			   AND date >= datetime('now', '-1 day')`,
			Folders.SENT,
		)][0] as { cnt: number } | undefined;

		if ((dayRow?.cnt ?? 0) >= 100) {
			return "Rate limit exceeded: max 100 emails per day per mailbox";
		}

		return null;
	}

	// ── Email creation (Drizzle) ───────────────────────────────────

	async createEmail(
		folder: string,
		email: EmailData,
		attachments: AttachmentData[],
	) {
		// Resolve folder name or ID to the actual folder ID.
		const folderRow = this.db
			.select({ id: schema.folders.id })
			.from(schema.folders)
			.where(or(eq(schema.folders.id, folder), eq(schema.folders.name, folder)))
			.limit(1)
			.get();

		if (!folderRow) {
			throw new Error(
				`createEmail: folder "${folder}" not found. ` +
					"Ensure the folder exists before inserting an email.",
			);
		}

		const folderId = folderRow.id;
		const isSent = folderId === Folders.SENT;

		// Sent emails are always read — the sender obviously knows what they wrote.
		// This prevents sent replies from inflating thread_unread_count.
		this.db
			.insert(schema.emails)
			.values({
				id: email.id,
				folder_id: folderId,
				subject: email.subject,
				sender: email.sender,
				sender_name: email.sender_name ?? null,
				recipient: email.recipient,
				cc: email.cc ?? null,
				bcc: email.bcc ?? null,
				date: email.date,
				read: isSent ? 1 : (email.read ? 1 : 0),
				starred: email.starred ? 1 : 0,
				body: email.body,
				in_reply_to: email.in_reply_to ?? null,
				email_references: email.email_references ?? null,
				thread_id: email.thread_id ?? null,
				message_id: email.message_id ?? null,
				raw_headers: email.raw_headers ?? null,
			})
			.run();

		if (attachments.length > 0) {
			this.db.insert(schema.attachments).values(attachments).run();
		}
	}
}
