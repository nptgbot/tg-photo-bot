const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

// 自動讀取 Vercel 與 Upstash 連線環境變數
const redis = Redis.fromEnv();

const token = process.env.BOT_TOKEN || '8894128453:AAHqR_BaE_WN00CKugjh_hqg79dbX_B5iKY';
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

// 💡 1. 你的私人頻道 ID
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-1004320576547'; 

// 💡 2. 申請入谷連結
const APPLY_GROUP_URL = process.env.APPLY_GROUP_URL || 'https://t.me/+rz1gdgLB7dtlYWE1'; 

// 💡 3. 私人頻道通用邀請連結
const BACKUP_CHANNEL_URL = process.env.BACKUP_CHANNEL_URL || 'https://t.me/+your_channel_invite_link'; 

const bot = new TelegramBot(token);

// 輔助函式：將 -100XXXXXX 轉為 Telegram 頻道內部跳轉連結格式
function getChannelMessageLink(channelId, messageId) {
  if (!channelId) return BACKUP_CHANNEL_URL;
  const cleanId = channelId.toString().replace('-100', '');
  return `https://t.me/c/${cleanId}/${messageId}`;
}

// 輔助函式：格式化時間 (轉為 YYYY-MM-DD HH:mm 格式)
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

// 輔助函式：延遲毫秒
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
      const caption = msg.caption || ''; // 讀取發圖者的文字
      const mediaGroupId = msg.media_group_id; // 多張連發時的唯一相冊 ID

      // 1. 抓取發送者資訊
      const sender = msg.from || {};
      const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || '未知用戶';
      const senderUsername = sender.username ? `@${sender.username}` : '無用戶名';
      const sendTime = formatTimestamp(msg.date);

      // 💡 判斷是否為匿名 Admin (GroupAnonymousBot)
      const isAnonymousAdmin = sender.username === 'GroupAnonymousBot' || sender.id === 1087968824;

      let fileId = '';
      let type = 'photo';

      if (msg.photo) {
        type = 'photo';
        fileId = msg.photo[msg.photo.length - 1].file_id;
      } else if (msg.video) {
        type = 'video';
        fileId = msg.video.file_id;
      }

      // 先刪除群組內的單張媒體訊息，避免佔用版面
      try {
        await bot.deleteMessage(chatId, messageId);
      } catch (e) {}

      // 如果是「多圖/多影片連發 (Media Group)」
      if (mediaGroupId) {
        const groupKey = `album:${mediaGroupId}`;
        const groupLockKey = `album_lock:${mediaGroupId}`;

        // 將這張圖片/影片的資料放入 Redis 的 Array 列表中
        await redis.rpush(groupKey, JSON.stringify({ fileId, type, caption }));
        await redis.expire(groupKey, 86400); // 設置 1 天過期防殘留

        // 使用 Redis 鎖定機制，確保只由「第一個接收到的請求」負責最終處理與發文
        const isFirst = await redis.set(groupLockKey, 'locked', { nx: true, ex: 10 });

        if (isFirst) {
          // 等待 1.5 秒讓 Telegram 把整組相簿的圖片都傳完
          await sleep(1500);

          // 讀取這組相冊收集到的所有多媒體資料
          const rawItems = await redis.lrange(groupKey, 0, -1);
          const items = rawItems.map(item => (typeof item === 'string' ? JSON.parse(item) : item));

          // 尋找相冊中帶有 caption 的文字說明（Telegram 通常只放在第一張）
          const finalCaption = items.find(i => i.caption && i.caption.trim())?.caption || '';

          const mediaToken = Math.random().toString(36).substring(2, 10);
          
          // 💡 將整組媒體 Array 寫入 Redis，永久保存
          await redis.set(mediaToken, { isGroup: true, items });

          // 動態組合資訊（如果是 Admin 匿名發文，則不顯示 P: 行）
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

          // 同步備份整個相冊至私人頻道
          if (BACKUP_CHANNEL_ID && items.length > 0) {
            try {
              const mediaGroupPayload = items.map((item, index) => ({
                type: item.type,
                media: item.fileId,
                caption: index === 0 ? detailInfo : '', // 僅在第一張照片帶文字
                parse_mode: 'Markdown'
              }));

              const backupMsgs = await bot.sendMediaGroup(BACKUP_CHANNEL_ID, mediaGroupPayload);
              if (backupMsgs && backupMsgs.length > 0) {
                channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsgs[0].message_id);
              }
            } catch (e) {
              console.error('轉發私人頻道相冊失敗:', e.message);
            }
          }

          const me = await bot.getMe();
          const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

          // 發送群組統一按鈕（只會發送一條訊息）
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

          // 清理相冊快取 Key
          await redis.del(groupKey);
          await redis.del(groupLockKey);
        }
      } 
      // 如果是「單張圖片或單個影片」
      else {
        const mediaToken = Math.random().toString(36).substring(2, 10);

        // 寫入單一媒體項目，永久保存
        await redis.set(mediaToken, { isGroup: false, fileId, type });

        // 動態組合資訊（如果是 Admin 匿名發文，則不顯示 P: 行）
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

        if (BACKUP_CHANNEL_ID) {
          try {
            let backupMsg;
            if (type === 'photo') {
              backupMsg = await bot.sendPhoto(BACKUP_CHANNEL_ID, fileId, {
                caption: detailInfo,
                parse_mode: 'Markdown'
              });
            } else if (type === 'video') {
              backupMsg = await bot.sendVideo(BACKUP_CHANNEL_ID, fileId, {
                caption: detailInfo,
                parse_mode: 'Markdown'
              });
            }

            if (backupMsg && backupMsg.message_id) {
              channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsg.message_id);
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
                { text: '👁️ 爽看', url: startUrl },
                { text: '💬 入谷', url: APPLY_GROUP_URL },
                { text: '🍔 谷睇', url: channelMsgLink }
              ]
            ]
          }
        });
      }
    }

    // 處理私聊 /start (點擊爽看時觸發)
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const mediaToken = msg.text.split(' ')[1];

      // 從 Redis 讀取媒體資料
      const data = await redis.get(mediaToken);

      if (!data) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
      } else {
        const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後毀！`;
        let sentMessages = [];

        // 1. 如果是多張相簿/影片
        if (data.isGroup && Array.isArray(data.items)) {
          const mediaGroupPayload = data.items.map((item, index) => ({
            type: item.type,
            media: item.fileId,
            caption: index === 0 ? privateCaption : '',
            protect_content: true
          }));

          sentMessages = await bot.sendMediaGroup(chatId, mediaGroupPayload);
        } 
        // 2. 如果是單張圖片/影片
        else {
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

        // 定時自動銷毀所有私聊媒體訊息
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
