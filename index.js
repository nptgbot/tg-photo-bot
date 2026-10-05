const TelegramBot = require('node-telegram-bot-api');

// 從系統環境變數讀取 Token 與銷毀秒數
const token = process.env.BOT_TOKEN;
const DELETE_DELAY_SECONDS = parseInt(process.env.DELETE_DELAY || '15', 10);

if (!token) {
  console.error("錯誤：未設定 BOT_TOKEN 環境變數！");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// 記憶體儲存圖片對應表 (store: token -> file_id)
const photoStore = new Map();

// 1. 監聽群組發送的圖片
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;

  try {
    // 取得最高畫質圖片
    const photo = msg.photo[msg.photo.length - 1];
    const fileId = photo.file_id;

    // 生成隨機短 Token
    const imgToken = Math.random().toString(36).substring(2, 10);
    photoStore.set(imgToken, fileId);

    // 立即刪除群組內的原圖
    await bot.deleteMessage(chatId, messageId);

    // 取得機器人 Username 並建立私聊 Deep Link
    const me = await bot.getMe();
    const startUrl = `https://t.me/${me.username}?start=${imgToken}`;

    // 發送帶有按鈕的 Telegram 訊息
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
  } catch (err) {
    console.error('處理群組圖片時發生錯誤:', err.message);
  }
});

// 2. 監聽私聊指令（當使用者點擊按鈕跳轉至私聊時觸發）
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const imgToken = match[1];

  const fileId = photoStore.get(imgToken);

  if (!fileId) {
    return bot.sendMessage(chatId, '❌ 該圖片無效或過期。');
  }

  try {
    // 發送圖片，並開啟「禁止截圖/轉發 (protect_content)」與「模糊預覽 (has_spoiler)」
    const sentMsg = await bot.sendPhoto(chatId, fileId, {
      caption: `🔒 圖片將在 ${DELETE_DELAY_SECONDS} 秒後自動銷毀！`,
      protect_content: true,
      has_spoiler: true
    });

    // 定時自動刪除私聊圖片訊息
    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, sentMsg.message_id);
      } catch (e) {
        console.error('刪除私聊訊息失敗:', e.message);
      }
    }, DELETE_DELAY_SECONDS * 1000);

  } catch (err) {
    console.error('私聊發送圖片失敗:', err.message);
    bot.sendMessage(chatId, '⚠️ 無法傳送圖片，請確保您已點擊下方 Start 按鈕開啟與 Bot 的對話。');
  }
});

console.log('Bot 服務已成功啟動運作中...');
