CREATE TABLE `youtube_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`handle` text,
	`thumbnail_url` text,
	`refresh_token` text NOT NULL,
	`access_token` text,
	`access_token_expires_at` integer,
	`scope` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `youtube_channels_user_channel_idx` ON `youtube_channels` (`user_id`,`channel_id`);--> statement-breakpoint
CREATE TABLE `youtube_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`render_id` text NOT NULL,
	`connection_id` text,
	`channel_id` text NOT NULL,
	`channel_title` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress_pct` integer DEFAULT 0 NOT NULL,
	`request` text NOT NULL,
	`youtube_video_id` text,
	`error` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `youtube_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `youtube_uploads_video_idx` ON `youtube_uploads` (`video_id`);--> statement-breakpoint
CREATE INDEX `youtube_uploads_user_idx` ON `youtube_uploads` (`user_id`);