// Parental Control bot — ESM index.js (full file with runtime setup)
// Joins a voice channel ONLY when two specific users are alone together.
// Presence shows: "Watching youeatra".
// If watcher IDs are not set via env, you can set them at runtime with slash commands:
//   /pc_set user1:@User user2:@User
//   /pc_status
//   /pc_clear

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
import fs from 'fs';
import path from 'path';

// === CONFIG ===
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;
const WATCH_ID_1 = process.env.WATCH_ID_1; // e.g. 928099760789925970
const WATCH_ID_2 = process.env.WATCH_ID_2; // e.g. 1148307120547176470
const WATCH_IDS_COMBINED = process.env.WATCH_IDS || '';
// Default to your provided welcome sound (override with SOUND_FILE env var)
const SOUND_FILE = process.env.SOUND_FILE || 'sounds/The Going Merry One Piece.ogg';
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 8000);

if (!TOKEN) {
  throw new Error('Missing DISCORD_TOKEN (or TOKEN) in environment');
}

// === Resolve watchers from env or watchers.json ===
function loadWatchersFromFile() {
  try {
    const raw = fs.readFileSync('watchers.json', 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.watchers) && parsed.watchers.length === 2) {
      return parsed.watchers.map(String);
    }
  } catch {}
  return [];
}
function saveWatchersToFile(ids) {
  try { fs.writeFileSync('watchers.json', JSON.stringify({ watchers: ids }, null, 2)); } catch {}
}

let watchers = [];
const combined = WATCH_IDS_COMBINED.split(',').map(s => s.trim()).filter(Boolean);
const pair = [WATCH_ID_1, WATCH_ID_2].filter(Boolean);
if (combined.length === 2) watchers = combined.map(String);
else if (pair.length === 2) watchers = pair.map(String);
else watchers = loadWatchersFromFile();

if (!fs.existsSync(SOUND_FILE)) {
  console.warn(`[WARN] Join sound not found: ${SOUND_FILE}. Bot will join silently.`);
}

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

function log(...args) { console.log('[PC]', ...args); }

let booted = false;
async function onReady() {
  if (booted) return;
  booted = true;

  log(`Logged in as ${client.user.tag}.`);
  if (watchers.length === 2) {
    log(`Watching ${watchers[0]} & ${watchers[1]}.`);
  } else {
    log('No watcher IDs configured yet. Use /pc_set to configure two users, or set WATCH_IDS/ WATCH_ID_1 & WATCH_ID_2 and restart.');
  }

  // Presence
  client.user.setPresence({ activities: [{ name: 'youeatra', type: ActivityType.Watching }], status: 'online' });

  // Register guild slash commands for instant availability
  const commands = [
    {
      name: 'pc_set', description: 'Set the two watched users',
      default_member_permissions: '0', // manage who can use via Discord perms if desired
      options: [
        { name: 'user1', description: 'First user', type: 6, required: true },
        { name: 'user2', description: 'Second user', type: 6, required: true },
      ],
    },
    { name: 'pc_status', description: 'Show current watched users' },
    { name: 'pc_clear', description: 'Clear watched users' },
  ];

  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.commands.set(commands);
      log(`Slash commands registered in guild: ${guild.name}`);
    } catch (e) {
      console.error('[PC] Failed to register commands:', e?.message || e);
    }
  }

  // Initial scan
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.members.fetch({ withPresences: false }).catch(() => {});
      await evaluateGuild(guild);
    } catch (e) {
      console.error('[PC] Initial evaluateGuild error:', e?.message || e);
    }
  }
}

client.once('clientReady', onReady);
client.once('ready', onReady);

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'pc_set') {
      const u1 = interaction.options.getUser('user1');
      const u2 = interaction.options.getUser('user2');
      if (!u1 || !u2 || u1.bot || u2.bot || u1.id === u2.id) {
        return interaction.reply({ content: 'Pick **two different human** users.', ephemeral: true });
      }
      watchers = [u1.id, u2.id];
      saveWatchersToFile(watchers);
      await interaction.reply({ content: `Watching <@${u1.id}> & <@${u2.id}>.`, ephemeral: true });
      // Re-evaluate guild state now
      await evaluateGuild(interaction.guild);
      return;
    }
    if (interaction.commandName === 'pc_status') {
      if (watchers.length === 2) {
        return interaction.reply({ content: `Currently watching: <@${watchers[0]}> & <@${watchers[1]}>`, ephemeral: true });
      } else {
        return interaction.reply({ content: 'No watchers set. Use `/pc_set user1:@A user2:@B`.', ephemeral: true });
      }
    }
    if (interaction.commandName === 'pc_clear') {
      watchers = [];
      saveWatchersToFile(watchers);
      await interaction.reply({ content: 'Cleared watchers. Use `/pc_set` to configure.', ephemeral: true });
      // Disconnect if currently connected, since rule can no longer be true
      try { getVoiceConnection(interaction.guild.id)?.destroy(); } catch {}
      return;
    }
  } catch (e) {
    console.error('[PC] interaction error:', e?.message || e);
    if (interaction.deferred || interaction.replied) {
      try { await interaction.followUp({ content: 'Error handling command.', ephemeral: true }); } catch {}
    } else {
      try { await interaction.reply({ content: 'Error handling command.', ephemeral: true }); } catch {}
    }
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  // If not configured yet, do nothing
  if (watchers.length !== 2) return;

  const userId = newState.id || oldState.id;
  if (watchers.includes(userId)) {
    const before = oldState?.channel ? `${oldState.channel?.name} (${oldState.channelId})` : 'none';
    const after = newState?.channel ? `${newState.channel?.name} (${newState.channelId})` : 'none';
    log(`Tracked user ${userId} moved: ${before} → ${after}`);
  }

  try { await evaluateGuild(guild); } catch (e) {
    console.error('[PC] evaluateGuild error:', e?.message || e);
  }
});

/**
 * Evaluate a guild to see if the two watched users are alone together in any voice channel.
 */
async function evaluateGuild(guild) {
  const existing = getVoiceConnection(guild.id);

  if (watchers.length !== 2) {
    // Ensure we leave if previously connected
    if (existing) {
      try { existing.destroy(); log('Left voice (watchers not configured).'); } catch {}
    }
    return;
  }

  const [W1, W2] = watchers;
  const voiceChannels = guild.channels.cache.filter(c => c && (c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice));
  let targetChannel = null;

  for (const [, channel] of voiceChannels) {
    const members = channel.members.filter(m => !m.user.bot); // humans only
    const memberIds = new Set(members.map(m => m.id));
    const bothInside = memberIds.has(W1) && memberIds.has(W2);
    const onlyTwo = members.size === 2;

    if (bothInside) {
      log(`[check] ${channel.name}: humans=${members.size} | contains both=${bothInside}`);
    }

    if (bothInside && onlyTwo) { targetChannel = channel; break; }
  }

  if (targetChannel) {
    const now = Date.now();
    const prev = lastJoinAt.get(guild.id) || 0;
    const since = now - prev;

    if (existing && existing.joinConfig.channelId === targetChannel.id) {
      log(`Already connected to #${targetChannel.name}.`);
      return;
    }

    if (since < COOLDOWN_MS) {
      log(`Within cooldown (${since}ms < ${COOLDOWN_MS}ms). Skipping re-join.`);
      return;
    }

    try { existing?.destroy(); } catch {}

    const connection = joinVoiceChannel({
      channelId: targetChannel.id,
      guildId: targetChannel.guild.id,
      adapterCreator: targetChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    lastJoinAt.set(guild.id, now);
    log(`Joined #${targetChannel.name} because ${watchers[0]} & ${watchers[1]} are alone together.`);

    try {
      if (fs.existsSync(SOUND_FILE)) {
        const player = createAudioPlayer({ behavior: NoSubscriberBehavior.Pause });
        const resource = createAudioResource(SOUND_FILE, { inlineVolume: true });
        if (resource.volume) resource.volume.setVolume(0.75);
        connection.subscribe(player);
        player.play(resource);
        log(`Playing join sound: ${path.basename(SOUND_FILE)}`);
        player.once(AudioPlayerStatus.Idle, () => log('Join sound finished. Staying connected until state changes.'));
        player.on('error', (e) => console.error('[PC] Audio player error:', e?.message || e));
      }
    } catch (e) {
      console.error('[PC] Failed to play join sound:', e?.message || e);
    }
  } else {
    if (existing) {
      const ch = guild.channels.cache.get(existing.joinConfig.channelId);
      try { existing.destroy(); log(`Left #${ch?.name || existing.joinConfig.channelId} (no longer alone together).`); } catch (e) {
        console.error('[PC] Failed to leave voice:', e?.message || e);
      }
    }
  }
}

client.on('guildUnavailable', (guild) => {
  try { getVoiceConnection(guild.id)?.destroy(); } catch {}
});

process.on('unhandledRejection', (err) => console.error('[PC] Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[PC] Uncaught exception:', err));

client.login(TOKEN);
