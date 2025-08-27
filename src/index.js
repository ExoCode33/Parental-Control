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

if (!TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!USER_A_ID) throw new Error('Missing USER_A_ID');
if (!USER_B_ID) throw new Error('Missing USER_B_ID');

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
  player.on('error', (err) => console.error(`[AUDIO] Player error (guild ${guildId}):`, err?.message));
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
    conn.destroy();
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
  } catch (err) {
    console.error(`[VOICE] Failed to connect to "${channel.name}":`, err?.message);
    try { connection?.destroy(); } catch {}
    return null;
  }

  // subscribe a player
  const player = getOrCreatePlayer(guildId);
  connection.subscribe(player);

  // optional greeting
  const fullPath = path.isAbsolute(WELCOME_AUDIO) ? WELCOME_AUDIO : path.join(process.cwd(), WELCOME_AUDIO);
  if (fs.existsSync(fullPath)) {
    try {
      const ff = new prism.FFmpeg({
        args: ['-hide_banner','-loglevel','error','-i', fullPath,'-f','s16le','-ar','48000','-ac','2'],
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

  // resilience
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

// ======= LOGIC =======
async function resolveTargetChannel(guild) {
  try {
    const [mA, mB] = await Promise.all([
      guild.members.fetch(USER_A_ID).catch(() => null),
      guild.members.fetch(USER_B_ID).catch(() => null),
    ]);
    const chA = mA?.voice?.channel ?? null;
    const chB = mB?.voice?.channel ?? null;
    if (!chA || !chB) return null;
    if (chA.id !== chB.id) return null;
    return chA; // both in same VC
  } catch {
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
        console.warn(`[VOICE] Missing Connect permission in #${target.name} (${guild.name})`);
        if (conn) conn.destroy();
        return;
      }
      if (!conn || conn.joinConfig.channelId !== target.id) {
        await connectAndGreet(target);
      }
    } else {
      if (conn) conn.destroy();
    }
  } catch (e) {
    console.error(`[RECONCILE] Guild ${guild.id}:`, e?.message);
  }
}

// ======= EVENTS =======
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  await reconcileGuild(guild);
});

client.once('ready', async () => {
  console.log(`[READY] Logged in as ${client.user.tag}. Watching ${USER_A_ID} & ${USER_B_ID}.`);
  for (const [, guild] of client.guilds.cache) {
    await reconcileGuild(guild);
  }
});

client.on('error', (e) => console.error('[CLIENT] Error:', e?.message));
process.on('unhandledRejection', (e) => console.error('[PROCESS] UnhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('[PROCESS] UncaughtException:', e));

// ======= START =======
client.login(TOKEN);
