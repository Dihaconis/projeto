CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`video_id` text NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
