ALTER TABLE `images` ADD `embedding_model` text;--> statement-breakpoint
ALTER TABLE `images` ADD `description` text;--> statement-breakpoint
ALTER TABLE `images` ADD `source_id` text;--> statement-breakpoint
ALTER TABLE `images` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `images_source_idx` ON `images` (`source`,`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `images_path_idx` ON `images` (`path`);