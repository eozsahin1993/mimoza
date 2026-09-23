CREATE TABLE `activity` (
	`id` text PRIMARY KEY NOT NULL,
	`circle_id` text NOT NULL,
	`event` text NOT NULL,
	`actor_id` text NOT NULL,
	`subject_id` text,
	`subject_name` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_circle_received` ON `activity` (`circle_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`circle_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` blob,
	`hash` text,
	`key_version` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`fetch_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`circle_id`, `entry_id`),
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `circle_members` (
	`circle_id` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`avatar_id` text,
	`avatar_key_version` integer,
	`public_key` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` integer DEFAULT 0 NOT NULL,
	`left_at` integer,
	`needs_rewrap` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`circle_id`, `account_id`),
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `circles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`notify_level` text DEFAULT 'all' NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`roster_version` integer DEFAULT 0 NOT NULL,
	`last_entry_at` integer DEFAULT 0 NOT NULL,
	`cover_id` text,
	`needs_rewrap` integer DEFAULT false NOT NULL,
	`posts_forward_cursor` text,
	`posts_backward_cursor` text,
	`activity_cursor` text,
	`created_at` integer NOT NULL,
	`last_viewed_at` integer DEFAULT 0 NOT NULL,
	`left_at` integer
);
--> statement-breakpoint
CREATE TABLE `device_profile` (
	`account_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`picture` blob,
	`device_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`circle_id` text NOT NULL,
	`op` text NOT NULL,
	`post_id` text,
	`entry_id` text,
	`plaintext` text DEFAULT '{}' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_circle_status` ON `outbox` (`circle_id`,`status`);--> statement-breakpoint
CREATE TABLE `pending_requests` (
	`circle_id` text PRIMARY KEY NOT NULL,
	`invite_code` text NOT NULL,
	`circle_name` text DEFAULT '' NOT NULL,
	`invited_by_name` text DEFAULT '' NOT NULL,
	`submitted_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`circle_id` text NOT NULL,
	`author_id` text NOT NULL,
	`parent_comment_id` text,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`pending` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_comments_post_created` ON `post_comments` (`post_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `post_reactions` (
	`post_id` text NOT NULL,
	`circle_id` text NOT NULL,
	`account_id` text NOT NULL,
	`tag` text NOT NULL,
	`emoji` text DEFAULT '' NOT NULL,
	`key_version` integer,
	`created_at` integer NOT NULL,
	`pending_op` text,
	PRIMARY KEY(`post_id`, `account_id`, `tag`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`circle_id` text NOT NULL,
	`author_id` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`received_at` integer NOT NULL,
	`in_album` integer DEFAULT true NOT NULL,
	`deleted_at` integer,
	`last_viewed_at` integer,
	`children_fetched_at` integer,
	`updated_at` integer DEFAULT 0 NOT NULL,
	`comment_count` integer DEFAULT 0 NOT NULL,
	`reaction_counts` text DEFAULT '{}' NOT NULL,
	`unnamed_reactions` integer DEFAULT 0 NOT NULL,
	`recent_comment_ids` text DEFAULT '[]' NOT NULL,
	`i_reacted` integer DEFAULT false NOT NULL,
	`i_commented` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `posts_circle_created` ON `posts` (`circle_id`,`created_at`);