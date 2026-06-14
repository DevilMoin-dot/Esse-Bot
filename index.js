/**
 * index.js — Discord Bot Entry Point
 *
 * A YouTube-focused Discord bot for channel UCfTDzYS95JdeTmJsG4LBEtw.
 * Built with discord.js v14 + Express.js for Replit deployment.
 *
 * Environment variables required:
 *   TOKEN           — Discord bot token
 *   CLIENT_ID       — Discord application/client ID
 *   YOUTUBE_API_KEY — Google YouTube Data API v3 key
 *   PORT            — HTTP port (defaults to 3000)
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import express from 'express';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only YouTube channel this bot will ever query. */
const CHANNEL_ID = 'UCfTDzYS95JdeTmJsG4LBEtw';

/** YouTube Data API v3 base URL. */
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

/** How long (ms) to keep YouTube API responses in the in-memory cache. */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Ordered subscriber milestones used by /milestone. */
const MILESTONES = [
  1_000, 5_000, 10_000, 25_000, 50_000,
  100_000, 250_000, 500_000, 1_000_000,
  2_000_000, 5_000_000, 10_000_000,
];

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/** Simple TTL cache: key → { data, timestamp } */
const cache = new Map();

/**
 * Return cached data for `key`, or null if missing / expired.
 * @param {string} key
 * @returns {any|null}
 */
function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Store `data` under `key` with the current timestamp.
 * @param {string} key
 * @param {any} data
 */
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// YouTube API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a YouTube Data API endpoint with automatic caching.
 * Throws on non-2xx responses.
 *
 * @param {string} endpoint  e.g. 'channels', 'search', 'videos', 'playlistItems'
 * @param {Record<string,string>} params  Query parameters (excluding `key`)
 * @returns {Promise<any>} Parsed JSON response
 */
async function ytFetch(endpoint, params) {
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = new URL(`${YT_BASE}/${endpoint}`);
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${res.status} on /${endpoint}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  setCache(cacheKey, data);
  return data;
}

/**
 * Fetch full channel details (snippet + statistics + brandingSettings + contentDetails).
 * contentDetails.relatedPlaylists.uploads is the uploads playlist ID.
 * @returns {Promise<any>}
 */
async function getChannelInfo() {
  return ytFetch('channels', {
    part: 'snippet,statistics,brandingSettings,contentDetails',
    id: CHANNEL_ID,
  });
}

/**
 * Return the latest uploaded video snippet (from search, ordered by date).
 * @returns {Promise<any|null>}
 */
async function getLatestVideo() {
  const data = await ytFetch('search', {
    part: 'snippet',
    channelId: CHANNEL_ID,
    order: 'date',
    type: 'video',
    maxResults: '1',
  });
  return data.items?.[0] ?? null;
}

/**
 * Fetch statistics for a single video by its ID.
 * @param {string} videoId
 * @returns {Promise<any|null>}
 */
async function getVideoStats(videoId) {
  const data = await ytFetch('videos', {
    part: 'statistics',
    id: videoId,
  });
  return data.items?.[0]?.statistics ?? null;
}

/**
 * Fetch up to `maxResults` items from the channel's uploads playlist.
 * @param {string} playlistId  The uploads playlist ID from contentDetails
 * @param {number} maxResults  1–50
 * @returns {Promise<any>}
 */
async function getUploads(playlistId, maxResults = 50) {
  return ytFetch('playlistItems', {
    part: 'snippet',
    playlistId,
    maxResults: String(maxResults),
  });
}

/**
 * Find the most-viewed video among the latest 50 uploads.
 * Makes one batch videos?part=statistics,snippet call.
 * @param {string} playlistId
 * @returns {Promise<any|null>}
 */
async function getTopVideo(playlistId) {
  const uploads = await getUploads(playlistId, 50);
  if (!uploads.items?.length) return null;

  const ids = uploads.items
    .map((i) => i.snippet.resourceId.videoId)
    .join(',');

  const statsData = await ytFetch('videos', {
    part: 'statistics,snippet',
    id: ids,
  });

  if (!statsData.items?.length) return null;

  // Pick the video with the highest viewCount
  return statsData.items.reduce((best, v) => {
    const views = parseInt(v.statistics?.viewCount ?? '0', 10);
    const bestViews = parseInt(best.statistics?.viewCount ?? '0', 10);
    return views > bestViews ? v : best;
  });
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

/**
 * Format a raw count with commas: 1234567 → "1,234,567".
 * @param {string|number} n
 * @returns {string}
 */
function fmt(n) {
  return (parseInt(n, 10) || 0).toLocaleString('en-US');
}

/**
 * Format a count with K/M abbreviation: 1234567 → "1.2M".
 * @param {string|number} n
 * @returns {string}
 */
function fmtShort(n) {
  const num = parseInt(n, 10) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString('en-US');
}

/**
 * Format an ISO 8601 date string as a human-readable date.
 * @param {string} iso
 * @returns {string}
 */
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Return the next subscriber milestone above `subs`.
 * Falls back to 10× the largest milestone if subs already exceed all.
 * @param {number} subs
 * @returns {number}
 */
function nextMilestone(subs) {
  return MILESTONES.find((m) => m > subs) ?? MILESTONES[MILESTONES.length - 1] * 10;
}

/**
 * Render a Unicode progress bar.
 * @param {number} current
 * @param {number} total
 * @param {number} [length=20]  Width in characters
 * @returns {string}
 */
function progressBar(current, total, length = 20) {
  const ratio = Math.min(current / total, 1);
  const filled = Math.round(ratio * length);
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}

// ---------------------------------------------------------------------------
// Slash command definitions
// ---------------------------------------------------------------------------

const commandDefs = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Show bot latency and API latency'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  new SlashCommandBuilder()
    .setName('channel')
    .setDescription('Show complete information about the YouTube channel'),

  new SlashCommandBuilder()
    .setName('latest')
    .setDescription('Show the newest uploaded video'),

  new SlashCommandBuilder()
    .setName('randomvideo')
    .setDescription('Show a random video from the channel'),

  new SlashCommandBuilder()
    .setName('subcount')
    .setDescription('Show the current subscriber count'),

  new SlashCommandBuilder()
    .setName('viewcount')
    .setDescription('Show the total channel view count'),

  new SlashCommandBuilder()
    .setName('videocount')
    .setDescription('Show the total number of uploaded videos'),

  new SlashCommandBuilder()
    .setName('milestone')
    .setDescription('Show progress toward the next subscriber milestone'),

  new SlashCommandBuilder()
    .setName('topvideo')
    .setDescription('Show the most viewed video on the channel'),
].map((c) => c.toJSON());

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * /ping — Bot latency + API latency
 */
async function handlePing(interaction) {
  // Send a placeholder reply first so we can measure round-trip time
  const sent = await interaction.reply({ content: '🏓 Pinging…', fetchReply: true });

  const botLatency = sent.createdTimestamp - interaction.createdTimestamp;
  const apiLatency = Math.round(client.ws.ping);

  const embed = new EmbedBuilder()
    .setTitle('🏓 Pong!')
    .setColor(0x5865f2)
    .addFields(
      { name: '🤖 Bot Latency', value: `\`${botLatency}ms\``, inline: true },
      { name: '📡 API Latency', value: `\`${apiLatency}ms\``, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ content: '', embeds: [embed] });
}

/**
 * /help — List all commands with descriptions
 */
async function handleHelp(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('📖 Bot Commands')
    .setColor(0xff0000)
    .setDescription('All commands are dedicated to **Esse\'s YouTube channel**.')
    .addFields(
      { name: '`/ping`', value: 'Shows bot latency.' },
      { name: '`/help`', value: 'Shows this help menu.' },
      { name: '`/channel`', value: 'Shows complete channel information.' },
      { name: '`/latest`', value: 'Shows the newest uploaded video.' },
      { name: '`/randomvideo`', value: 'Shows a random video from the channel.' },
      { name: '`/subcount`', value: 'Shows current subscriber count.' },
      { name: '`/viewcount`', value: 'Shows total channel views.' },
      { name: '`/videocount`', value: 'Shows total uploaded videos.' },
      { name: '`/milestone`', value: 'Shows progress to the next subscriber milestone.' },
      { name: '`/topvideo`', value: 'Shows the most viewed video on the channel.' },
    )
    .setFooter({ text: 'Locked to Esse\'s YouTube channel' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

/**
 * /channel — Full channel profile
 */
async function handleChannel(interaction) {
  await interaction.deferReply();

  const data = await getChannelInfo();
  const ch = data.items?.[0];
  if (!ch) throw new Error('Channel data not returned by YouTube API');

  const { snippet, statistics, brandingSettings, contentDetails } = ch;
  const uploadsPlaylistId = contentDetails.relatedPlaylists.uploads;

  // Fetch the latest video for display in the embed
  const latestVideo = await getLatestVideo();
  const latestTitle = latestVideo?.snippet?.title ?? 'N/A';
  const latestDate = latestVideo?.snippet?.publishedAt
    ? fmtDate(latestVideo.snippet.publishedAt)
    : 'N/A';

  // Banner image (may be undefined)
  const bannerUrl = brandingSettings?.image?.bannerExternalUrl;
  const thumbUrl =
    snippet.thumbnails?.high?.url ??
    snippet.thumbnails?.medium?.url ??
    snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(
      snippet.customUrl
        ? `${snippet.title} (${snippet.customUrl})`
        : snippet.title,
    )
    .setDescription(snippet.description?.slice(0, 300) || '*No description available.*')
    .setColor(0xff0000)
    .setThumbnail(thumbUrl)
    .addFields(
      { name: '👥 Subscribers', value: fmt(statistics.subscriberCount), inline: true },
      { name: '👁️ Total Views', value: fmt(statistics.viewCount), inline: true },
      { name: '🎬 Total Videos', value: fmt(statistics.videoCount), inline: true },
      { name: '📅 Channel Created', value: fmtDate(snippet.publishedAt), inline: true },
      { name: '🌍 Country', value: snippet.country ?? 'N/A', inline: true },
      {
        name: '🔗 Custom URL',
        value: snippet.customUrl
          ? `[${snippet.customUrl}](https://youtube.com/${snippet.customUrl})`
          : 'N/A',
        inline: true,
      },
      { name: '📹 Latest Video', value: latestTitle },
      { name: '📆 Latest Upload', value: latestDate, inline: true },
    )
    .setURL(`https://www.youtube.com/channel/${CHANNEL_ID}`)
    .setFooter({ text: 'YouTube Channel Info' })
    .setTimestamp();

  // Add banner as the large image if available
  if (bannerUrl) embed.setImage(bannerUrl);

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /latest — Most recently uploaded video
 */
async function handleLatest(interaction) {
  await interaction.deferReply();

  const video = await getLatestVideo();
  if (!video) throw new Error('No videos returned by YouTube API');

  const videoId = video.id?.videoId ?? video.snippet?.resourceId?.videoId;
  const stats = await getVideoStats(videoId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const thumbUrl =
    video.snippet.thumbnails?.high?.url ??
    video.snippet.thumbnails?.medium?.url ??
    video.snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(video.snippet.title)
    .setColor(0xff0000)
    .setImage(thumbUrl)
    .addFields(
      { name: '📅 Upload Date', value: fmtDate(video.snippet.publishedAt), inline: true },
      { name: '👁️ Views', value: fmt(stats?.viewCount ?? '0'), inline: true },
    )
    .setURL(url)
    .setFooter({ text: 'Latest Video' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Watch Video')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
      .setEmoji('▶️'),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/**
 * /randomvideo — A random pick from the last 50 uploads
 */
async function handleRandomVideo(interaction) {
  await interaction.deferReply();

  const channelData = await getChannelInfo();
  const ch = channelData.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const playlistId = ch.contentDetails.relatedPlaylists.uploads;
  const uploads = await getUploads(playlistId, 50);
  if (!uploads.items?.length) throw new Error('No uploads found');

  // Pick a random video
  const pick = uploads.items[Math.floor(Math.random() * uploads.items.length)];
  const videoId = pick.snippet.resourceId.videoId;
  const stats = await getVideoStats(videoId);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const thumbUrl =
    pick.snippet.thumbnails?.high?.url ??
    pick.snippet.thumbnails?.medium?.url ??
    pick.snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(pick.snippet.title)
    .setColor(0xff0000)
    .setImage(thumbUrl)
    .addFields(
      { name: '📅 Upload Date', value: fmtDate(pick.snippet.publishedAt), inline: true },
      { name: '👁️ Views', value: fmt(stats?.viewCount ?? '0'), inline: true },
    )
    .setURL(url)
    .setFooter({ text: 'Random Video' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Watch Video')
      .setStyle(ButtonStyle.Link)
      .setURL(url)
      .setEmoji('▶️'),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

/**
 * /subcount — Current subscriber count only
 */
async function handleSubcount(interaction) {
  await interaction.deferReply();

  const data = await getChannelInfo();
  const ch = data.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const { snippet, statistics } = ch;
  const thumbUrl = snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(`👥 Subscriber Count — ${snippet.title}`)
    .setColor(0xff0000)
    .setThumbnail(thumbUrl)
    .setDescription(`**${fmt(statistics.subscriberCount)}** subscribers`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /viewcount — Total channel views only
 */
async function handleViewcount(interaction) {
  await interaction.deferReply();

  const data = await getChannelInfo();
  const ch = data.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const { snippet, statistics } = ch;
  const thumbUrl = snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(`👁️ Total Views — ${snippet.title}`)
    .setColor(0xff0000)
    .setThumbnail(thumbUrl)
    .setDescription(`**${fmt(statistics.viewCount)}** total views`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /videocount — Total uploaded videos only
 */
async function handleVideocount(interaction) {
  await interaction.deferReply();

  const data = await getChannelInfo();
  const ch = data.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const { snippet, statistics } = ch;
  const thumbUrl = snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(`🎬 Total Videos — ${snippet.title}`)
    .setColor(0xff0000)
    .setThumbnail(thumbUrl)
    .setDescription(`**${fmt(statistics.videoCount)}** videos uploaded`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /milestone — Progress bar toward the next subscriber milestone
 */
async function handleMilestone(interaction) {
  await interaction.deferReply();

  const data = await getChannelInfo();
  const ch = data.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const { snippet, statistics } = ch;
  const thumbUrl = snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url;

  const subs = parseInt(statistics.subscriberCount, 10) || 0;
  const next = nextMilestone(subs);
  const remaining = next - subs;
  const pct = ((subs / next) * 100).toFixed(1);
  const bar = progressBar(subs, next);

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Milestone Progress — ${snippet.title}`)
    .setColor(0xffd700)
    .setThumbnail(thumbUrl)
    .addFields(
      { name: '👥 Current Subscribers', value: fmt(subs), inline: true },
      { name: '🎯 Next Milestone', value: fmt(next), inline: true },
      { name: '📉 Remaining', value: fmt(remaining), inline: true },
      { name: '📊 Progress', value: `${pct}%`, inline: true },
      { name: '📈 Progress Bar', value: `\`${bar}\` ${pct}%`, inline: false },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * /topvideo — Most-viewed video from the last 50 uploads
 */
async function handleTopVideo(interaction) {
  await interaction.deferReply();

  const channelData = await getChannelInfo();
  const ch = channelData.items?.[0];
  if (!ch) throw new Error('Channel not found');

  const playlistId = ch.contentDetails.relatedPlaylists.uploads;
  const top = await getTopVideo(playlistId);
  if (!top) throw new Error('Could not determine top video');

  const videoId = top.id;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const thumbUrl =
    top.snippet.thumbnails?.high?.url ??
    top.snippet.thumbnails?.medium?.url ??
    top.snippet.thumbnails?.default?.url;

  const embed = new EmbedBuilder()
    .setTitle(top.snippet.title)
    .setColor(0xffd700)
    .setImage(thumbUrl)
    .addFields(
      { name: '👁️ Total Views', value: fmt(top.statistics.viewCount), inline: true },
      { name: '📅 Upload Date', value: fmtDate(top.snippet.publish
