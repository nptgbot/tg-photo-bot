const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const token = process.env.BOT_TOKEN || '8894128453:AAHqR_BaE_WN00CKugjh_hqg79dbX_B5iKY';
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-1004320576547'; 
const APPLY_GROUP_URL = process.env.APPLY_GROUP_URL || 'https://t.me/+rz1gdgLB7dtlYWE1'; 
const BACKUP_CHANNEL_URL = process.env.BACKUP_CHANNEL_URL || 'https://t.me/+your_channel_invite_link'; 

const bot = new TelegramBot(token);

function getChannelMessageLink(channelId, messageId) {
  if (!channelId) return BACKUP_CHANNEL_URL;
  const cleanId = channelId.toString().replace('-100', '');
  return `https://t.me/c/${cleanId}/${messageId}`;
}

function formatTimestamp(unixTimestamp) {
  const date = new Date(unixTimestamp * 1000);
  const utc8Date = new Date(date.getTime() + (8 * 60 + date.getTimezoneOffset()) * 60000);
  
  const year = utc8Date.getFullYear();
  const month = String(utc8Date.getMonth() + 1).padStart(2, '0');
  const day = String(utc8Date.getDate()).padStart(2, '0');
  const hours = String(utc8Date.getHours()).padStart(2, '0');
  const minutes = String(utc8Date.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async (req, res) => {
  let update = req.body;
  if (typeof update === 'string') {
    try {
      update = JSON.parse(update);
    } catch (e) {}
  }

  if (req.method !== 'POST' || !update) {
    return res.status(200).send('Bot Server is Running!');
  }

  try {
    const msg = update.message;

    if (msg && (msg.photo || msg.video)) {
      const chatId = msg.chat.id;
      const messageId = msg.message_id;
      const caption = msg.caption || '';
      
      const sender = msg.from || {};
      const senderId = sender.id || 'anon';
      const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || '未知用戶';
      const senderUsername = sender.username ? `@${sender.username}` : '無用戶名';
      const sendTime = formatTimestamp(msg.date);

      const isAnonymousAdmin = sender.username === 'GroupAnonymousBot' || senderId === 1087968824;

      let fileId = '';
      let type = 'photo';

      if (msg.photo) {
        type = 'photo';
        fileId = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.video) {
        type = 'video';
        fileId = msg.video.file_id;
      }

      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {}

      // 使用滑動視窗聚合多媒體
      let groupKeyId = msg.media_group_id;
      const sessionKey = `sess:${chatId}_${senderId}`;

      if (!groupKeyId) {
        groupKeyId = await redis.get(sessionKey);
        if (!groupKeyId) {
          groupKeyId = `batch_${Date.now()}`;
        }
        await redis.set(sessionKey, groupKeyId, { ex: 5 });
      }

      const groupKey = `album:${groupKeyId}`;
      const lockKey = `lock:${groupKeyId}`;

      // 1. 推入 Redis
      await redis.rpush(groupKey, JSON.stringify({ fileId, type, caption }));
      await redis.expire(groupKey, 86400);

      // 2. 鎖定主控端
      const isMaster = await redis.set(lockKey, 'locked', { nx: true, ex: 15 });

      if (isMaster) {
        // 等待 4 秒讓所有圖片傳完
        await sleep(4000);

        if (!msg.media_group_id) {
          const currentSession = await redis.get(sessionKey);
          if (currentSession === groupKeyId) {
            await redis.del(sessionKey);
          }
        }

        // 讀取所有圖片
        const rawItems = await redis.lrange(groupKey, 0, -1);
        if (!rawItems || rawItems.length === 0) return res.status(200).send('OK');

        const items = rawItems.map(item => (typeof item === 'string' ? JSON.parse(item) : item));

        const finalCaption = items.find(i => i.caption && i.caption.trim())?.caption || '';

        const mediaToken = Math.random().toString(36).substring(2, 10);
        
        // 💡 關鍵修復：在 4 秒收集完成後，正確寫入 isGroup 與完整的 items 陣列！
        await redis.set(mediaToken, { 
          isGroup: items.length > 1, 
          items: items, 
          fileId: items[0].fileId, 
          type: items[0].type 
        });

        const detailInfoLines = [];
        if (!isAnonymousAdmin) {
          detailInfoLines.push(`👤 **P**：${senderName} (${senderUsername})`);
        }
        detailInfoLines.push(`⏰ **T**：${sendTime}`);

        if (finalCaption.trim()) {
          detailInfoLines.push(`💬 **C**：${finalCaption.trim()}`);
        }

        const detailInfo = detailInfoLines.join('\n');
        let channelMsgLink = BACKUP_CHANNEL_URL;

        if (BACKUP_CHANNEL_ID) {
          try {
            if (items.length > 1) {
              const mediaGroupPayload = items.map((item, index) => ({
                type: item.type,
                media: item.fileId,
                caption: index === 0 ? detailInfo : '',
                parse_mode: 'Markdown'
              }));
              const backupMsgs = await bot.sendMediaGroup(BACKUP_CHANNEL_ID, mediaGroupPayload);
              if (backupMsgs && backupMsgs.length > 0) {
                channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsgs[0].message_id);
              }
            } else {
              let backupMsg;
              if (items[0].type === 'photo') {
                backupMsg = await bot.sendPhoto(BACKUP_CHANNEL_ID, items[0].fileId, { caption: detailInfo, parse_mode: 'Markdown' });
              } else {
                backupMsg = await bot.sendVideo(BACKUP_CHANNEL_ID, items[0].fileId, { caption: detailInfo, parse_mode: 'Markdown' });
              }
              if (backupMsg) channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsg.message_id);
            }
          } catch (e) {
            console.error('轉發私人頻道失敗:', e.message);
          }
        }

        const me = await bot.getMe();
        const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

        await bot.sendMessage(chatId, detailInfo, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '👁️ 密看', url: startUrl },
                { text: '💬 入谷', url: APPLY_GROUP_URL },
                { text: '🍔 谷睇', url: channelMsgLink }
              ]
            ]
          }
        });

        await redis.del(groupKey);
      }
    }

    // 處理私聊 /start
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const mediaToken = msg.text.split(' ')[1];

      const data = await redis.get(mediaToken);

      if (!data) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
      } else {
        const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後毀！`;
        let sentMessages = [];

        // 💡 讀取 items 發送多圖 Media Group
        if (data.isGroup && Array.isArray(data.items) && data.items.length > 1) {
          const mediaGroupPayload = data.items.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            caption: index === 0 ? privateCaption : '',
            protect_content: true
          }));

          sentMessages = await bot.sendMediaGroup(chatId, mediaGroupPayload);
        } else {
          let sentMsg;
          const targetFileId = data.fileId || (data.items && data.items[0]?.fileId);
          const targetType = data.type || (data.items && data.items[0]?.type) || 'photo';

          if (targetType === 'photo') {
            sentMsg = await bot.sendPhoto(chatId, targetFileId, {
              caption: privateCaption,
              protect_content: true
            });
          } else if (targetType === 'video') {
            sentMsg = await bot.sendVideo(chatId, targetFileId, {
              caption: privateCaption,
              protect_content: true
            });
          }
          if (sentMsg) sentMessages.push(sentMsg);
        }

        // 定時銷毀
        setTimeout(async () => {
          for (const m of sentMessages) {
            try {
              await bot.deleteMessage(chatId, m.message_id);
            } catch (e) {}
          }
        }, DELETE_DELAY_SECONDS * 1000);
      }
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }

  return res.status(200).send('OK');
};
