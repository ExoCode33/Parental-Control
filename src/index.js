// Parental Control bot — ESM index.js (full file with runtime setup)
// Joins a voice channel ONLY when two specific users are alone together.
// Presence shows: "Watching youeatra".
// Supports env names: DISCORD_TOKEN, USER_A_ID, USER_B_ID, JOIN_AUDIO, JOIN_VOLUME, DEBUG
// Also supports: WATCH_IDS, WATCH_ID_1, WATCH_ID_2, SOUND_FILE, COOLDOWN_MS, DM_USER, DM_MESSAGE
// Runtime setup (if env missing): /pc_set, /pc_status, /pc_clear (saved to watchers.json)

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

// === CONFIG (reads multiple env variants to match your setup) ===
const TOKEN = process.env.DISCORD_TOKEN || process.env.TOKEN;

// Watcher IDs (prefer combined WATCH_IDS, else USER_A_ID/USER_B_ID, else WATCH_ID_1/WATCH_ID_2)
const ENV_USER_A = process.env.USER_A_ID || process.env.WATCH_ID_1;
const ENV_USER_B = process.env.USER_B_ID || process.env.WATCH_ID_2;
const ENV_COMBINED = process.env.WATCH_IDS || '';

// Audio path & volume (JOIN_AUDIO/JOIN_VOLUME aliases supported)
const SOUND_FILE = process.env.SOUND_FILE || process.env.JOIN_AUDIO || 'sounds/The Going Merry One Piece.ogg';
const JOIN_VOLUME = (() => {
  const v = parseFloat(process.env.JOIN_VOLUME);
  if (Number.isFinite(v)) return Math.max(0, Math.min(2, v)); // clamp 0..2
  return 0.75;
})();

// Cooldown ms and debug flag
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 8000);
const DEBUG = ['1','true','yes','on'].includes(String(process.env.DEBUG || '').toLowerCase());
