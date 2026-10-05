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

    // 處理群組內的「圖片」或「影片」
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

      // 先刪除原圖
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {}

      // 💡 關鍵改變：優先使用 media_group_id，若無則降級為 「chatId + senderId + 時間區段(以10秒為單位)」
      const timeBlock = Math.floor(msg.date / 5); // 5秒的時間視窗
      const groupKeyId = msg.media_group_id || `${chatId}_${senderId}_${timeBlock}`;
      
      const groupKey = `album:${groupKeyId}`;
      const counterKey = `album_count:${groupKeyId}`;

      // 1. 推入 Redis
      await redis.rpush(groupKey, JSON.stringify({ fileId, type, caption }));
      await redis.expire(groupKey, 86400);

      // 2. 只有第一個請求發文
      const count = await redis.incr(counterKey);
      await redis.expire(counterKey, 15);

      if (count === 1) {
        // 等待 2.5 秒，讓同一次上傳的所有圖片（包含匿名發圖）全部收集進 Redis
        await sleep(2500);

        const rawItems = await redis.lrange(groupKey, 0, -1);
        const items = rawItems.map(item => (typeof item === 'string' ? JSON.parse(item) : item));

        // 自動掃描所有圖片，找出那張有帶 C: 文字的圖片
        const finalCaption = items.find(i => i.caption && i.caption.trim())?.caption || '';

        const mediaToken = Math.random().toString(36).substring(2, 10);
        
        // 寫入 Redis 供私聊「爽看」
        await redis.set(mediaToken, { isGroup: items.length > 1, items, fileId: items[0].fileId, type: items[0].type });

        // 組合訊息資訊
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

        // 同步備份至私人頻道
        if (BACKUP_CHANNEL_ID && items.length > 0) {
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

        // 發送群組唯一的按鈕訊息
        await bot.sendMessage(chatId, detailInfo, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '👁️ 爽看', url: startUrl },
                { text: '💬 入谷', url: APPLY_GROUP_URL },
                { text: '🍔 谷睇', url: channelMsgLink }
              ]
            ]
          }
        });

        // 清除快取
        await redis.del(groupKey);
        await redis.del(counterKey);
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

        if (data.isGroup && Array.isArray(data.items)) {
          const mediaGroupPayload = data.items.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            caption: index === 0 ? privateCaption : '',
            protect_content: true
          }));

          sentMessages = await bot.sendMediaGroup(chatId, mediaGroupPayload);
        } else {
          let sentMsg;
          if (data.type === 'photo') {
            sentMsg = await bot.sendPhoto(chatId, data.fileId, {
              caption: privateCaption,
              protect_content: true
            });
          } else if (data.type === 'video') {
            sentMsg = await bot.sendVideo(chatId, data.fileId, {
              caption: privateCaption,
              protect_content: true
            });
          }
          if (sentMsg) sentMessages.push(sentMsg);
        }

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
