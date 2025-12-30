const { Telegraf, Markup } = require('telegraf');
const { KokosApiClient } = require("kokos-activator-api");
const axios = require('axios');
const { Pool } = require('pg');
const http = require('http');

// الإعدادات من Environment Variables
const bot = new Telegraf(process.env.BOT_TOKEN);
const kokos = new KokosApiClient({ token: process.env.KOKOS_TOKEN, environment: "PRODUCTION" });
const db = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    try {
        const merchant = await db.query('SELECT * FROM merchants WHERE telegram_id = $1 AND is_active = true', [userId]);
        if (userId === ADMIN_ID || merchant.rows.length > 0) {
            return ctx.reply("👋 أهلاً بك في نظام الشحن الخاص بك:", 
                Markup.inlineKeyboard([[Markup.button.callback("🚀 شحن لاعب", "start_redeem")]])
            );
        }
        return ctx.reply("🚫 عذراً، أنت غير مسجل كتاجر.");
    } catch (err) {
        console.error(err);
        ctx.reply("⚠️ خطأ في الاتصال بقاعدة البيانات.");
    }
});

bot.action("start_redeem", (ctx) => ctx.reply("🔢 أرسل آيدي اللاعب (PUBG ID):"));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (/^\d+$/.test(text)) {
        const loadingMsg = await ctx.reply("🔍 جاري الفحص...");
        try {
            const url = `https://api.game4station.com/client/api/checkName?game=pubgm&userId=${text}&serverId=`;
            const res = await axios.get(url, { 
                headers: { 'Authorization': `Bearer ${process.env.G4S_TOKEN}` },
                timeout: 10000 
            });

            if (res.data && res.data.userName) {
                await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
                return ctx.reply(`👤 اسم اللاعب: ${res.data.userName}\n\nاختر كمية الشحن:`, 
                    Markup.inlineKeyboard([
                        [Markup.button.callback("60 UC", `confirm_${text}_60`)],
                        [Markup.button.callback("325 UC", `confirm_${text}_325`)]
                    ])
                );
            } else {
                return ctx.reply("❌ لم يتم العثور على اسم لهذا الآيدي. تأكد من الرقم.");
            }
        } catch (e) {
            console.error("API Error:", e.response?.data || e.message);
            const errorStatus = e.response?.status;
            if (errorStatus === 401) return ctx.reply("⚠️ خطأ: توكن Game4Station غير صحيح.");
            ctx.reply(`⚠️ فشل الفحص: ${e.response?.data?.message || "مشكلة في سيرفر الفحص"}`);
        }
    }
});

bot.action(/confirm_(.+)_(.+)/, async (ctx) => {
    const playerId = ctx.match[1];
    const amount = parseInt(ctx.match[2]);

    try {
        const codeData = await db.query('SELECT * FROM codes_inventory WHERE is_used = false AND denomination = $1 LIMIT 1', [amount]);
        
        if (!codeData.rows[0]) {
            return ctx.reply(`❌ لا توجد أكواد متوفرة لفئة ${amount} UC في المخزن حالياً.`);
        }

        const result = await kokos.redeem.redeemCode({
            playerId: playerId,
            codeOverride: codeData.rows[0].code_value,
            denomination: amount
        });

        await db.query('UPDATE codes_inventory SET is_used = true WHERE id = $1', [codeData.rows[0].id]);
        ctx.reply(`✅ تم الشحن بنجاح!\n👤 اللاعب: ${result.name || playerId}\n📦 الفئة: ${amount} UC`);
        
    } catch (error) {
        console.error("Redeem Error:", error);
        ctx.reply(`❌ فشل الشحن: ${error.body?.message || "خطأ داخلي"}`);
    }
});

// تشغيل البوت وخداع ريندر بفتح بورت
bot.launch().then(() => console.log("Bot Live!"));
http.createServer((req, res) => { res.write('OK'); res.end(); }).listen(process.env.PORT || 3000);
