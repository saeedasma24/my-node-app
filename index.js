const { Telegraf, Markup } = require('telegraf');
const { KokosApiClient } = require("kokos-activator-api");
const axios = require('axios');
const { Pool } = require('pg');

// سحب الإعدادات من Render (Environment Variables)
const bot = new Telegraf(process.env.BOT_TOKEN);
const kokos = new KokosApiClient({ token: process.env.KOKOS_TOKEN, environment: "PRODUCTION" });
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// مترجم الأخطاء
function getFriendlyError(apiCode) {
    const errors = {
        'NO_ACCOUNTS_AVAILABLE': "⚠️ النظام مزدحم حالياً.",
        'NO_CODES_AVAILABLE': "❌ مخزنك فارغ.",
        'CHARACTER_NOT_FOUND': "👤 الآيدي غير صحيح."
    };
    return errors[apiCode] || "⚠️ خطأ تقني، حاول لاحقاً.";
}

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const merchant = await db.query('SELECT * FROM merchants WHERE telegram_id = $1 AND is_active = true', [userId]);

    if (userId === ADMIN_ID || merchant.rows.length > 0) {
        return ctx.reply("👋 أهلاً بك في نظام الشحن الخاص بك:", 
            Markup.inlineKeyboard([
                [Markup.button.callback("🚀 شحن لاعب", "start_redeem")]
            ])
        );
    }
    return ctx.reply("🚫 غير مشترك.");
});

bot.action("start_redeem", (ctx) => ctx.reply("أرسل آيدي اللاعب:"));

bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (/^\d+$/.test(text)) {
        try {
            const url = `https://api.game4station.com/client/api/checkName?game=pubgm&userId=${text}&serverId=`;
            const res = await axios.get(url, { 
                headers: { 'Authorization': `Bearer ${process.env.G4S_TOKEN}` } 
            });
            
            if (res.data && res.data.userName) {
                return ctx.reply(`👤 اللاعب: ${res.data.userName}\n\nاختر الفئة:`, 
                    Markup.inlineKeyboard([[Markup.button.callback("60 UC", `confirm_${text}_60`)]]));
            } else {
                return ctx.reply("❌ لم نتمكن من العثور على اسم اللاعب، تأكد من الآيدي.");
            }
        } catch (e) { 
            // سيطبع لك البوت هنا سبب الفشل الحقيقي (هل التوكن خطأ أم الموقع متوقف)
            console.error(e.response?.data);
            ctx.reply(`⚠️ فشل الفحص: ${e.response?.data?.message || "خطأ في الاتصال بالـ API"}`); 
        }
    }
});

bot.action(/confirm_(.+)_(.+)/, async (ctx) => {
    const playerId = ctx.match[1];
    const amount = parseInt(ctx.match[2]);
    const merchantId = ctx.from.id;

    const codeData = await db.query('SELECT * FROM codes_inventory WHERE is_used = false AND denomination = $1 LIMIT 1', [amount]);
    if (!codeData.rows[0]) return ctx.reply("❌ لا توجد أكواد.");

    try {
        const result = await kokos.redeem.redeemCode({
            playerId: playerId,
            codeOverride: codeData.rows[0].code_value,
            denomination: amount
        });
        await db.query('UPDATE codes_inventory SET is_used = true WHERE id = $1', [codeData.rows[0].id]);
        ctx.reply(`✅ تم الشحن بنجاح لـ ${result.name}`);
    } catch (error) {
        ctx.reply(getFriendlyError(error.body?.errorCode));
    }
});

// تشغيل البوت
bot.launch().then(() => {
    console.log("✅ البوت يعمل الآن بنجاح...");
});

// هذا الجزء ضروري جداً لمنصة Render لمنع الخطأ (Status 1)
const http = require('http');
http.createServer((req, res) => {
    res.write('Bot is running');
    res.end();
}).listen(process.env.PORT || 3000);

