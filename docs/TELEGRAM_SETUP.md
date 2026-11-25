# Telegram Bot Setup Guide

## 🔐 Security Alert

**⚠️ IMPORTANT**: Your bot token has been saved in `.env` but **you should revoke it immediately** since it was shared in a conversation.

### Revoke Current Token
1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Send `/revoke`
3. Select your bot
4. Confirm revocation
5. Send `/token` to generate a new token
6. Update `.env` file with the new token

## 🤖 Bot Configuration

Your bot token is stored in `.env`:
```
TELEGRAM_BOT_TOKEN=<BOT_TOKEN_REDACTED>
```

**After revoking**, update it with your new token:
```bash
# Edit .env file
TELEGRAM_BOT_TOKEN=your_new_token_here
```

## 🚀 Setup Steps

### Step 1: Configure Bot with BotFather

1. **Set Bot Commands** (Optional but recommended)
```
Message @BotFather:
/mybots → Select your bot → Edit Bot → Edit Commands

Add these commands:
start - Start shopping
shop - Browse products
cart - View shopping cart
profile - My profile and orders
referral - Get referral code
help - Get help
```

2. **Set Bot Description**
```
/mybots → Select your bot → Edit Bot → Edit Description

Add:
🏠 Welcome to Ailem - Your Home Textiles Store!

Shop for premium quality:
• Bedsheets
• Pillows
• Curtains
• Towels

✨ Earn bonus points
👥 Refer friends and get rewards
🎁 Special discounts available

Start shopping now!
```

3. **Set Bot About**
```
/mybots → Select your bot → Edit Bot → Edit About

Add:
Premium home textiles store with bonus points and referral rewards.
```

4. **Set Bot Picture**
- Upload a 512x512px image representing your store
- Can be your logo or a product image

### Step 2: Deploy Your App

Choose a deployment platform (see [DEPLOYMENT.md](DEPLOYMENT.md)):

**Quick Deploy with Vercel:**
```bash
npm install -g vercel
npm run build
vercel --prod
```

You'll get a URL like: `https://your-app.vercel.app`

### Step 3: Create Mini App

1. Message @BotFather: `/newapp`
2. Select your bot
3. Provide app details:

   **Title**: Ailem Store

   **Short Name**: ailemstore (lowercase, no spaces)

   **Description**:
   ```
   Shop for premium home textiles - bedsheets, pillows, curtains, and towels.
   Earn bonus points with every purchase and get rewards through our referral program.
   ```

   **Photo**: Upload app icon (640x360px recommended)

   **Demo GIF** (optional): Upload a short demo video/gif

   **Web App URL**: `https://your-app.vercel.app`

4. BotFather will give you a link to your Mini App

### Step 4: Configure Bot Menu Button

```
Message @BotFather:
/mybots → Select your bot → Bot Settings → Menu Button

Choose: Edit menu button URL

Enter: https://your-app.vercel.app
```

### Step 5: Test Your Mini App

1. **Open your bot in Telegram**
2. **Click the menu button** (≡ icon at bottom)
3. **Your app should open** inside Telegram!

## 🎯 Features Available

### Telegram Integration Features

Your app now includes:

✅ **Auto-detect Telegram environment**
- Shows different UI when in Telegram vs browser

✅ **Telegram user data**
- Automatically gets user's name from Telegram
- No signup required!

✅ **Referral system**
- Share link: `https://t.me/your_bot?start=ref_REFERRALCODE`
- Auto-detects referral codes
- Awards bonus points

✅ **Haptic feedback**
- Button clicks feel natural on mobile

✅ **Theme support**
- Adapts to Telegram's theme (light/dark)

✅ **Native dialogs**
- Uses Telegram's native confirm/alert dialogs

## 📱 Using the Telegram API

The app includes utilities in `src/utils/telegram.js`:

```javascript
import {
  getTelegramUser,      // Get user data
  isInTelegram,         // Check if in Telegram
  hapticFeedback,       // Vibration feedback
  showMainButton,       // Show Telegram's main button
  showBackButton,       // Show back button
  getTelegramTheme      // Get theme colors
} from './utils/telegram';

// Example: Get Telegram user
const user = getTelegramUser();
if (user) {
  console.log(user.firstName, user.username);
}

// Example: Haptic feedback on button click
<button onClick={() => {
  hapticFeedback('success');
  // ... your code
}}>
  Add to Cart
</button>
```

## 🔗 Sharing & Deep Links

### Share Your Store
Users can share:
```
https://t.me/your_bot_username
```

### Referral Links
Format:
```
https://t.me/your_bot_username?start=ref_USERCODE
```

Example with your user's referral code:
```javascript
const referralLink = `https://t.me/your_bot_username?start=ref_${user.referralCode}`;
```

### Share Product Links
You can create deep links for products:
```
https://t.me/your_bot_username?start=product_123
```

Then in your app, handle it:
```javascript
const startParam = getStartParam();
if (startParam?.startsWith('product_')) {
  const productId = startParam.replace('product_', '');
  navigate('product', { productId });
}
```

## 🎨 Telegram Theme Integration

Your app automatically adapts to Telegram's theme:

```javascript
const theme = getTelegramTheme();
// Use theme.bgColor, theme.textColor, etc.
```

## 📊 Testing Checklist

Test these features in Telegram:

- [ ] Open bot and click menu button
- [ ] App loads correctly inside Telegram
- [ ] Browse products
- [ ] Add items to cart
- [ ] Complete checkout
- [ ] Test referral link
- [ ] Check if user name appears automatically
- [ ] Test on both iOS and Android
- [ ] Test in light and dark theme
- [ ] Test haptic feedback

## 🔧 Troubleshooting

### App Doesn't Open in Telegram

**Check:**
1. Web App URL is HTTPS (not HTTP)
2. URL is accessible from outside
3. Bot token is valid
4. Mini App is created in BotFather

### User Data Not Loading

**Check:**
1. Telegram script loads: `window.Telegram.WebApp`
2. Open browser console and check logs
3. Make sure you're testing in Telegram, not browser

### Referral Links Not Working

**Format must be:**
```
https://t.me/bot_username?start=ref_CODE
```

**Check:**
1. Bot username is correct
2. Start parameter format is correct
3. Code in `getReferralCode()` function

## 📝 Local Testing with ngrok

To test locally before deploying:

```bash
# Install ngrok
npm install -g ngrok

# In terminal 1: Run your app
npm run dev

# In terminal 2: Create tunnel
ngrok http 3000

# Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
# Set this as your Mini App URL in BotFather
```

Then open your bot in Telegram to test!

## 🎁 Bonus: Bot Commands Handler

You can create a simple Node.js bot to handle commands:

```javascript
// bot.js
const TelegramBot = require('node-telegram-bot-api');

const token = 'YOUR_BOT_TOKEN';
const bot = new TelegramBot(token, { polling: true });
const webAppUrl = 'https://your-app.vercel.app';

bot.onText(/\/start(.*)/, (msg, match) => {
  const chatId = msg.chat.id;
  const startParam = match[1].trim();

  if (startParam.startsWith('ref_')) {
    const refCode = startParam.replace('ref_', '');
    bot.sendMessage(chatId,
      `🎁 Welcome! You used referral code: ${refCode}\n\nYou'll get 10% off your first order!`,
      {
        reply_markup: {
          inline_keyboard: [[{
            text: '🛍️ Start Shopping',
            web_app: { url: webAppUrl + '?start=' + startParam }
          }]]
        }
      }
    );
  } else {
    bot.sendMessage(chatId,
      '🏠 Welcome to Ailem - Home Textiles Store!\n\n' +
      'Shop for premium quality bedsheets, pillows, curtains, and towels.\n\n' +
      '✨ Earn bonus points with every purchase\n' +
      '👥 Refer friends and get rewards',
      {
        reply_markup: {
          keyboard: [[{
            text: '🛍️ Open Store',
            web_app: { url: webAppUrl }
          }]],
          resize_keyboard: true
        }
      }
    );
  }
});

bot.on('message', (msg) => {
  console.log('Message received:', msg.text);
});

console.log('Bot is running...');
```

Install and run:
```bash
npm install node-telegram-bot-api
node bot.js
```

## 📚 Resources

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram Mini Apps](https://core.telegram.org/bots/webapps)
- [BotFather Commands](https://core.telegram.org/bots#6-botfather)
- [Deep Linking](https://core.telegram.org/bots#deep-linking)

## ✅ Next Steps

1. ✅ Revoke and regenerate bot token
2. ✅ Deploy your app (Vercel recommended)
3. ✅ Create Mini App in BotFather
4. ✅ Test in Telegram
5. ⬜ Add bot command handler (optional)
6. ⬜ Customize bot messages
7. ⬜ Launch to users!

## 🎊 You're Ready!

Your Telegram Mini App is fully configured and ready to use. Users can now shop directly inside Telegram!

For questions, check:
- [README.md](README.md) - Main documentation
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide
- Telegram Bot API docs

---

**Happy Telegram Shopping! 🛍️**
