PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`video_id` text,
	`state` text NOT NULL,
	`stage` text,
	`progress` real DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`payload` text NOT NULL,
	`checkpoint` text NOT NULL,
	`last_error` text,
	`locked_by` text,
	`locked_at` integer,
	`heartbeat_at` integer,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`stage_timings` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_jobs`("id", "kind", "video_id", "state", "stage", "progress", "attempt", "max_attempts", "payload", "checkpoint", "last_error", "locked_by", "locked_at", "heartbeat_at", "cost_cents", "stage_timings", "created_at", "updated_at", "finished_at") SELECT "id", "kind", "video_id", "state", "stage", "progress", "attempt", "max_attempts", "payload", "checkpoint", "last_error", "locked_by", "locked_at", "heartbeat_at", "cost_cents", "stage_timings", "created_at", "updated_at", "finished_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE TABLE `__new_provider_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`stage` text,
	`video_id` text,
	`outcome` text NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`chars` integer,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_provider_log`("id", "provider", "model", "stage", "video_id", "outcome", "tokens_in", "tokens_out", "chars", "cost_cents", "latency_ms", "created_at") SELECT "id", "provider", "model", "stage", "video_id", "outcome", "tokens_in", "tokens_out", "chars", "cost_cents", "latency_ms", "created_at" FROM `provider_log`;--> statement-breakpoint
DROP TABLE `provider_log`;--> statement-breakpoint
ALTER TABLE `__new_provider_log` RENAME TO `provider_log`;--> statement-breakpoint
CREATE TABLE `__new_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`theme` text NOT NULL,
	`language` text NOT NULL,
	`target_duration_s` integer NOT NULL,
	`actual_duration_s` real,
	`state` text NOT NULL,
	`stage` text,
	`progress` real DEFAULT 0 NOT NULL,
	`title` text,
	`description` text,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`output_path` text,
	`thumb_path` text,
	`gen_time_s` real,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_videos`("id", "channel_id", "theme", "language", "target_duration_s", "actual_duration_s", "state", "stage", "progress", "title", "description", "cost_cents", "output_path", "thumb_path", "gen_time_s", "created_at", "finished_at") SELECT "id", "channel_id", "theme", "language", "target_duration_s", "actual_duration_s", "state", "stage", "progress", "title", "description", "cost_cents", "output_path", "thumb_path", "gen_time_s", "created_at", "finished_at" FROM `videos`;--> statement-breakpoint
DROP TABLE `videos`;--> statement-breakpoint
ALTER TABLE `__new_videos` RENAME TO `videos`;