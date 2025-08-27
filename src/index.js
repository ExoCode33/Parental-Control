// src/index.js
// DM Relay Bot — sends a DM to a chosen user and relays their DM replies back to the invoking channel.
//
// Env vars required:
//   DISCORD_TOKEN = your bot token
//   CLIENT_ID     = your application (bot) client ID
// Optional (faster command registration while testing):
//   GUILD_ID      = a guild to register commands to (guild-scoped). Omit to register globally.
//
// Intents: We do NOT request Message Content to avoid "Used disallowed intents" issues.
// DM message content is available without that privileged intent.

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;

if (!DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');
if (!CLIENT_ID) throw new Error('Missing CLIENT_ID');

// -----------------------------
// Client & Session State
// -----------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,          // slash commands & channel access
    GatewayIntentBits.GuildMessages,   // to post relayed messages into guild channels
    GatewayIntentBits.DirectMessages,  // to receive DMs from users
  ],
  partials: [Partials.Channel],        // required to receive DMs
  allowedMentions: { parse: ['users'], repliedUser: false },
});

// dmChannelId -> session
// session = { originChannelId, targetUserId, invokerId, expiresAt }
const sessionsByDM = new Map();

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [dmId, s] of sessionsByDM.entries()) {
    if (now > s.expiresAt) sessionsByDM.delete(dmId);
  }
}, 30_000);

// -----------------------------
// Slash Commands
// -----------------------------
const dmrelayCmd = new SlashCommandBuilder()
  .setName('dmrelay')
  .setDescription('DM a user and relay their DM replies back into this channel for a while.')
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('Who to DM')
      .setRequired(true))
  .addStringOption(opt =>
    opt.setName('message')
      .setDescription('What to send them')
      .setRequired(true))
  .addIntegerOption(opt =>
    opt.setName('timeout_minutes')
      .setDescription('How long to keep relaying replies (default 10, max 120)')
      .setMinValue(1)
      .setMaxValue(120)
      .setRequired(false));

const endrelayCmd = new SlashCommandBuilder()
  .setName('endrelay')
  .setDescription('Stop relaying replies for a previously started /dmrelay session.')
  .addUserOption(opt =>
    opt.setName('user')
      .setDescription('Which user’s relay to stop')
      .setRequired(true));

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const body = [dmrelayCmd, endrelayCmd].map(c => c.toJSON());

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
    console.log(`[CMD] Registered guild commands in ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log('[CMD] Registered global commands');
  }
}

// -----------------------------
// Event Wiring
// -----------------------------
client.once(Events.ClientReady, async (c) => {
  console.log(`[READY] Logged in as ${c.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('[CMD] Failed to register commands:', err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'dmrelay') {
      const target = interaction.options.getUser('user', true);
      const text = interaction.options.getString('message', true);
      const timeout = interaction.options.getInteger('timeout_minutes') ?? 10;

      // Create/ensure DM and send initial message
      let dm;
      try {
        dm = await target.createDM();
      } catch (e) {
        await interaction.reply({ content: `❌ I can’t DM ${target}. They may have DMs closed.`, ephemeral: true });
        return;
      }

      const originChannelId = interaction.channelId;
      const expiresAt = Date.now() + timeout * 60_000;

      // Record the relay session keyed by the DM channel id
      sessionsByDM.set(dm.id, {
        originChannelId,
        targetUserId: target.id,
        invokerId: interaction.user.id,
        expiresAt,
      });

      // Notify the target in DM
      const originChannel = await interaction.client.channels.fetch(originChannelId).catch(() => null);
      const originChannelName = originChannel?.name ? `#${originChannel.name}` : 'the channel';

      const intro =
        `**${interaction.user.tag}** asked me to reach out.\n` +
        `Reply here and I’ll relay your messages back to **${originChannelName}** for the next **${timeout} min**.\n\n` +
        `**Message from ${interaction.user.tag}:** ${text}`;

      try {
        await dm.send({ content: intro });
      } catch (e) {
        sessionsByDM.delete(dm.id);
        await interaction.reply({ content: `❌ I couldn’t send a DM to ${target}. They may have DMs closed.`, ephemeral: true });
        return;
      }

      await interaction.reply({
        content: `✅ DM sent to ${target}. I’ll relay their replies here for **${timeout} min**.\nUse \`/endrelay\` to stop early.`,
        ephemeral: false,
      });
    }

    if (interaction.commandName === 'endrelay') {
      const target = interaction.options.getUser('user', true);
      // Find DM channel for the target and remove session
      const dm = await target.createDM().catch(() => null);
      if (!dm) {
        await interaction.reply({ content: `⚠️ I can’t open a DM with ${target}. If they had a session, it’s already gone.`, ephemeral: true });
        return;
      }

      const existed = sessionsByDM.delete(dm.id);
      if (existed) {
        await interaction.reply({ content: `🛑 Relay with ${target} has been stopped.`, ephemeral: true });
      } else {
        await interaction.reply({ content: `ℹ️ There isn’t an active relay for ${target}.`, ephemeral: true });
      }
    }

  } catch (err) {
    console.error('[INT] Error handling interaction:', err);
    if (interaction.isRepliable() && !interaction.replied) {
      await interaction.reply({ content: '❌ Something went wrong handling that command.', ephemeral: true }).catch(() => {});
    }
  }
});

// Relay DMs -> origin channel
client.on(Events.MessageCreate, async (message) => {
  try {
    // Only care about DMs from humans
    if (message.guild) return;            // not a DM
    if (message.author?.bot) return;

    const session = sessionsByDM.get(message.channelId);
    if (!session) return;

    // Ensure this DM is from the expected target user
    if (message.author.id !== session.targetUserId) return;

    // Check expiry
    if (Date.now() > session.expiresAt) {
      sessionsByDM.delete(message.channelId);
      return;
    }

    const origin = await client.channels.fetch(session.originChannelId).catch(() => null);
    if (!origin || !origin.isTextBased()) {
      sessionsByDM.delete(message.channelId);
      return;
    }

    const contentText = (message.content && message.content.trim().length)
      ? message.content
      : '';

    const attachmentUrls = [...message.attachments.values()].map(a => a.url);
    const stickerNames = [...message.stickers.values()].map(s => s.name);

    let relay = `📩 **Reply from ${message.author.tag}**`;
    if (contentText) relay += `\n${contentText}`;
    if (stickerNames.length) relay += `\n[Stickers: ${stickerNames.join(', ')}]`;
    if (attachmentUrls.length) relay += `\n${attachmentUrls.join('\n')}`;

    await origin.send({ content: relay });

  } catch (err) {
    console.error('[DM] Error relaying DM:', err);
  }
});

// -----------------------------
// Start
// -----------------------------
client.login(DISCORD_TOKEN).catch((e) => {
  console.error('[LOGIN] Failed to log in:', e);
  process.exit(1);
});
