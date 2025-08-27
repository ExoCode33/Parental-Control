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

// ======= Config =======
const TOKEN = process.env.DISCORD_TOKEN;
const USER_A_ID = process.env.USER_A_ID?.trim();
const USER_B_ID = process.env.USER_B_ID?.trim();
const WELCOME_AUDIO = process.env.WELCOME_AUDIO || 'sounds/The Going Merry One Piece.ogg';

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!USER_A_ID) throw new Error('Missing USER_A_ID');
if (!USER_B_ID) throw new Error('Missing USER_B_ID');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // needed for voiceStateUpdate + member.voice
  ],
  partials: [Partials.GuildMember],
});

// Keep one player per guild
const players = new Map(); // guildId -> AudioPlayer

function getOrCreatePlayer(guildId) {
  if (players.has(guildId)) return players.get(guildId);
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on('error', (err) => console.error(`[AUDIO] Player error (guild ${guildId}):`, err?.message));
  player.on(AudioPlayerStatus.Idle, () => { /* idle ok */ });
  players.set(guildId, player);
  return player;
}

async function connectAndGreet(channel) {
  const guildId = channel.guild.id;

  // Already connected? move if needed
  let conn = getVoiceConnection(guildId);
  if (conn) {
    if (conn.joinConfig.channelId === channel.id) return conn;
    conn.destroy();
  }

  // Connect
  let connection;
  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (err) {
    console.error(`[VOICE] Failed to connect to "${channel.name}":`, err?.message);
    try { connection?.destroy(); } catch {}
    return null;
  }

  // Subscribe a player
  const player = getOrCreatePlayer(guildId);
  connection.subscribe(player);

  // Optional one-time greeting
  const fullPath = path.isAbsolute(WELCOME_AUDIO)
    ? WELCOME_AUDIO
    : path.join(process.cwd(), WELCOME_AUDIO);

  if (fs.existsSync(fullPath)) {
    try {
      const ff = new prism.FFmpeg({
        args: [
          '-hide_banner', '-loglevel', 'error',
          '-i', fullPath,
          '-f', 's16le', '-ar', '48000', '-ac', '2'
        ],
        shell: false,
        executable: ffmpeg || undefined,
      });
      const opus = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
      const stream = ff.pipe(opus);
      const resource = createAudioResource(stream);
      player.play(resource);
    } catch (e) {
      console.error('[AUDIO] Failed to play welcome audio:', e?.message);
    }
  }

  // Resilience
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });

  return connection;
}

/**
 * Resolve the target channel for a guild:
 * - Fetch USER_A_ID and USER_B_ID members (if present in guild)
 * - If both are in a voice channel and it's the SAME channel, return it.
 * - Otherwise return null.
 */
async function resolveTargetChannel(guild) {
  try {
    const [mA, mB] = await Promise.all([
      guild.members.fetch(USER_A_ID).catch(() => null),
      guild.members.fetch(USER_B_ID).catch(() => null),
    ]);
