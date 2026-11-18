CREATE TABLE `billing_credits` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`note` text,
	`granted_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `billing_credits_user_idx` ON `billing_credits` (`user_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`period` text NOT NULL,
	`cost_micros` integer NOT NULL,
	`markup` real NOT NULL,
	`charge_cents` integer NOT NULL,
	`credit_cents` integer DEFAULT 0 NOT NULL,
	`amount_due_cents` integer NOT NULL,
	`status` text NOT NULL,
	`stripe_invoice_id` text,
	`hosted_url` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_user_period_idx` ON `invoices` (`user_id`,`period`);--> statement-breakpoint
CREATE INDEX `invoices_stripe_idx` ON `invoices` (`stripe_invoice_id`);--> statement-breakpoint
ALTER TABLE `user` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `billing_status` text DEFAULT 'none';--> statement-breakpoint
-- Every account gets a spend cap: accounts on the old $25 default (or none) move to the new $10 default. Caps set by hand are kept.
UPDATE `user` SET `monthly_budget_cents` = 1000 WHERE `monthly_budget_cents` IS NULL OR `monthly_budget_cents` = 2500;
