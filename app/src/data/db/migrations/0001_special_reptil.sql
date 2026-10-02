DROP TABLE `device_profile`;--> statement-breakpoint
ALTER TABLE `circle_members` DROP COLUMN `avatar_id`;--> statement-breakpoint
ALTER TABLE `circle_members` DROP COLUMN `avatar_key_version`;
--> statement-breakpoint
CREATE TABLE `local_account` (
	`account_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`device_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `circle_members` ADD `profile_picture_id` text;
--> statement-breakpoint
CREATE TABLE `profile_pictures` (
	`account_id` text PRIMARY KEY NOT NULL,
	`picture_id` text NOT NULL,
	`bytes` blob,
	`status` text DEFAULT 'pending' NOT NULL,
	`fetch_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL
);
