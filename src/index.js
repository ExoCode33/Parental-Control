if (!TOKEN) throw new Error('Missing DISCORD_TOKEN (or TOKEN) in environment');

// Build the watcher list from either the split variables or the combined one
const watcherList = (() => {
  if (WATCH_IDS_COMBINED) return WATCH_IDS_COMBINED.split(',').map(s => s.trim()).filter(Boolean);
  return [WATCH_ID_1, WATCH_ID_2].filter(Boolean);
})();

if (watcherList.length !== 2) {
  console.error('[PC] Missing watcher IDs. Set either WATCH_ID_1 and WATCH_ID_2, or WATCH_IDS="id1,id2"');
  console.error('[PC] Current values:', { WATCH_ID_1, WATCH_ID_2, WATCH_IDS: WATCH_IDS_COMBINED });
  throw new Error('Missing or incomplete watcher IDs in environment');
}

const [W1, W2] = watcherList.map(String);const SOUND_FILE = process.env.SOUND_FILE || 'sounds/The Going Merry One Piece.ogg';// Parental Control bot — ESM version
// Joins a voice channel ONLY when two specific users are alone together.
// Presence shows: "Watching youeatra".

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials, ChannelType, ActivityType } from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import path from 'path';
import fs from 'fs';

// === CONFIG ===
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const WATCH_ID_1 = process.env.WATCH_ID_1; // e.g. 928099760789925970
const WATCH_ID_2 = process.env.WATCH_ID_2; // e.g. 1148307120547176470
// Optional combined form: WATCH_IDS="id1,id2"
const WATCH_IDS_COMBINED = process.env.WATCH_IDS;

// Join sound path (relative to process.cwd()). Example from user:
// sounds/dun-dun-dun-sound-effect-brass_8nFBccR.mp3
const SOUND_FILE = process.env.SOUND_FILE || 'sounds/dun-dun-dun-sound-effect-brass_8nFBccR.mp3';

// Optional: cool-down to avoid reconnect spam (ms)
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 8000);

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN (or TOKEN) in environment');
if (!WATCH_ID_1 || !WATCH_ID_2) throw new Error('Missing WATCH_ID_1 or WATCH_ID_2 in environment');

if (!fs.existsSync(SOUND_FILE)) {
  console.warn(`[WARN] Join sound file not found at ${SOUND_FILE}. The bot will still join silently.`);
}

const WATCHED = new Set([W1, W2]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

// Track last join time per guild to prevent rapid re-joins
const lastJoinAt = new Map(); // guildId -> timestamp

function log(...args) {
  console.log('[PC]', ...args);
}

// Use the new v15-safe event name. (On v14 this also fires via alias.)
client.once('clientReady', async () => {
  log(`Logged in as ${client.user.tag}. Watching ${W1} & ${W2}.`);

  // === Set rich presence: "Watching youeatra" ===
  client.user.setPresence({
    activities: [{ name: 'youeatra', type: ActivityType.Watching }],
    status: 'online',
  });

  // On boot, check all guilds once
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch({ withPresences: false }).catch(() => {});
      await evaluateGuild(guild);
    } catch (e) {
      console.error('[PC] Initial evaluateGuild error:', e?.message || e);
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  // Only react inside the guild where change happened
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  // Log interesting transitions for tracked users
  const userId = newState.id || oldState.id;
  if (WATCHED.has(userId)) {
    const before = oldState?.channel ? `${oldState.channel?.name} (${oldState.channelId})` : 'none';
    const after = newState?.channel ? `${newState.channel?.name} (${newState.channelId})` : 'none';
    log(`Tracked user ${userId} moved: ${before} → ${after}`);
  }

  try {
    await evaluateGuild(guild);
  } catch (e) {
    console.error('[PC] evaluateGuild error:', e?.message || e);
  }
});

/**
 * Evaluate a guild to see if the two watched users are alone together in any voice channel.
 * If yes → ensure we are connected there (and play sound once if freshly joined).
 * If not → disconnect if connected.
 */
async function evaluateGuild(guild) {
  // Find voice-like channels
  const voiceChannels = guild.channels.cache.filter(c => c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice));
  let targetChannel = null;

  for (const [, channel] of voiceChannels) {
    // Exclude AFK channels if desired (optional)
    // if (guild.afkChannelId && channel.id === guild.afkChannelId) continue;

    const members = channel.members.filter(m => !m.user.bot); // humans only
    const memberIds = new Set(members.map(m => m.id));
    const bothInside = [...WATCHED].every(uid => memberIds.has(uid));
    const onlyTwo = members.size === 2;

    if (bothInside) {
      log(`[check] ${channel.name}: humans=${members.size} | contains both=${bothInside}`);
    }

    if (bothInside && onlyTwo) {
      targetChannel = channel;
      break; // Found the channel where they are alone together
    }
  }

  const existing = getVoiceConnection(guild.id);

  if (targetChannel) {
    // Cooldown check
    const now = Date.now();
    const prev = lastJoinAt.get(guild.id) || 0;
    const since = now - prev;

    if (existing && existing.joinConfig.channelId === targetChannel.id) {
      // Already connected to the correct channel — nothing to do
      log(`Already connected to #${targetChannel.name}.`);
      return;
    }

    if (since < COOLDOWN_MS) {
      log(`Within cooldown (${since}ms < ${COOLDOWN_MS}ms). Skipping re-join.`);
      return;
    }

    // If connected elsewhere in this guild, move connection
    if (existing) {
      try { existing.destroy(); } catch {}
    }

    // Join the target channel
    const connection = joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: targetChannel.guild.id,
      adapterCreator: targetChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    lastJoinAt.set(guild.id, now);
    log(`Joined #${targetChannel.name} because ${W1} & ${W2} are alone together.`);

    // Play the sound once, if provided
    try {
      if (fs.existsSync(SOUND_FILE)) {
        const player = createAudioPlayer({ behavior: NoSubscriberBehavior.Pause });
        const resource = createAudioResource(SOUND_FILE, { inlineVolume: true });
        if (resource.volume) resource.volume.setVolume(0.75);

        connection.subscribe(player);
        player.play(resource);
        log(`Playing join sound: ${path.basename(SOUND_FILE)}`);

        player.once(AudioPlayerStatus.Idle, () => {
          // After audio finishes, keep the connection open; we will disconnect when not-alone
          log('Join sound finished. Staying connected until state changes.');
        });

        player.on('error', (e) => {
          console.error('[PC] Audio player error:', e?.message || e);
        });
      }
    } catch (e) {
      console.error('[PC] Failed to play join sound:', e?.message || e);
    }
  } else {
    // No channel meets the condition → disconnect if connected
    if (existing) {
      const ch = guild.channels.cache.get(existing.joinConfig.channelId);
      try {
        existing.destroy();
        log(`Left #${ch?.name || existing.joinConfig.channelId} (no longer alone together).`);
      } catch (e) {
        console.error('[PC] Failed to leave voice:', e?.message || e);
      }
    }
  }
}

// Safety: also leave when the bot is manually disconnected or the guild becomes unavailable
client.on('guildUnavailable', (guild) => {
  const existing = getVoiceConnection(guild.id);
  try { existing?.destroy(); } catch {}
});

process.on('unhandledRejection', (err) => {
  console.error('[PC] Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[PC] Uncaught exception:', err);
});

client.login(TOKEN);
