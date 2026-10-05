const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

// 💡 變數設定（也可以直接在 Vercel Environment Variables 設定）
const BACKUP_CHANNEL_ID = process.env.BACKUP_CHANNEL_ID || '-100XXXXX'; // 填入你第二步拿到的私人頻道ID
const MAIN_GROUP_URL = process.env.MAIN_GROUP_URL || 'https://t.me/your_group_link'; // 主討論群連結
const BACKUP_CHANNEL_URL = process.env.BACKUP_CHANNEL_URL || 'https://t.me/your_channel_link'; // 私人頻道邀請連結

const bot = new TelegramBot(token);

// 記憶體儲存 (支援 photo 與 video)
const mediaStore = global.mediaStore || new Map();
global.mediaStore = mediaStore;

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

    // 判斷是否為「圖片」或「影片」
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

      // 1. 同步備份至私人頻道/群組
      if (BACKUP_CHANNEL_ID) {
        try {
          if (type === 'photo') {
            await bot.sendPhoto(BACKUP_CHANNEL_ID, fileId, {
              caption: caption ? `${caption}\n👉 備份照片` : '👉 備份照片',
              parse_mode: 'Markdown'
            });
          } else if (type === 'video') {
            await bot.sendVideo(BACKUP_CHANNEL_ID, fileId, {
              caption: caption ? `${caption}\n👉 備份影片` : '👉 備份影片',
              parse_mode: 'Markdown'
            });
          }
        } catch (e) {
          console.error('轉發私人頻道失敗，請確認 Bot 已加為管理員:', e.message);
        }
      }

      // 2. 刪除原群組多媒體訊息
      await bot.deleteMessage(chatId, messageId);

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${mediaToken}`;

      // 3. 組合提示訊息與按鈕
      let responseText = `📸 **【媒體保護機制】**\n檢視圖片或影片請點擊下方按鈕：\n`;
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
                { text: '👁️ 私睇...', url: startUrl },
                { text: '💬 入谷', url: MAIN_GROUP_URL },
                { text: '🍔 谷睇...', url: BACKUP_CHANNEL_URL }
              ]
            ]
          }
        }
      );
    }

    // 處理私聊 /start 解鎖點閱
    if (msg && msg.text && msg.text.startsWith('/start ')) {
      const chatId = msg.chat.id;
      const mediaToken = msg.text.split(' ')[1];

      const item = mediaStore.get(mediaToken);

      if (!item) {
        await bot.sendMessage(chatId, '❌ 該檔案已過期或已被清理。');
      } else {
        const privateCaption = `🔒 內容將在 ${DELETE_DELAY_SECONDS} 秒後自動銷毀！`;
        let sentMsg;

        if (item.type === 'photo') {
          sentMsg = await bot.sendPhoto(chatId, item.fileId, {
            caption: privateCaption,
            protect_content: true,
            has_spoiler: true
          });
        } else if (item.type === 'video') {
          sentMsg = await bot.sendVideo(chatId, item.fileId, {
            caption: privateCaption,
            protect_content: true
          });
        }

        // 定時自動銷毀
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
