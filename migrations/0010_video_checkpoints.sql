CREATE TABLE `video_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` text NOT NULL,
	`name` text,
	`auto` integer DEFAULT false NOT NULL,
	`reason` text,
	`storyboard` text NOT NULL,
	`resolved` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_checkpoints_video_idx` ON `video_checkpoints` (`video_id`,`created_at`);