CREATE TABLE `cut_highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`cut_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`score` integer NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`exported_path` text,
	`exported_at` integer,
	FOREIGN KEY (`cut_id`) REFERENCES `cuts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cut_highlights_cut_idx` ON `cut_highlights` (`cut_id`);--> statement-breakpoint
CREATE TABLE `cuts` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source` text NOT NULL,
	`authorized_at` integer NOT NULL,
	`title` text,
	`language` text,
	`media_path` text,
	`transcript_path` text,
	`duration_s` real,
	`cost_cents` real DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
