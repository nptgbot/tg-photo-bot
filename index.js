const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

// 不開啟 polling，純靠 Webhook 觸發
const bot = new TelegramBot(token);

// 記憶體快取 (注意: Serverless 重啟時會清空，生產環境建議搭配 Redis/KV)
const photoStore = global.photoStore || new Map();
global.photoStore = photoStore;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot Server is Running!');
  }

  const update = req.body;
  if (!update) return res.status(200).send('OK');

  try {
    // 1. 處理群組發送的圖片
    if (update.message && update.message.photo) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const messageId = msg.message_id;

      const photo = msg.photo[msg.photo.length - 1];
      const fileId = photo.file_id;

      const imgToken = Math.random().toString(36).substring(2, 10);
      photoStore.set(imgToken, fileId);

      // 刪除原圖
      await bot.deleteMessage(chatId, messageId);

      const me = await bot.getMe();
      const startUrl = `https://t.me/${me.username}?start=${imgToken}`;

      // 發送按鈕訊息
      await bot.sendMessage(
        chatId,
        '⚠️ **敏感圖片已受保護並自動隱藏**\n點擊下方按鈕私聊 Bot 檢視（預覽後自動銷毀）：',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👁️ 私聊檢視圖片', url: startUrl }]
            ]
          }
        }
      );
    }

    // 2. 處理私聊指令 /start token
    if (update.message && update.message.text && update.message.text.startsWith('/start ')) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const imgToken = msg.text.split(' ')[1];

      const fileId = photoStore.get(imgToken);

      if (!fileId) {
        await bot.sendMessage(chatId, '❌ 該圖片無效或過期。');
      } else {
        const sentMsg = await bot.sendPhoto(chatId, fileId, {
          caption: `🔒 圖片將在 ${DELETE_DELAY_SECONDS} 秒後自動銷毀！`,
          protect_content: true,
          has_spoiler: true
        });

        // 倒數刪除私聊圖片
        setTimeout(async () => {
          try {
            await bot.deleteMessage(chatId, sentMsg.message_id);
          } catch (e) {
            console.error('刪除私聊訊息失敗:', e.message);
          }
        }, DELETE_DELAY_SECONDS * 1000);
      }
    }
  } catch (err) {
    console.error('Webhook 處理錯誤:', err.message);
  }

  res.status(200).send('OK');
};
