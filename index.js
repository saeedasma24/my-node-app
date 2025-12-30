const { Telegraf, Markup } = require('telegraf');
const { KokosApiClient } = require("kokos-activator-api");
const axios = require('axios');
const { Pool } = require('pg');

const bot = new Telegraf(process.env.BOT_TOKEN);
const kokos = new KokosApiClient({ token: process.env.KOKOS_TOKEN, environment: "PRODUCTION" });
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const ADMIN_ID = parseInt(process.env.ADMIN_ID);

// قوالب النصوص للغتين
const strings = {
    ar: {
        welcome: "👋 أهلاً بك في game-station-bot\nحالتك: تاجر معتمد ✅",
        no_sub: "🚫 اشتراكك منتهي. يرجى دفع 80$ للتجديد.",
        redeem: "🚀 شحن لاعب",
        add_code: "📥 إضافة أكواد",
        inventory: "📦 مخزني",
        limit_reached: "⚠️ عذراً، وصلت للحد اليومي (300 عملية).",
        enter_id: "🔢 أرسل آيدي اللاعب:",
        success: "✅ تم الشحن بنجاح! اللاعب: "
    },
    en: {
        welcome: "👋 Welcome to game-station-bot\nStatus: Authorized Merchant ✅",
        no_sub: "🚫 Subscription expired. Please pay $80 to renew.",
        redeem: "🚀 Redeem Player",
        add_code: "📥 Add Codes",
        inventory: "📦 My Inventory",
        limit_reached: "⚠️ Sorry, daily limit reached (300/day).",
        enter_id: "🔢 Send Player ID:",
        success: "✅ Successfully Charged! Player: "
    }
};

// وظيفة التحقق من التاجر
async function checkMerchant(ctx) {
    const res = await db.query('SELECT * FROM merchants WHERE telegram_id = $1 AND subscription_expiry > CURRENT_TIMESTAMP', [ctx.from.id]);
    if (res.rows.length > 0 || ctx.from.id === ADMIN_ID) return res.rows[0];
    return null;
}

bot.start(async (ctx) => {
    const merchant = await checkMerchant(ctx);
    if (!merchant && ctx.from.id !== ADMIN_ID) return ctx.reply(strings.ar.no_sub);

    const lang = merchant?.language || 'ar';
    return ctx.reply(strings[lang].welcome, Markup.inlineKeyboard([
        [Markup.button.callback(strings[lang].redeem, "start_redeem")],
        [Markup.button.callback(strings[lang].add_code, "menu_add")],
        [Markup.button.callback(strings[lang].inventory, "view_inv")]
    ]));
});

// نظام الشحن - الفحص ثم التنفيذ
bot.action("start_redeem", async (ctx) => {
    const merchant = await checkMerchant(ctx);
    const lang = merchant?.language || 'ar';
    ctx.reply(strings[lang].enter_id);
});

bot.on('text', async (ctx) => {
    const merchant = await checkMerchant(ctx);
    if (!merchant) return;
    const lang = merchant.language || 'ar';

    // 1. فحص إذا كان النص هو آيدي لاعب
    if (/^\d{5,15}$/.test(ctx.message.text)) {
        if (merchant.daily_requests_count >= 300) return ctx.reply(strings[lang].limit_reached);

        try {
            // استخدام API لـ Game4Station للفحص فقط
            const res = await axios.get(`https://api.game4station.com/client/api/checkName?game=pubgm&userId=${ctx.message.text}`, {
                headers: { 'api-token': process.env.G4S_TOKEN }
            });
            
            if (res.data?.status === 'OK') {
                const name = res.data.data.name;
                return ctx.reply(`👤 ${name}\nChoose amount:`, Markup.inlineKeyboard([
                    [Markup.button.callback("60 UC", `redeem_${ctx.message.text}_60`)],
                    [Markup.button.callback("325 UC", `redeem_${ctx.message.text}_325`)]
                ]));
            }
        } catch (e) { ctx.reply("❌ Error Finding Player"); }
    }
    
    // 2. إضافة أكواد (تنسيق: كود,فئة)
    if (ctx.message.text.includes(',')) {
        const [code, amount] = ctx.message.text.split(',');
        await db.query('INSERT INTO codes_inventory (merchant_id, code_value, denomination) VALUES ($1, $2, $3)', [merchant.id, code.trim(), parseInt(amount)]);
        ctx.reply("✅ Code added to your private vault!");
    }
});

// تنفيذ الشحن المباشر دون إظهار بيانات الحساب
bot.action(/redeem_(.+)_(.+)/, async (ctx) => {
    const [_, pid, amt] = ctx.match;
    const merchant = await checkMerchant(ctx);
    
    // سحب كود من مخزن التاجر حصراً
    const codeObj = await db.query('SELECT * FROM codes_inventory WHERE merchant_id = $1 AND denomination = $2 AND is_used = false LIMIT 1', [merchant.id, amt]);
    
    if (!codeObj.rows[0]) return ctx.reply("❌ Your inventory is empty!");

    try {
        await kokos.redeem.redeemCode({
            playerId: pid,
            codeOverride: codeObj.rows[0].code_value,
            requireReceipt: false // حجب بيانات الحسابات والإيميلات
        });

        await db.query('UPDATE codes_inventory SET is_used = true WHERE id = $1', [codeObj.rows[0].id]);
        await db.query('UPDATE merchants SET daily_requests_count = daily_requests_count + 1 WHERE id = $1', [merchant.id]);
        
        ctx.reply(strings[merchant.language].success + pid);
    } catch (err) {
        ctx.reply("❌ Activation Error: " + (err.body?.errorCode || "Unknown")); // معالجة الأخطاء
    }
});

bot.launch();
