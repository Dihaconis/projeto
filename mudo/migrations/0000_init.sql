CREATE TABLE `acts` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`n` integer NOT NULL,
	`heading` text NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `audio_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mood` text,
	`license` text,
	`requires_credit` integer DEFAULT false NOT NULL,
	`credit_text` text
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`niche` text NOT NULL,
	`language` text NOT NULL,
	`voice_id` text,
	`tts_provider` text,
	`style_preset` text,
	`music_mood` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credits` (
	`video_id` text NOT NULL,
	`text` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`video_id`, `position`),
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	`source_url` text,
	`author` text,
	`license` text,
	`requires_credit` integer DEFAULT false NOT NULL,
	`credit_text` text,
	`phash` text,
	`embedding` blob,
	`tags` text,
	`width` integer,
	`height` integer,
	`used_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `images_phash_idx` ON `images` (`phash`);--> statement-breakpoint
CREATE INDEX `images_last_used_at_idx` ON `images` (`last_used_at`);--> statement-breakpoint
CREATE TABLE `job_procs` (
	`job_id` text NOT NULL,
	`pid` integer NOT NULL,
	`command` text NOT NULL,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `pid`),
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
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
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`stage_timings` text NOT NULL,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`updated_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE TABLE `provider_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`stage` text,
	`video_id` text,
	`outcome` text NOT NULL,
	`tokens_in` integer,
	`tokens_out` integer,
	`chars` integer,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`act_id` text NOT NULL,
	`n` integer NOT NULL,
	`text` text NOT NULL,
	`image_query` text,
	`image_id` text,
	`audio_path` text,
	`start_ms` integer,
	`end_ms` integer,
	`motion` text,
	`approved` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`act_id`) REFERENCES `acts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scenes_video_id_idx` ON `scenes` (`video_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage` (
	`month` text PRIMARY KEY NOT NULL,
	`videos_used` integer DEFAULT 0 NOT NULL,
	`cuts_used` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `videos` (
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
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`output_path` text,
	`thumb_path` text,
	`gen_time_s` real,
	`created_at` integer DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
