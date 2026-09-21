/**
 * Bit layout of the category mask the relay stores per circle routing:
 *
 *     bit 0   newPost
 *     bit 1   comment
 *     bit 2   reaction
 *     bit 3   memberJoined
 *
 * Positions are permanent. Masks written with this layout are already on
 * devices and in relay rows, so moving one changes what every stored mask
 * means — someone who asked for comments starts getting reactions, and
 * nothing errors. Add at the next free bit; never edit a line above.
 *
 * Its own module, with no imports: both `sync-circle` and
 * `push-registration` need it, and those two already depend on each other.
 */
export const PushCategories = {
  newPost: 0,
  comment: 1,
  reaction: 2,
  memberJoined: 3,
} as const;

export type PushCategory = (typeof PushCategories)[keyof typeof PushCategories];

/**
 * The invite routings' own categories — a separate set, numbered from 0.
 * A category means nothing without the routing it's sent to: the relay
 * checks it against that routing's mask, and an invite routing's mask only
 * ever holds these bits. The phone picks text by the routing's kind, never
 * by the number. Positions are permanent, as above.
 *
 *     bit 0   joinRequest    on an invite routing
 *     bit 1   joinApproved   on a pending request's routing
 */
export const InvitePushCategories = {
  joinRequest: 0,
  joinApproved: 1,
} as const;

export type InvitePushCategory = (typeof InvitePushCategories)[keyof typeof InvitePushCategories];

/** Both invite categories on: what a phone starts with (settings.ts). */
export const ALL_INVITE_PUSH = (1 << InvitePushCategories.joinRequest) | (1 << InvitePushCategories.joinApproved);
