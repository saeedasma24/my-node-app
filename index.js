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

// دالة التحقق من اشتراك وصلاحية التاجر
async function getMerchant(userId) {
    const res = await db.query(
        `SELECT * FROM merchants 
         WHERE telegram_id = $1 
         AND is_active = true 
         AND subscription_expiry > CURRENT_TIMESTAMP`, 
        [userId]
    );
    return res.rows[0];
}

bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const merchant = await getMerchant(userId);

    if (userId === ADMIN_ID || merchant) {
        return ctx.reply("🌐 اختر اللغة / Choose Language:", 
            Markup.inlineKeyboard([
                [Markup.button.callback("العربية 🇸🇦", "lang_ar"), Markup.button.callback("English 🇺🇸", "lang_en")]
            ])
        );
    }
    return ctx.reply("🚫 اشتراكك غير مفعل أو منتهي. يرجى التواصل مع الإدارة.\nYour subscription is inactive or expired.");
});

// التعامل مع اختيار اللغة (مثال للعربية)
bot.action("lang_ar", (ctx) => {
    ctx.reply("مرحباً بك في لوحة التحكم:", 
        Markup.inlineKeyboard([
            [Markup.button.callback("🚀 شحن لاعب", "start_redeem")],
            [Markup.button.callback("📦 إضافة أكواد لمخزني", "add_codes")],
            [Markup.button.callback("📊 إحصائياتي", "my_stats")]
        ])
    );
});

bot.action("start_redeem", (ctx) => ctx.reply("🔢 أرسل آيدي اللاعب (PUBG ID):"));

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    const merchant = await getMerchant(userId);

    if (!merchant && userId !== ADMIN_ID) return ctx.reply("❌ غير مسموح لك بالوصول.");

    if (/^\d+$/.test(text)) {
        // فحص الكوتا اليومية للتاجر (حد 300 عملية)
        if (merchant.daily_requests_count >= 300) {
            return ctx.reply("⚠️ عذراً، لقد استهلكت حدك اليومي (300 عملية). يتجدد الحد كل 24 ساعة.");
        }

        const loadingMsg = await ctx.reply("🔍 جاري فحص اللاعب...");
        try {
            const url = `https://api.game4station.com/client/api/checkName?game=pubgm&userId=${text}&serverId=`;
            const res = await axios.get(url, { headers: { 'api-token': process.env.G4S_TOKEN } });

            if (res.data && res.data.status === 'OK' && res.data.data.name) {
                const playerName = res.data.data.name;
                await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
                
                return ctx.reply(`👤 اللاعب: ${playerName}\nاختر الكمية:`, 
                    Markup.inlineKeyboard([
                        [Markup.button.callback("60 UC", `confirm_${text}_60`)],
                        [Markup.button.callback("325 UC", `confirm_${text}_325`)]
                    ])
                );
            }
        } catch (e) {
            ctx.reply("❌ فشل التحقق من الآيدي.");
        }
    }
});

bot.action(/confirm_(.+)_(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const playerId = ctx.match[1];
    const amount = parseInt(ctx.match[2]);
    const merchant = await getMerchant(userId);

    try {
        // سحب كود من "مخزن التاجر نفسه" فقط
        const codeData = await db.query(
            'SELECT * FROM codes_inventory WHERE merchant_id = $1 AND is_used = false AND denomination = $2 LIMIT 1', 
            [merchant.id, amount]
        );
        
        if (!codeData.rows[0]) {
            return ctx.reply(`❌ مخزنك فارغ من فئة ${amount} UC. قم بإضافة أكواد أولاً.`);
        }

        // تنفيذ الشحن عبر Kokos API
        const result = await kokos.redeem.redeemCode({
            playerId: playerId,
            codeOverride: codeData.rows[0].code_value,
            denomination: amount
        });

        // تحديث قاعدة البيانات: وسم الكود كمستخدم + زيادة عداد التاجر
        await db.query('UPDATE codes_inventory SET is_used = true WHERE id = $1', [codeData.rows[0].id]);
        await db.query('UPDATE merchants SET daily_requests_count = daily_requests_count + 1 WHERE id = $1', [merchant.id]);

        ctx.reply(`✅ تم الشحن بنجاح!\n👤 اللاعب: ${result.name}\n📦 الفئة: ${amount} UC`);
        
    } catch (error) {
        ctx.reply(`❌ فشل الشحن: ${error.body?.errorCode || "خطأ غير معروف"}`);
    }
});

bot.launch();
http.createServer((req, res) => { res.end('OK'); }).listen(process.env.PORT || 3000);
