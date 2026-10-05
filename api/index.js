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

      // 刪除群組原圖/影片
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {}

      // 💡 功能 1：檢測到用戶一次性上載多個圖/影片 (帶有 media_group_id)
      if (msg.media_group_id) {
        const warnKey = `warn:${chatId}_${msg.media_group_id}`;
        // 使用 Redis 確保同一次多圖上載只發送一次提示，避免頻繁刷屏
        const hasWarned = await redis.set(warnKey, '1', { nx: true, ex: 10 });
        
        if (hasWarned) {
          const warnMsg = await bot.sendMessage(chatId, '⚠️ **檢測到一次性上載多個檔案！**\n本 Bot 僅支援單張圖片/影片上載，請改為**分批單獨上載**。', { parse_mode: 'Markdown' });
          
          // 1 分鐘 (60 秒) 後自動刪除提示訊息
          setTimeout(async () => {
            try { await bot.deleteMessage(chatId, warnMsg.message_id); } catch (e) {}
          }, 60000);
        }
        return res.status(200).send('OK');
      }

      // 處理單圖 / 單影片
      let fileId = '';
      let type = 'photo';

      if (msg.photo) {
        type = 'photo';
        fileId = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.video) {
        type = 'video';
        fileId = msg.video.file_id;
      }

      const mediaToken = Math.random().toString(36).substring(2, 10);
      
      // 寫入 Redis 供私聊「密看」讀取
      await redis.set(mediaToken, { fileId, type }, { ex: 86400 });

      // 組合訊息資訊
      const detailInfoLines = [];
      if (!isAnonymousAdmin) {
        detailInfoLines.push(`👤 **P**：${senderName} (${senderUsername})`);
      }
      detailInfoLines.push(`⏰ **T**：${sendTime}`);

      if (caption.trim()) {
        detailInfoLines.push(`💬 **C**：${caption.trim()}`);
      }

      const detailInfo = detailInfoLines.join('\n');
      let channelMsgLink = BACKUP_CHANNEL_URL;

      // 轉發私人頻道備份
      if (BACKUP_CHANNEL_ID) {
        try {
          let backupMsg;
          if (type === 'photo') {
            backupMsg = await bot.sendPhoto(BACKUP_CHANNEL_ID, fileId, { caption: detailInfo, parse_mode: 'Markdown' });
          } else {
            backupMsg = await bot.sendVideo(BACKUP_CHANNEL_ID, fileId, { caption: detailInfo, parse_mode: 'Markdown' });
          }
          if (backupMsg) channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsg.message_id);
        } catch (e) {
          console.error('轉發備份失敗:', e.message);
        }
      }

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

      // 群組發送按鈕
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

      // 檢查頻道訂閱
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

      const data = await redis.get(mediaToken);
      if (!data) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
        return res.status(200).send('OK');
      }

      const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後銷毀！`;
      let sentMsg;

      if (data.type === 'video') {
        sentMsg = await bot.sendVideo(chatId, data.fileId, { caption: privateCaption, protect_content: true });
      } else {
        sentMsg = await bot.sendPhoto(chatId, data.fileId, { caption: privateCaption, protect_content: true });
      }

      // 定時自動銷毀
      if (sentMsg) {
        setTimeout(async () => {
          try { await bot.deleteMessage(chatId, sentMsg.message_id); } catch (e) {}
        }, DELETE_DELAY_SECONDS * 1000);
      }
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }

  return res.status(200).send('OK');
};
