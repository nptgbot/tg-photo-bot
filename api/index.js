const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const redis = Redis.fromEnv();

const token = process.env.BOT_TOKEN || '8894128453:AAHqR_BaE_WN00CKugjh_hqg79dbX_B5iKY';
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-1004320576547'; 
const APPLY_GROUP_URL = process.env.APPLY_GROUP_URL || 'https://t.me/+rz1gdgLB7dtlYWE1'; 
const BACKUP_CHANNEL_URL = process.env.BACKUP_CHANNEL_URL || 'https://t.me/+your_channel_invite_link'; 

// 必填訂閱頻道
const REQUIRED_CHANNEL = '@nptg9';

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

// 檢查用戶是否已訂閱頻道
async function checkSubscription(userId) {
  try {
    const member = await bot.getChatMember(REQUIRED_CHANNEL, userId);
    return ['creator', 'administrator', 'member'].includes(member.status);
  } catch (e) {
    console.error('檢查頻道訂閱失敗:', e.message);
    return true; // 出錯時預設放行
  }
}

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

      // 刪除群組原圖
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {}

      // 建立相冊 Session
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

      // 推入 Redis
      await redis.rpush(groupKey, JSON.stringify({ fileId, type, caption }));
      await redis.expire(groupKey, 86400);

      // 主控者競爭
      const isMaster = await redis.set(lockKey, 'locked', { nx: true, ex: 15 });

      if (isMaster) {
        // 等待 4 秒聚集所有相片
        await sleep(4000);

        if (!msg.media_group_id) {
          const currentSession = await redis.get(sessionKey);
          if (currentSession === groupKeyId) {
            await redis.del(sessionKey);
          }
        }

        const rawItems = await redis.lrange(groupKey, 0, -1);
        if (!rawItems || rawItems.length === 0) return res.status(200).send('OK');

        const items = rawItems.map(item => (typeof item === 'string' ? JSON.parse(item) : item));
        const finalCaption = items.find(i => i.caption && i.caption.trim())?.caption || '';

        const mediaToken = Math.random().toString(36).substring(2, 10);
        
        // 保存完整的媒體陣列資料
        await redis.set(mediaToken, JSON.stringify({ 
          items: items 
        }), { ex: 86400 });

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

        // 轉發私人頻道備份
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

        // 群組發送唯一訊息
        await bot.sendMessage(chatId, detailInfo, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '👁️️ 密看', url: startUrl },
                { text: '💬 入谷', url: APPLY_GROUP_URL },
                { text: '🍔 谷睇', url: channelMsgLink }
              ]
            ]
          }
        });

        await redis.del(groupKey);
      }
    }

    // 處理私聊 /start (點擊密看)
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const mediaToken = msg.text.split(' ')[1];

      // 1. 檢查頻道訂閱
      const isSubscribed = await checkSubscription(userId);
      if (!isSubscribed) {
        await bot.sendMessage(chatId, `⚠️ **必須先訂閱官方頻道才能解鎖觀看！**\n\n請先加入頻道後，重新點擊「密看」按鈕。`, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📢 點此加入頻道', url: 'https://t.me/nptg9' }]
            ]
          }
        });
        return res.status(200).send('OK');
      }

      let rawData = await redis.get(mediaToken);
      if (!rawData) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
        return res.status(200).send('OK');
      }

      const data = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
      const items = data.items || (data.fileId ? [{ fileId: data.fileId, type: data.type || 'photo' }] : []);

      if (items.length === 0) {
        await bot.sendMessage(chatId, '❌ 找不到多媒體檔案。');
        return res.status(200).send('OK');
      }

      const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後銷毀！`;
      let sentMessages = [];

      // 💡 嘗試使用 MediaGroup 發送相冊
      if (items.length > 1) {
        try {
          const mediaGroupPayload = items.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            caption: index === 0 ? privateCaption : '',
            protect_content: true
          }));
          sentMessages = await bot.sendMediaGroup(chatId, mediaGroupPayload);
        } catch (err) {
          console.error('MediaGroup 私聊發送失敗，改用逐張發送保底:', err.message);
          sentMessages = [];
        }
      }

      // 💡 保底機制：如果非相冊或 MediaGroup 失敗，逐張保證全部發出！
      if (sentMessages.length === 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cap = i === 0 ? privateCaption : '';
          try {
            let sentMsg;
            if (item.type === 'photo') {
              sentMsg = await bot.sendPhoto(chatId, item.fileId, { caption: cap, protect_content: true });
            } else {
              sentMsg = await bot.sendVideo(chatId, item.fileId, { caption: cap, protect_content: true });
            }
            if (sentMsg) sentMessages.push(sentMsg);
          } catch (e) {
            console.error(`第 ${i + 1} 張照片發送失敗:`, e.message);
          }
        }
      }

      // 定時自動刪除全部已發出的私聊訊息
      setTimeout(async () => {
        for (const m of sentMessages) {
          try {
            await bot.deleteMessage(chatId, m.message_id);
          } catch (e) {}
        }
      }, DELETE_DELAY_SECONDS * 1000);
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }

  return res.status(200).send('OK');
};
