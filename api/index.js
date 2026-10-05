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
    return true; 
  }
}

module.exports = async (req, res) => {
  let update = req.body;
  if (typeof update === 'string') {
    try { update = JSON.parse(update); } catch (e) {}
  }

  if (req.method !== 'POST' || !update) {
    return res.status(200).send('Bot Server is Running!');
  }

  try {
    const msg = update.message;

    // 群組內發送的相片或影片
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

      let items = [];
      let finalCaption = caption;

      // 💡 提速與修復核心：如果是相冊 (有多張圖)，才進行 Redis 聚合等待
      if (msg.media_group_id) {
        const groupKey = `album:${msg.media_group_id}`;
        const lockKey = `lock:${msg.media_group_id}`;

        // 推入 Redis
        await redis.rpush(groupKey, JSON.stringify({ fileId, type, caption }));
        await redis.expire(groupKey, 86400);

        // 主控者競爭
        const isMaster = await redis.set(lockKey, 'locked', { nx: true, ex: 15 });

        if (!isMaster) {
          // 不是主控者，直接結束 webhook，讓主控者收集
          return res.status(200).send('OK');
        }

        // 💡 主控者等待時間從 4 秒縮短為 2 秒 (相冊收集)
        await sleep(2000);

        const rawItems = await redis.lrange(groupKey, 0, -1);
        items = rawItems.map(item => {
          if (typeof item === 'string') {
            try { return JSON.parse(item); } catch (e) { return null; }
          }
          return item;
        }).filter(Boolean);

        finalCaption = items.find(i => i.caption && i.caption.trim())?.caption || '';
        await redis.del(groupKey);
      } else {
        // 💡 如果是單張圖片/影片，無需等待，直接 0 秒處理！
        items = [{ fileId, type, caption }];
      }

      if (items.length === 0) return res.status(200).send('OK');

      const mediaToken = Math.random().toString(36).substring(2, 10);
      
      // 直接存入字串化 JSON 防止 Upstash 解析異常
      await redis.set(mediaToken, JSON.stringify({ items }), { ex: 86400 });

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
              type: item.type || 'photo',
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
          console.error('轉發備份失敗:', e.message);
        }
      }

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

      // 發送群組按鈕
      await bot.sendMessage(chatId, detailInfo, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '👁 密看', url: startUrl },
              { text: '💬 入谷', url: APPLY_GROUP_URL },
              { text: '🍔 谷睇', url: channelMsgLink }
            ]
          ]
        }
      });
    }

    // 處理私聊 /start (點擊密看)
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const mediaToken = msg.text.split(' ')[1];

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

      let data = await redis.get(mediaToken);
      if (!data) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
        return res.status(200).send('OK');
      }

      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (e) {}
      }

      const items = Array.isArray(data.items) ? data.items : (data.fileId ? [{ fileId: data.fileId, type: data.type || 'photo' }] : []);

      if (items.length === 0) {
        await bot.sendMessage(chatId, '❌ 找不到多媒體檔案。');
        return res.status(200).send('OK');
      }

      const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後銷毀！`;
      let sentMessages = [];

      // 💡 修正發送相冊：protect_content 必須放在第 3 個參數 (options) 中！
      if (items.length > 1) {
        try {
          const mediaGroupPayload = items.map((item, index) => ({
            type: item.type || 'photo',
            media: item.fileId,
            caption: index === 0 ? privateCaption : ''
          }));
          // 正確的 Telegram 官方防側錄寫法
          sentMessages = await bot.sendMediaGroup(chatId, mediaGroupPayload, { protect_content: true });
        } catch (err) {
          console.error('相冊發送失敗:', err.message);
          sentMessages = []; // 失敗則退回單張發送保底
        }
      }

      // 逐張發送保底 (單圖，或相冊發送異常時)
      if (!sentMessages || sentMessages.length === 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cap = (i === 0) ? privateCaption : '';
          try {
            let sentMsg;
            if (item.type === 'video') {
              sentMsg = await bot.sendVideo(chatId, item.fileId, { caption: cap, protect_content: true });
            } else {
              sentMsg = await bot.sendPhoto(chatId, item.fileId, { caption: cap, protect_content: true });
            }
            if (sentMsg) sentMessages.push(sentMsg);
          } catch (e) {
            console.error(`第 ${i + 1} 張發送失敗:`, e.message);
          }
        }
      }

      // 自動銷毀
      setTimeout(async () => {
        for (const m of sentMessages) {
          try { await bot.deleteMessage(chatId, m.message_id); } catch (e) {}
        }
      }, DELETE_DELAY_SECONDS * 1000);
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }

  return res.status(200).send('OK');
};
