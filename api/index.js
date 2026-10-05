const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN || '8894128453:AAHqR_BaE_WN00CKugjh_hqg79dbX_B5iKY';
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

// 💡 1. 你的私人頻道 ID
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-1004320576547'; 

// 💡 2. 申請入谷連結
const APPLY_GROUP_URL = process.env.APPLY_GROUP_URL || 'https://t.me/+rz1gdgLB7dtlYWE1'; 

// 💡 3. 私人頻道通用邀請連結 (請替換為你的頻道邀請碼)
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
      const caption = msg.caption || ''; // 讀取附帶文字

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

      let channelMsgLink = BACKUP_CHANNEL_URL;

      // 1. 同步備份至私人頻道，並取得專屬貼文跳轉連結
      if (BACKUP_CHANNEL_ID) {
        try {
          let backupMsg;
          if (type === 'photo') {
            backupMsg = await bot.sendPhoto(BACKUP_CHANNEL_ID, fileId, {
              caption: caption ? `${caption}\n\n👉 歸檔備份` : '👉 歸檔備份',
              parse_mode: 'Markdown'
            });
          } else if (type === 'video') {
            backupMsg = await bot.sendVideo(BACKUP_CHANNEL_ID, fileId, {
              caption: caption ? `${caption}\n\n👉 歸檔備份` : '👉 歸檔備份',
              parse_mode: 'Markdown'
            });
          }

          if (backupMsg && backupMsg.message_id) {
            channelMsgLink = getChannelMessageLink(BACKUP_CHANNEL_ID, backupMsg.message_id);
          }
        } catch (e) {
          console.error('轉發私人頻道失敗 (請確認 Bot 已設為頻道管理員):', e.message);
        }
      }

      // 2. 刪除原群組多媒體訊息
      await bot.deleteMessage(chatId, messageId);

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

      // 3. 組合三按鈕提示訊息
      let responseText = `📸 **【美食相片收集器】**\n睇相睇片請按下面按鍵：\n`;
      if (caption) {
        responseText += `\n${caption}`;
      }

      await bot.sendMessage(
        chatId,
        responseText,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '👁️ 私睇', url: startUrl },
                { text: '💬 入谷', url: APPLY_GROUP_URL },
                { text: '🍔 谷睇...', url: channelMsgLink }
              ]
            ]
          }
        }
      );
    }

    // 處理私聊 /start (即時直接跳出圖/影片)
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const mediaToken = msg.text.split(' ')[1];

      const item = mediaStore.get(mediaToken);

      if (!item) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
      } else {
        const privateCaption = `🔒 內容將在 ${DELETE_DELAY_SECONDS} 秒後自動銷毀！禁止轉發與截圖。`;
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
