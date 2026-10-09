// Ids of the built-in pictures (isomorphic: imported by js/ui/avatars.js and by the server
// to validate requests). The first five are the Lumina identity pictures shown on
// "Who's watching?"; the rest are the smaller garden motifs used for extra profiles.
export const IDENTITY_AVATAR_IDS = ['crimson-sakura', 'moonlit-ronin', 'golden-pavilion', 'midnight-kitsune', 'velvet-lotus'];
export const MOTIF_AVATAR_IDS = ['sakura', 'lantern', 'moon', 'maple', 'koi', 'crane', 'wave', 'fuji', 'torii', 'bamboo', 'fox', 'snow'];
export const AVATAR_IDS = [...IDENTITY_AVATAR_IDS, ...MOTIF_AVATAR_IDS];
