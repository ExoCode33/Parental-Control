import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection
} from '@discordjs/voice';
import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import ffmpeg from 'ffmpeg-static';

// ======= ENV =======
const TOKEN = process.env.DISCORD_TOKEN;
const USER_A_ID = process.env.USER_A_ID?.trim();
const USER_B_ID = process.env.USER_B_ID?.trim();

// Join sound (new): use JOIN_AUDIO first, then WELCOME_AUDIO (back-compat), else default path
const JOIN_AUDIO = process.env.JOIN_AUDIO || process.env.WELCOME_AUDIO || 'sounds/The Going Merry One Piece.ogg';
const JOIN_VOLUME = Math.min(1, Math.max(0, Number(process.env.JOIN_VOLUME) || 1));

const DEBUG = process.env.DEBUG === '1'; // set DEBUG=1 for verbose logs

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!USER_A_ID) throw new Error('Missing USER_A_ID');
if (!USER_B_ID) throw new Error('Missing USER_B_ID');

// ======= LOG HELPERS =======
const log = (...a) => console.log('[BOT]', ...a);
const warn = (...a) => console.warn('[WARN]', ...a);
const err = (...a) => console.error('[ERR]', ...a);
const dbg = (...a) => { if (DEBUG) console.log('[DEBUG]', ...a); };

// ======= CLIENT =======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.GuildMember],
});

// ======= AUDIO =======
const players = new Map(); // guildId -> AudioPlayer

function getOrCreatePlayer(guildId) {
  if (players.has(guildId)) return players.get(guildId);
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  player.on('error', (e) => err(`Audio player error (guild ${guildId}):`, e?.message));
  player.on(AudioPlayerStatus.Idle, () => {});
  players.set(guildId, player);
  return player;
}

async function playJoinSound(player) {
  const fullPath = path.isAbsolute(JOIN_AUDIO) ? JOIN_AUDIO : path.join(process.cwd(), JOIN_AUDIO);

  if (!fs.existsSync(fullPath)) {
    dbg('Join sound not found, skipping:', fullPath);
    return;
  }

  try {
    log(`[SOUND] join -> ${fullPath} (vol=${JOIN_VOLUME})`);
    const ff = new prism.FFmpeg({
      args: ['-hide_banner','-loglevel','error','-i', fullPath,'-f','s16le','-ar','48000','-ac','2'],
      shell: false,
      executable: ffmpeg || undefined,
    });
    const opus = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    const stream = ff.pipe(opus);

    const resource = createAudioResource(stream, { inlineVolume: true });
    if (resource.volume) resource.volume.setVolume(JOIN_VOLUME);

    player.play(resource);
  } catch (e) {
    err('Failed to play join sound:', e?.message);
  }
}

async function connectAndGreet(channel) {
  const guildId = channel.guild.id;

  // move if already connected
  let conn = getVoiceConnection(guildId);
  if (conn) {
    if (conn.joinConfig.channelId === channel.id) return conn;
    log(`[MOVE] ${channel.guild.name}: -> #${channel.name} (${channel.id})`);
    conn.destroy();
  } else {
    log(`[JOIN] ${channel.guild.name}: #${channel.name} (${channel.id})`);
  }

  // connect
  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (e) {
    err(`Failed to connect to "${channel.name}" in ${channel.guild.name}:`, e?.message);
    try { connection?.destroy(); } catch {}
    return null;
  }

  // subscribe a player & play the join sound
  const player = getOrCreatePlayer(guildId);
  connection.subscribe(player);
  await playJoinSound(player);

  // resilience
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      dbg('Voice connection recovered after Disconnected.');
    } catch {
      log(`[LEAVE] ${channel.guild.name}: voice connection closed`);
      connection.destroy();
    }
  });

  return connection;
}

// ======= LOGIC =======
async function resolveTargetChannel(guild) {
  try {
    const [mA, mB] = await Promise.all([
      guild.members.fetch(USER_A_ID).catch(() => null),
      guild.members.fetch(USER_B_ID).catch(() => null),
    ]);

    if (!mA) dbg(`[TRACK] USER_A_ID ${USER_A_ID} not found in guild ${guild.name}`);
    if (!mB) dbg(`[TRACK] USER_B_ID ${USER_B_ID} not found in guild ${guild.name}`);

    const chA = mA?.voice?.channel ?? null;
    const chB = mB?.voice?.channel ?? null;

    dbg(`[CHECK] ${guild.name}: A in ${chA ? `#${chA.name}(${chA.id})` : 'none'}; B in ${chB ? `#${chB.name}(${chB.id})` : 'none'}`);

    if (!chA || !chB) return null;
    if (chA.id !== chB.id) return null;

    log(`[MATCH] ${guild.name}: both users are in #${chA.name} (${chA.id})`);
    return chA; // both in same VC
  } catch (e) {
    dbg(`[CHECK] ${guild.name}: resolveTargetChannel error: ${e?.message}`);
    return null;
  }
}

async function reconcileGuild(guild) {
  try {
    const target = await resolveTargetChannel(guild);
    const conn = getVoiceConnection(guild.id);

    if (target) {
      const me = guild.members.me || await guild.members.fetchMe();
      const perms = target.permissionsFor(me);
      if (!perms?.has(PermissionsBitField.Flags.Connect)) {
        warn(`[PERM] Missing Connect in #${target.name} (${guild.name})`);
        if (conn) conn.destroy();
        return;
      }
      if (!conn || conn.joinConfig.channelId !== target.id) {
        await connectAndGreet(target);
      } else {
        dbg(`[OK] Already in correct channel #${target.name} (${target.id})`);
      }
    } else {
      if (conn) {
        log(`[LEAVE] ${guild.name}: users no longer together`);
        conn.destroy();
      } else {
        dbg(`[IDLE] ${guild.name}: no match; not connected`);
      }
    }
  } catch (e) {
    err(`[RECONCILE] ${guild.name}:`, e?.message);
  }
}

// ======= EVENTS =======
client.on('voiceStateUpdate', async (oldState, newState) => {
  const uid = (newState.member || oldState.member)?.id;
  const before = oldState.channelId || 'none';
  const after = newState.channelId || 'none';
  if (uid === USER_A_ID || uid === USER_B_ID) {
    dbg(`[TRACK] voiceStateUpdate for ${uid}: ${before} -> ${after}`);
  } else {
    dbg(`[SKIP] voiceStateUpdate for untracked user ${uid}: ${before} -> ${after}`);
  }
  const guild = newState.guild || oldState.guild;
  await reconcileGuild(guild);
});

// Only use clientReady (no deprecation)
let didReady = false;
client.once('clientReady', async () => {
  if (didReady) return;
  didReady = true;

  log(`[READY] Logged in as ${client.user.tag}. Watching ${USER_A_ID} & ${USER_B_ID}. DEBUG=${DEBUG ? 'on' : 'off'}`);
  for (const [, guild] of client.guilds.cache) {
    await reconcileGuild(guild);
  }
});

client.on('error', (e) => err('Client error:', e?.message));
process.on('unhandledRejection', (e) => err('UnhandledRejection:', e));
process.on('uncaughtException', (e) => err('UncaughtException:', e));

// ======= START =======
client.login(TOKEN);
