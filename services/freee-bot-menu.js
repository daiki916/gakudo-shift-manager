const fs = require('fs');
const path = require('path');
const { lineworksApiRequest, uploadFileToUrl } = require('./lineworks-auth');

const MENU_VERSION = '20260310-v1';
const MENU_NAME_PREFIX = 'freee-bot-main-menu-';
const MENU_NAME = `${MENU_NAME_PREFIX}${MENU_VERSION}`;
const MENU_IMAGE_WIDTH = 2500;
const MENU_IMAGE_HEIGHT = 1686;
const MENU_TOP_OFFSET = 210;
const MENU_TILE_MARGIN_X = 34;
const MENU_TILE_MARGIN_Y = 28;
const MENU_ROW_HEIGHT = 743;
const MENU_TILE_HEIGHT = MENU_ROW_HEIGHT - (MENU_TILE_MARGIN_Y * 2);

const MENU_COMMANDS = [
    {
        key: 'daily_report',
        title: '前日レポート',
        subtitle: '昨日の打刻を確認',
        commandText: '前日レポート',
        postback: 'menu:daily_report',
    },
    {
        key: 'today_attendance',
        title: '今日の勤怠',
        subtitle: '今日の打刻を見る',
        commandText: '今日の勤怠',
        postback: 'menu:today_attendance',
    },
    {
        key: 'clock_in_help',
        title: '出勤修正',
        subtitle: '出勤の直し方',
        commandText: '出勤修正',
        postback: 'menu:clock_in_help',
    },
    {
        key: 'clock_out_help',
        title: '退勤修正',
        subtitle: '退勤の直し方',
        commandText: '退勤修正',
        postback: 'menu:clock_out_help',
    },
    {
        key: 'break_help',
        title: '休憩修正',
        subtitle: '休憩の直し方',
        commandText: '休憩修正',
        postback: 'menu:break_help',
    },
    {
        key: 'help',
        title: 'ヘルプ',
        subtitle: '使い方を見る',
        commandText: 'ヘルプ',
        postback: 'menu:help',
    },
];

function getManagedMenuNamePrefix() {
    return MENU_NAME_PREFIX;
}

function getDefaultImagePath() {
    return path.join(__dirname, '..', 'assets', 'freee-bot-richmenu.png');
}

function buildRichMenuAreas() {
    const columnWidths = [834, 833, 833];
    const areas = [];
    let index = 0;

    for (let row = 0; row < 2; row += 1) {
        let x = 0;
        for (const width of columnWidths) {
            const command = MENU_COMMANDS[index];
            areas.push({
                bounds: {
                    x: x + MENU_TILE_MARGIN_X,
                    y: MENU_TOP_OFFSET + (row * MENU_ROW_HEIGHT) + MENU_TILE_MARGIN_Y,
                    width: width - (MENU_TILE_MARGIN_X * 2),
                    height: MENU_TILE_HEIGHT,
                },
                action: {
                    type: 'message',
                    label: command.title,
                    text: command.commandText,
                    displayText: command.commandText,
                    postback: command.postback,
                },
            });
            x += width;
            index += 1;
        }
    }

    return areas;
}

function buildRichMenuDefinition() {
    return {
        richmenuName: MENU_NAME,
        size: {
            width: MENU_IMAGE_WIDTH,
            height: MENU_IMAGE_HEIGHT,
        },
        areas: buildRichMenuAreas(),
    };
}

function getMimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.png') {
        return 'image/png';
    }
    if (extension === '.jpg' || extension === '.jpeg') {
        return 'image/jpeg';
    }

    throw new Error(`Unsupported rich menu image format: ${extension}`);
}

async function listRichMenus(botId) {
    const menus = [];
    let cursor = null;

    do {
        const query = new URLSearchParams({ limit: '50' });
        if (cursor) {
            query.set('cursor', cursor);
        }

        const response = await lineworksApiRequest('GET', `/v1.0/bots/${botId}/richmenus?${query.toString()}`);
        menus.push(...(response.richmenus || []));
        cursor = response.responseMetaData?.nextCursor || response.nextCursor || null;
    } while (cursor);

    return menus;
}

async function getPersistentMenu(botId) {
    return lineworksApiRequest('GET', `/v1.0/bots/${botId}/persistentmenu`);
}

async function deletePersistentMenu(botId) {
    return lineworksApiRequest('DELETE', `/v1.0/bots/${botId}/persistentmenu`);
}

async function getDefaultRichMenu(botId) {
    try {
        return await lineworksApiRequest('GET', `/v1.0/bots/${botId}/richmenus/default`);
    } catch (error) {
        if (error.statusCode === 404) {
            return null;
        }
        throw error;
    }
}

async function deleteDefaultRichMenu(botId) {
    try {
        await lineworksApiRequest('DELETE', `/v1.0/bots/${botId}/richmenus/default`);
    } catch (error) {
        if (error.statusCode !== 404) {
            throw error;
        }
    }
}

async function deleteRichMenu(botId, richmenuId) {
    return lineworksApiRequest('DELETE', `/v1.0/bots/${botId}/richmenus/${richmenuId}`);
}

async function createAttachment(botId, fileName) {
    return lineworksApiRequest('POST', `/v1.0/bots/${botId}/attachments`, { body: { fileName } });
}

async function createRichMenu(botId, richMenuDefinition) {
    return lineworksApiRequest('POST', `/v1.0/bots/${botId}/richmenus`, { body: richMenuDefinition });
}

async function setRichMenuImage(botId, richmenuId, fileId) {
    return lineworksApiRequest('POST', `/v1.0/bots/${botId}/richmenus/${richmenuId}/image`, {
        body: { fileId },
    });
}

async function setDefaultRichMenu(botId, richmenuId) {
    return lineworksApiRequest('POST', `/v1.0/bots/${botId}/richmenus/${richmenuId}/set-default`);
}

function isManagedMenu(menu) {
    return menu?.richmenuName?.startsWith(getManagedMenuNamePrefix());
}

async function syncFreeeBotRichMenu(botId, imagePath = getDefaultImagePath()) {
    if (!botId) {
        throw new Error('FREEE_BOT_ID is not configured.');
    }
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Rich menu image not found: ${imagePath}`);
    }

    const existingPersistentMenu = await getPersistentMenu(botId);
    const existingRichMenus = await listRichMenus(botId);
    const managedRichMenus = existingRichMenus.filter(isManagedMenu);
    const defaultRichMenu = await getDefaultRichMenu(botId);

    if (Array.isArray(existingPersistentMenu.content?.actions) && existingPersistentMenu.content.actions.length > 0) {
        await deletePersistentMenu(botId);
    }

    if (defaultRichMenu?.defaultRichmenuId && managedRichMenus.some(menu => menu.richmenuId === defaultRichMenu.defaultRichmenuId)) {
        await deleteDefaultRichMenu(botId);
    }

    for (const menu of managedRichMenus) {
        await deleteRichMenu(botId, menu.richmenuId);
    }

    const fileName = path.basename(imagePath);
    const fileBuffer = fs.readFileSync(imagePath);
    const uploadMeta = await createAttachment(botId, fileName);
    await uploadFileToUrl(uploadMeta.uploadUrl, fileBuffer, fileName, getMimeType(imagePath));

    const richMenu = await createRichMenu(botId, buildRichMenuDefinition());
    await setRichMenuImage(botId, richMenu.richmenuId, uploadMeta.fileId);
    await setDefaultRichMenu(botId, richMenu.richmenuId);

    return {
        botId,
        richmenuId: richMenu.richmenuId,
        richmenuName: MENU_NAME,
        imagePath,
        replacedManagedRichMenus: managedRichMenus.map(menu => menu.richmenuId),
        removedPersistentMenu: Array.isArray(existingPersistentMenu.content?.actions) && existingPersistentMenu.content.actions.length > 0,
        previousDefaultRichmenuId: defaultRichMenu?.defaultRichmenuId || null,
    };
}

module.exports = {
    MENU_COMMANDS,
    MENU_IMAGE_HEIGHT,
    MENU_IMAGE_WIDTH,
    buildRichMenuDefinition,
    getDefaultImagePath,
    getManagedMenuNamePrefix,
    listRichMenus,
    syncFreeeBotRichMenu,
};
