CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`at_sec` real,
	`scene_id` text,
	`x` real,
	`y` real,
	`tag` text,
	`body` text NOT NULL,
	`resolution` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_comments_review_idx` ON `review_comments` (`review_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`ask` text,
	`aspect` text NOT NULL,
	`draft_id` text,
	`media_key` text,
	`from_sec` real DEFAULT 0 NOT NULL,
	`to_sec` real,
	`scenes` text DEFAULT '[]' NOT NULL,
	`storyboard_hash` text,
	`verdict` text,
	`summary` text,
	`reviewer_name` text,
	`submitted_at` integer,
	`read_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reviews_video_idx` ON `reviews` (`video_id`);--> statement-breakpoint
CREATE INDEX `reviews_project_idx` ON `reviews` (`project_id`,`status`);--> statement-breakpoint
ALTER TABLE `renders` ADD `poster_key` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `thumbnail_asset_id` text;