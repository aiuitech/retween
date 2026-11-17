ALTER TABLE `usage_events` ADD `basis` text DEFAULT 'list' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `vendor_ref` text;--> statement-breakpoint
CREATE INDEX `usage_created_idx` ON `usage_events` (`created_at`);--> statement-breakpoint
-- Existing rows: not estimated meant the vendor reported the cost; render rows were measured container seconds.
UPDATE `usage_events` SET `basis` = 'vendor' WHERE `estimated` = 0;--> statement-breakpoint
UPDATE `usage_events` SET `basis` = 'metered', `estimated` = 0 WHERE `kind` = 'render';
