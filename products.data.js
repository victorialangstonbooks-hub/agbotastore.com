'use strict';

/**
 * Canonical product catalog for Agbota Segun.
 * PRICES ARE FIXED BY THE OWNER — do not change them.
 * Seeding is idempotent and keyed on `slug`.
 */

const P = {
  youtube: 'YouTube',
  twitch: 'Twitch',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  instagram: 'Instagram',
  discord: 'Discord',
};

const singleIncludes = (platform) => [
  `Full ${platform} growth blueprint written for your channel type and niche`,
  'Positioning and channel/profile audit checklist',
  'Content pillar framework and posting structure',
  `${platform} algorithm-aligned publishing rhythm and format guidance`,
  'Titles, hooks and thumbnail/cover direction where applicable',
  'Audience retention and community-building actions',
  '30 / 60 / 90 day execution roadmap',
  'Metrics to track and how to review them',
];

const products = [
  // ---------------- SINGLE PLATFORM — $30 each ----------------
  {
    slug: 'youtube-strategy',
    name: 'YouTube Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'A structured YouTube growth blueprint built around your channel.',
    description:
      'A complete YouTube growth strategy blueprint. It covers how your channel is positioned, what content structure fits your niche, how to build packaging (titles, thumbnails, hooks) that earns clicks honestly, and how to keep viewers watching. You receive a written blueprint with an execution roadmap you can start applying immediately.',
    includes: singleIncludes('YouTube'),
    audience:
      'Creators and streamers building a YouTube channel — new channels looking for direction, or existing channels that have stalled and need a clear system.',
    platforms: [P.youtube],
    sort_order: 10,
  },
  {
    slug: 'twitch-strategy',
    name: 'Twitch Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'A live-streaming growth system for building a real Twitch audience.',
    description:
      'A complete Twitch growth strategy blueprint covering stream positioning, schedule design, category selection, raids and networking, community retention, and how to convert casual viewers into returning regulars. Includes an execution roadmap tailored to a live-streaming workflow.',
    includes: singleIncludes('Twitch'),
    audience:
      'Live streamers on Twitch who want consistent concurrent viewers, a repeatable schedule, and a community that returns every stream.',
    platforms: [P.twitch],
    sort_order: 20,
  },
  {
    slug: 'tiktok-strategy',
    name: 'TikTok Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'Short-form content system engineered for reach and follow-through.',
    description:
      'A complete TikTok growth strategy blueprint covering hook writing, short-form formats that suit your niche, posting cadence, sound and trend usage, and how to turn views into followers who actually stay. Includes an execution roadmap and review metrics.',
    includes: singleIncludes('TikTok'),
    audience:
      'Creators and streamers using short-form video to build reach fast, including streamers repurposing live content into clips.',
    platforms: [P.tiktok],
    sort_order: 30,
  },
  {
    slug: 'facebook-strategy',
    name: 'Facebook Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'Build reach and community on Facebook pages, groups and Reels.',
    description:
      'A complete Facebook growth strategy blueprint covering page and group positioning, Reels and video distribution, community engagement structure, and a posting system that compounds over time. Includes an execution roadmap and review metrics.',
    includes: singleIncludes('Facebook'),
    audience:
      'Creators and streamers who want to grow a Facebook page, group or Facebook Gaming presence with a structured plan.',
    platforms: [P.facebook],
    sort_order: 40,
  },
  {
    slug: 'instagram-strategy',
    name: 'Instagram Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'Profile positioning, Reels and a content system that converts.',
    description:
      'A complete Instagram growth strategy blueprint covering profile positioning, Reels strategy, grid and story structure, hook and caption direction, and how to move followers toward your main platform or offer. Includes an execution roadmap and review metrics.',
    includes: singleIncludes('Instagram'),
    audience:
      'Creators and streamers using Instagram as a growth or brand surface, including those building toward brand partnerships.',
    platforms: [P.instagram],
    sort_order: 50,
  },
  {
    slug: 'discord-strategy',
    name: 'Discord Strategy',
    price_cents: 3000,
    tier: 'single',
    tagline: 'Turn an empty server into an active, retained community.',
    description:
      'A complete Discord growth strategy blueprint covering server structure, onboarding flow, roles and channels design, moderation basics, engagement rituals, and how to route your audience from other platforms into an active community. Includes an execution roadmap.',
    includes: singleIncludes('Discord'),
    audience:
      'Streamers and creators who want a community hub that stays active between streams and uploads instead of going quiet.',
    platforms: [P.discord],
    sort_order: 60,
  },

  // ---------------- COMBINED STRATEGIES ----------------
  {
    slug: 'tiktok-instagram',
    name: 'TikTok + Instagram Strategy',
    price_cents: 5500,
    tier: 'combo',
    tagline: 'A unified short-form engine across TikTok and Instagram.',
    description:
      'Both platform blueprints plus a cross-platform plan showing how one short-form production workflow feeds TikTok and Instagram without duplicating effort. Covers repurposing rules, platform-specific adjustments, and a combined posting calendar.',
    includes: [
      'Full TikTok growth blueprint',
      'Full Instagram growth blueprint',
      'Cross-platform repurposing workflow (one shoot, both platforms)',
      'Combined posting calendar and cadence',
      'Platform-specific hook and caption adjustments',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Short-form creators who want reach on both platforms without doubling their workload.',
    platforms: [P.tiktok, P.instagram],
    sort_order: 110,
  },
  {
    slug: 'youtube-tiktok',
    name: 'YouTube + TikTok Strategy',
    price_cents: 6000,
    tier: 'combo',
    tagline: 'Long-form authority plus short-form discovery, working together.',
    description:
      'Both platform blueprints plus a funnel plan connecting short-form discovery on TikTok to long-form retention on YouTube. Covers clipping strategy, what to repurpose, and how to move short-form viewers into a subscribed YouTube audience.',
    includes: [
      'Full YouTube growth blueprint',
      'Full TikTok growth blueprint',
      'Short-form to long-form funnel plan',
      'Clipping and repurposing workflow',
      'Combined posting calendar and cadence',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Creators building a main YouTube channel who want TikTok driving discovery into it.',
    platforms: [P.youtube, P.tiktok],
    sort_order: 120,
  },
  {
    slug: 'twitch-discord',
    name: 'Twitch + Discord Strategy',
    price_cents: 6000,
    tier: 'combo',
    tagline: 'Live streams plus a community that stays active between them.',
    description:
      'Both platform blueprints plus a retention plan that connects your live streams to an active Discord community. Covers routing viewers into the server, keeping the server alive on off-days, and turning community members into regular stream attendees.',
    includes: [
      'Full Twitch growth blueprint',
      'Full Discord growth blueprint',
      'Stream-to-community routing plan',
      'Off-stream engagement rituals',
      'Combined schedule design',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Twitch streamers whose community goes quiet between streams and who want retention, not just views.',
    platforms: [P.twitch, P.discord],
    sort_order: 130,
  },
  {
    slug: 'youtube-instagram-tiktok',
    name: 'YouTube + Instagram + TikTok Strategy',
    price_cents: 8000,
    tier: 'combo',
    tagline: 'A three-platform content system with one production workflow.',
    description:
      'Three full platform blueprints plus a combined content system so one production cycle serves YouTube, Instagram and TikTok. Covers the repurposing chain, platform-specific packaging, and a unified calendar that keeps all three consistent.',
    includes: [
      'Full YouTube growth blueprint',
      'Full Instagram growth blueprint',
      'Full TikTok growth blueprint',
      'Three-platform repurposing chain',
      'Unified content calendar',
      'Platform-specific packaging adjustments',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Creators serious about a multi-platform presence who need one workflow instead of three separate jobs.',
    platforms: [P.youtube, P.instagram, P.tiktok],
    sort_order: 140,
  },
  {
    slug: 'twitch-tiktok-discord',
    name: 'Twitch + TikTok + Discord Strategy',
    price_cents: 8500,
    tier: 'combo',
    tagline: 'The streamer stack: discovery, live audience and community.',
    description:
      'Three full platform blueprints built around a live-streaming workflow — TikTok for discovery, Twitch for the live audience, Discord for retention. Includes the clipping pipeline from stream to short-form and the routing plan into your community.',
    includes: [
      'Full Twitch growth blueprint',
      'Full TikTok growth blueprint',
      'Full Discord growth blueprint',
      'Stream-to-clip production pipeline',
      'Discovery-to-community routing plan',
      'Unified schedule and content calendar',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Live streamers who want a complete system around the stream, not just the stream itself.',
    platforms: [P.twitch, P.tiktok, P.discord],
    sort_order: 150,
  },
  {
    slug: 'youtube-twitch-tiktok',
    name: 'YouTube + Twitch + TikTok Strategy',
    price_cents: 9500,
    tier: 'combo',
    tagline: 'Live, long-form and short-form aligned under one strategy.',
    description:
      'Three full platform blueprints plus an integrated plan connecting live streaming, long-form video and short-form discovery. Covers what content originates where, how it flows between platforms, and how to keep all three consistent without burning out.',
    includes: [
      'Full YouTube growth blueprint',
      'Full Twitch growth blueprint',
      'Full TikTok growth blueprint',
      'Live-to-long-form-to-short-form content flow',
      'Integrated production and posting calendar',
      'Cross-platform audience routing plan',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience: 'Streamers building a full creator business across live, long-form and short-form at the same time.',
    platforms: [P.youtube, P.twitch, P.tiktok],
    sort_order: 160,
  },
  {
    slug: 'youtube-twitch-tiktok-discord',
    name: 'YouTube + Twitch + TikTok + Discord Strategy',
    price_cents: 12000,
    tier: 'combo',
    tagline: 'The complete four-platform growth system.',
    description:
      'The full stack: four platform blueprints plus the integrated system that connects them — short-form discovery, live streaming, long-form retention and a community hub. Includes the complete content flow, routing plan and a single execution roadmap covering all four.',
    includes: [
      'Full YouTube growth blueprint',
      'Full Twitch growth blueprint',
      'Full TikTok growth blueprint',
      'Full Discord growth blueprint',
      'Complete four-platform content flow',
      'Full audience routing and retention plan',
      'Integrated production and posting calendar',
      'Unified 30 / 60 / 90 day execution roadmap',
      'Combined metrics review sheet',
    ],
    audience:
      'Established or fast-moving creators who want every surface working together under one documented growth system.',
    platforms: [P.youtube, P.twitch, P.tiktok, P.discord],
    sort_order: 170,
  },

  // ---------------- CUSTOM ----------------
  {
    slug: 'custom-multi-platform',
    name: 'Custom Multi-Platform Strategy',
    price_cents: 15000,
    price_note: 'Starting around $150+ — final price depends on scope, agreed before any payment.',
    tier: 'custom',
    tagline: 'Built around your exact channels, goals and situation.',
    description:
      'A custom growth strategy scoped specifically for you. This is for creators whose situation does not fit a standard package — unusual platform mixes, specific revenue goals, an existing audience that needs restructuring, or work that goes beyond a single blueprint. Scope and final price are agreed with you in Chat before any payment is made. The starting figure is a baseline, not a fixed quote.',
    includes: [
      'Discovery conversation about your channels, goals and constraints',
      'Custom scope written and agreed with you before payment',
      'Strategy built for your specific platform mix',
      'Creator/channel analysis relevant to your situation',
      'Execution roadmap matched to your capacity',
      'Metrics and review structure',
      'Direct communication through Chat throughout',
    ],
    audience:
      'Creators and streamers whose needs do not fit a standard package and who want scope agreed before committing.',
    platforms: [P.youtube, P.twitch, P.tiktok, P.facebook, P.instagram, P.discord],
    sort_order: 200,
  },
];

module.exports = { products };
