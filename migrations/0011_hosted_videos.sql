CREATE TABLE `hosted_videos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`render_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stream_uid` text,
	`stream_host` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`captions_language` text,
	`chapters` text DEFAULT '[]' NOT NULL,
	`credits` text DEFAULT '[]' NOT NULL,
	`poster_key` text,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`duration_sec` real,
	`error` text,
	`warnings` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `hosted_videos_video_idx` ON `hosted_videos` (`video_id`);--> statement-breakpoint
CREATE INDEX `hosted_videos_user_idx` ON `hosted_videos` (`user_id`);--> statement-breakpoint
CREATE INDEX `hosted_videos_project_idx` ON `hosted_videos` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `hosted_videos_stream_idx` ON `hosted_videos` (`stream_uid`);