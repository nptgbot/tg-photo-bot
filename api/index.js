const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN || '8894128453:AAHqR_BaE_WN00CKugjh_hqg79dbX_B5iKY';
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

// 💡 1. 你的私人頻道 ID
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-1004320576547'; 

// 💡 2. 申請入谷連結
const APPLY_GROUP_URL = process.env.APPLY_GROUP_URL || 'https://t.me/+rz1gdgLB7dtlYWE1'; 

// 💡 3. 私人頻道通用邀請連結
const BACKUP_CHANNEL_URL = process.env.BACKUP_CHANNEL_URL || 'https://t.me/+your_channel_invite_link'; 

const bot = new TelegramBot(token);

// 全域記憶體儲存 (支援 photo 與 video)
const mediaStore = global.mediaStore || new Map();
global.mediaStore = mediaStore;

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

      // 1. 抓取發送者資訊
      const sender = msg.from;
      const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || '未知用戶';
      const senderUsername = sender.username ? `@${sender.username}` : '無用戶名';
      const sendTime = formatTimestamp(msg.date);

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
      mediaStore.set(mediaToken, { fileId, type });

      // 2. 動態組合資訊（如果沒有 caption 就不會產生 💬 附加說明 這行）
      const detailInfoLines = [
        `👤 **P**：${senderName} (${senderUsername})`,
        `⏰ **T**：${sendTime}`
      ];

      if (caption.trim()) {
        detailInfoLines.push(`💬 **C**：${caption.trim()}`);
      }

      const detailInfo = detailInfoLines.join('\n');

      let channelMsgLink = BACKUP_CHANNEL_URL;

      // 3. 同步備份至私人頻道（附帶動態詳細資料，不顯示收集器標頭）
      if (BACKUP_CHANNEL_ID) {
        try {
          const channelCaption = detailInfo;
          let backupMsg;

          if (type === 'photo') {
            backupMsg = await bot.sendPhoto(BACKUP_CHANNEL_ID, fileId, {
              caption: channelCaption,
              parse_mode: 'Markdown'
            });
          } else if (type === 'video') {
            backupMsg = await bot.sendVideo(BACKUP_CHANNEL_ID, fileId, {
              caption: channelCaption,
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

      // 4. 刪除原群組多媒體訊息
      await bot.deleteMessage(chatId, messageId);

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

      // 5. 組合群組內的提示訊息（已移除美食相片收集器標頭）
      const groupResponseText = `${detailInfo}`;

      await bot.sendMessage(
        chatId,
        groupResponseText,
        {
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
        }
      );
    }

    // 處理私聊 /start (即時跳出圖片/影片)
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const mediaToken = msg.text.split(' ')[1];

      const item = mediaStore.get(mediaToken);

      if (!item) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
      } else {
        const privateCaption = `🔒 ${DELETE_DELAY_SECONDS} 秒後自銷毀！`;
        let sentMsg;

        if (item.type === 'photo') {
          sentMsg = await bot.sendPhoto(chatId, item.fileId, {
            caption: privateCaption,
            protect_content: true
          });
        } else if (item.type === 'video') {
          sentMsg = await bot.sendVideo(chatId, item.fileId, {
            caption: privateCaption,
            protect_content: true
          });
        }

        // 定時自動銷毀私聊訊息
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMsg.message_id);
          } catch (e) {}
        }, DELETE_DELAY_SECONDS * 1000);
      }
    }
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }

  return res.status(200).send('OK');
};
