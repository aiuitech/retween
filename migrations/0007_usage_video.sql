ALTER TABLE `usage_events` ADD `video_id` text;--> statement-breakpoint
CREATE INDEX `usage_video_idx` ON `usage_events` (`video_id`);--> statement-breakpoint
-- Existing rows: renders charge the video they rendered; generated media charges the video that still uses it.
-- Media a video replaced (and deleted) before this column existed cannot be traced and stays unattributed.
UPDATE `usage_events` SET `video_id` = (SELECT `video_id` FROM `renders` WHERE `renders`.`id` = `usage_events`.`ref`)
WHERE `kind` = 'render' AND `video_id` IS NULL;--> statement-breakpoint
UPDATE `usage_events` SET `video_id` = (
	SELECT `videos`.`id` FROM `videos`, json_tree(`videos`.`resolved`) AS `entry`
	WHERE `entry`.`key` = 'assetId' AND `entry`.`value` = `usage_events`.`ref`
	ORDER BY `videos`.`created_at` LIMIT 1
)
WHERE `video_id` IS NULL AND `ref` LIKE 'ast\_%' ESCAPE '\';
