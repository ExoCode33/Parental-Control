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
const WELCOME_AUDIO = process.env.WELCOME_AUDIO || 'sounds/The Going Merry One Piece.ogg';
const DEBUG = process.env.DEBUG === '1'; // set DEBUG=1 in Railway to enable verbose logs

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

  // subscribe a player
  const player = getOrCreatePlayer(guildId);
  connection.subscribe(player);

  // optional gr
