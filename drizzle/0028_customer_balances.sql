CREATE TABLE `customer_balance_site_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`username` text NOT NULL,
	`password_cipher` text NOT NULL,
	`access_token` text,
	`platform_user_id` text,
	`token_expires_at` integer,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (datetime('now')),
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_balance_site_accounts_site_unique` ON `customer_balance_site_accounts` (`site_id`);--> statement-breakpoint
CREATE INDEX `customer_balance_site_accounts_site_id_idx` ON `customer_balance_site_accounts` (`site_id`);--> statement-breakpoint
CREATE INDEX `customer_balance_site_accounts_last_synced_at_idx` ON `customer_balance_site_accounts` (`last_synced_at`);--> statement-breakpoint
CREATE TABLE `customer_balance_snapshot_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_id` integer NOT NULL,
	`upstream_user_id` text NOT NULL,
	`username` text,
	`email` text,
	`display_name` text,
	`role` text,
	`status` text,
	`balance` real DEFAULT 0 NOT NULL,
	`used` real DEFAULT 0 NOT NULL,
	`quota` real DEFAULT 0 NOT NULL,
	`group_name` text,
	`created_at` text,
	`last_active_at` text,
	`raw_payload` text,
	FOREIGN KEY (`snapshot_id`) REFERENCES `customer_balance_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_balance_snapshot_users_snapshot_user_unique` ON `customer_balance_snapshot_users` (`snapshot_id`,`upstream_user_id`);--> statement-breakpoint
CREATE INDEX `customer_balance_snapshot_users_snapshot_balance_idx` ON `customer_balance_snapshot_users` (`snapshot_id`,`balance`);--> statement-breakpoint
CREATE INDEX `customer_balance_snapshot_users_snapshot_status_idx` ON `customer_balance_snapshot_users` (`snapshot_id`,`status`);--> statement-breakpoint
CREATE TABLE `customer_balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_account_id` integer NOT NULL,
	`site_id` integer NOT NULL,
	`platform` text NOT NULL,
	`total_users` integer DEFAULT 0 NOT NULL,
	`active_users` integer DEFAULT 0 NOT NULL,
	`total_balance` real DEFAULT 0 NOT NULL,
	`low_balance_users` integer DEFAULT 0 NOT NULL,
	`negative_balance_users` integer DEFAULT 0 NOT NULL,
	`zero_balance_users` integer DEFAULT 0 NOT NULL,
	`raw_payload` text,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`site_account_id`) REFERENCES `customer_balance_site_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_balance_snapshots_site_created_at_idx` ON `customer_balance_snapshots` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `customer_balance_snapshots_account_created_at_idx` ON `customer_balance_snapshots` (`site_account_id`,`created_at`);
