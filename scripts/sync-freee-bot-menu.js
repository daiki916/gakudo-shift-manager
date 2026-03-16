const path = require('path');
const { getDefaultImagePath, syncFreeeBotRichMenu } = require('../services/freee-bot-menu');

async function main() {
    const botId = process.env.FREEE_BOT_ID;
    const imagePath = process.argv[2]
        ? path.resolve(process.argv[2])
        : getDefaultImagePath();

    const result = await syncFreeeBotRichMenu(botId, imagePath);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
